import { and, asc, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../index";
import {
  examAnswerLogs,
  examAnswerAssessments,
  examAnswerSubmissions,
  examQuestions,
  examSubmissionAnswers,
  examSubmissionOperations,
  participantResultSettings,
} from "../schema";
import { jstDayStart } from "../../date";
import { gradeFreeResponse, JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION } from "@/lib/jev/adapter";
import { scoreQ5 } from "@/lib/jev/scoring";
import { randomUUID } from "node:crypto";
import { sqliteCauseObjects } from "./sqlite-cause-traversal";

export type BatchAnswer =
  | { questionId: number; selectedIndex: number }
  | { questionId: number; freeText: string };

type RestoredAnswer = {
  questionId: number;
  answerKind: "selected" | "legacy" | "freeText";
  selectedIndex: number | null;
  freeText: string | null;
};

type StoredSubmissionAnswer = {
  questionId: number;
  selectedIndex: number | null;
  freeText: string | null;
  answerKind: string;
};

function restoreSubmissionAnswers(
  questionIds: number[],
  storedAnswers: StoredSubmissionAnswer[],
): RestoredAnswer[] {
  const answerByQuestion = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
  return questionIds.flatMap<RestoredAnswer>((questionId) => {
    const answer = answerByQuestion.get(questionId);
    if (!answer) return [];
    if (answer.answerKind === "freeText")
      return [
        { questionId, answerKind: "freeText", selectedIndex: null, freeText: answer.freeText },
      ];
    return [
      {
        questionId,
        answerKind: answer.answerKind as "selected" | "legacy",
        selectedIndex: answer.selectedIndex,
        freeText: null,
      },
    ];
  });
}

export class BatchSubmissionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503,
    readonly code?: "DATABASE_LOCKED",
  ) {
    super(message);
    this.name = "BatchSubmissionError";
  }
}

export type AnswerSaveRetryPhase = "preflight_read" | "write_transaction" | "recovery_read";

export type AnswerSaveRetryRuntime = {
  random(): number;
  sleep?(ms: number): Promise<void>;
  onRetryScheduled?(event: {
    phase: AnswerSaveRetryPhase;
    retryNumber: number;
    capMs: number;
    delayMs: number;
  }): void;
};

const defaultAnswerSaveRetryRuntime: AnswerSaveRetryRuntime = {
  random: Math.random,
};

const inFlightAnswerSaves = new Map<
  string,
  {
    participantId: number;
    payload: string;
    promise: Promise<{
      submissionId: string;
      revision: number;
      assessmentTarget: { submissionId: string; revision: number } | null;
    }>;
  }
>();

export async function getAnswerSubmission(submissionId: string, participantId: number) {
  return db.transaction(async (tx) => {
    const [submission] = await tx
      .select()
      .from(examAnswerSubmissions)
      .where(eq(examAnswerSubmissions.id, submissionId));
    if (!submission || submission.participantId !== participantId) return null;

    const storedAnswers = await tx
      .select({
        questionId: examSubmissionAnswers.questionId,
        selectedIndex: examSubmissionAnswers.selectedIndex,
        freeText: examSubmissionAnswers.freeText,
        answerKind: examSubmissionAnswers.answerKind,
      })
      .from(examSubmissionAnswers)
      .where(eq(examSubmissionAnswers.submissionId, submissionId));
    const answers = restoreSubmissionAnswers(submission.questionIds, storedAnswers);
    const [settings] = await tx
      .select({ visible: participantResultSettings.visible })
      .from(participantResultSettings)
      .where(eq(participantResultSettings.id, 1));
    return {
      submissionId: submission.id,
      revision: submission.revision,
      answers,
      resultsVisible: settings?.visible ?? false,
    };
  });
}

/** Return the participant's deterministically latest saved answer set. */
export async function getLatestAnswerSubmission(participantId: number) {
  return db.transaction(async (tx) => {
    const [submission] = await tx
      .select()
      .from(examAnswerSubmissions)
      .where(eq(examAnswerSubmissions.participantId, participantId))
      .orderBy(
        desc(examAnswerSubmissions.updatedAt),
        desc(examAnswerSubmissions.revision),
        desc(examAnswerSubmissions.createdAt),
        desc(examAnswerSubmissions.id),
      )
      .limit(1);
    if (!submission) return null;

    const storedAnswers = await tx
      .select({
        questionId: examSubmissionAnswers.questionId,
        selectedIndex: examSubmissionAnswers.selectedIndex,
        freeText: examSubmissionAnswers.freeText,
        answerKind: examSubmissionAnswers.answerKind,
      })
      .from(examSubmissionAnswers)
      .where(eq(examSubmissionAnswers.submissionId, submission.id));
    const answers = restoreSubmissionAnswers(submission.questionIds, storedAnswers);
    return { submissionId: submission.id, revision: submission.revision, answers };
  });
}

/** Coalesce identical requests while their first atomic save is still in flight. */
export function saveAnswerSubmission(
  input: {
    submissionId: string;
    operationId: string;
    expectedRevision: number;
    participantId: number;
    answers: BatchAnswer[];
  },
  retryRuntime: AnswerSaveRetryRuntime = defaultAnswerSaveRetryRuntime,
) {
  const canonicalAnswers = [...input.answers].sort(
    (left, right) => left.questionId - right.questionId,
  );
  const payload = JSON.stringify({
    submissionId: input.submissionId,
    expectedRevision: input.expectedRevision,
    answers: canonicalAnswers,
  });
  const pending = inFlightAnswerSaves.get(input.operationId);
  if (pending?.participantId === input.participantId && pending.payload === payload) {
    return pending.promise.then((result) => ({ ...result, assessmentTarget: null }));
  }

  const promise = saveAnswerSubmissionOnce(input, retryRuntime);
  const entry = { participantId: input.participantId, payload, promise };
  inFlightAnswerSaves.set(input.operationId, entry);
  const clear = () => {
    if (inFlightAnswerSaves.get(input.operationId) === entry) {
      inFlightAnswerSaves.delete(input.operationId);
    }
  };
  void promise.then(clear, clear);
  return promise;
}

/** Save or revise one fixed five-question answer set atomically. */
async function saveAnswerSubmissionOnce(
  input: {
    submissionId: string;
    operationId: string;
    expectedRevision: number;
    participantId: number;
    answers: BatchAnswer[];
  },
  retryRuntime: AnswerSaveRetryRuntime,
) {
  const canonicalAnswers = [...input.answers].sort(
    (left, right) => left.questionId - right.questionId,
  );
  const payload = JSON.stringify({
    submissionId: input.submissionId,
    expectedRevision: input.expectedRevision,
    answers: canonicalAnswers,
  });

  // Resolve committed retries and validate immutable input before opening the write transaction.
  try {
    const replay = await withAnswerTransactionRetry(
      () => readSubmissionOperationReplay(input, payload),
      retryRuntime,
      "preflight_read",
    );
    if (replay) return replay;

    if (
      input.answers.length !== 5 ||
      new Set(input.answers.map((answer) => answer.questionId)).size !== 5
    ) {
      throw new BatchSubmissionError("Exactly five distinct answers are required", 400);
    }

    const [submission] = await db
      .select()
      .from(examAnswerSubmissions)
      .where(eq(examAnswerSubmissions.id, input.submissionId));
    if (submission && submission.participantId !== input.participantId) {
      throw new BatchSubmissionError("Submission not found", 404);
    }
    if (input.expectedRevision !== (submission?.revision ?? 0)) {
      throw new BatchSubmissionError("Submission revision conflict", 409);
    }

    const examSet = await db
      .select({
        id: examQuestions.id,
        key: examQuestions.key,
        choices: examQuestions.choices,
        questionVersion: examQuestions.questionVersion,
      })
      .from(examQuestions)
      .orderBy(asc(examQuestions.id))
      .limit(5);
    const expectedQuestionIds = submission
      ? submission.questionIds
      : examSet.map((question) => question.id);
    if (
      expectedQuestionIds.length !== 5 ||
      canonicalAnswers.some((answer, index) => answer.questionId !== expectedQuestionIds[index])
    ) {
      throw new BatchSubmissionError("Answers must match the submission's five questions", 400);
    }
    const questions = submission
      ? await db
          .select({
            id: examQuestions.id,
            key: examQuestions.key,
            choices: examQuestions.choices,
            questionVersion: examQuestions.questionVersion,
          })
          .from(examQuestions)
          .where(inArray(examQuestions.id, expectedQuestionIds))
      : examSet;
    const questionById = new Map(questions.map((question) => [question.id, question]));
    if (
      canonicalAnswers.some((answer) => {
        const question = questionById.get(answer.questionId);
        if (!question) return true;
        if (question.key === "it-literacy-005")
          return (
            !("freeText" in answer) ||
            answer.freeText.trim().length === 0 ||
            answer.freeText.trim().length > 1000
          );
        return (
          !("selectedIndex" in answer) ||
          answer.selectedIndex < 0 ||
          answer.selectedIndex >= question.choices.length
        );
      })
    ) {
      throw new BatchSubmissionError("Answer type does not match its question", 400);
    }

    const revision = input.expectedRevision + 1;
    const questionVersions = Object.fromEntries(
      questions.flatMap((question) =>
        question.questionVersion
          ? ([[String(question.id), question.questionVersion]] as const)
          : [],
      ),
    );

    return await withAnswerTransactionRetry(
      () =>
        db.transaction(async (tx) => {
          if (submission) {
            // Reserve the operation as the first write. The reservation rolls back with
            // the answer changes if the revision compare-and-swap fails.
            const [reserved] = await tx
              .insert(examSubmissionOperations)
              .values({
                operationId: input.operationId,
                submissionId: input.submissionId,
                payload,
                revision,
              })
              .onConflictDoNothing()
              .returning({ operationId: examSubmissionOperations.operationId });
            if (!reserved) {
              const replay = await readOperationReplayInTransaction(tx, input, payload);
              if (replay) return replay;
              throw new BatchSubmissionError("Operation ID was already used", 409);
            }
            const updated = await tx
              .update(examAnswerSubmissions)
              .set({ revision, updatedAt: new Date(), questionVersions })
              .where(
                and(
                  eq(examAnswerSubmissions.id, input.submissionId),
                  eq(examAnswerSubmissions.participantId, input.participantId),
                  eq(examAnswerSubmissions.revision, input.expectedRevision),
                ),
              )
              .returning({ id: examAnswerSubmissions.id });
            if (updated.length === 0) {
              const [latest] = await tx
                .select({ id: examAnswerSubmissions.id })
                .from(examAnswerSubmissions)
                .where(
                  and(
                    eq(examAnswerSubmissions.id, input.submissionId),
                    eq(examAnswerSubmissions.participantId, input.participantId),
                  ),
                );
              if (!latest) throw new BatchSubmissionError("Submission not found", 404);
              throw new BatchSubmissionError("Submission revision conflict", 409);
            }
            await tx
              .delete(examSubmissionAnswers)
              .where(eq(examSubmissionAnswers.submissionId, input.submissionId));
          } else {
            // Target the caller's stable ID as the first transaction statement. This
            // acquires the writer before any read while preserving multiple submissions
            // per participant and making an ID collision a no-op.
            const inserted = await tx.run(sql`
            INSERT INTO exam_answer_submissions
              (id, participant_id, question_ids, question_versions, revision)
            VALUES (${input.submissionId}, ${input.participantId},
              ${JSON.stringify(expectedQuestionIds)}, ${JSON.stringify(questionVersions)}, ${revision})
            ON CONFLICT(id) DO NOTHING
          `);
            if (inserted.rowsAffected === 0) {
              const replay = await readOperationReplayInTransaction(tx, input, payload);
              if (replay) return replay;
              const [existing] = await tx
                .select({ participantId: examAnswerSubmissions.participantId })
                .from(examAnswerSubmissions)
                .where(eq(examAnswerSubmissions.id, input.submissionId));
              if (!existing || existing.participantId !== input.participantId) {
                throw new BatchSubmissionError("Submission not found", 404);
              }
              throw new BatchSubmissionError("Submission revision conflict", 409);
            }
          }

          await tx.insert(examSubmissionAnswers).values(
            canonicalAnswers.map((answer) => ({
              submissionId: input.submissionId,
              questionId: answer.questionId,
              selectedIndex: "selectedIndex" in answer ? answer.selectedIndex : null,
              freeText: "freeText" in answer ? answer.freeText.trim() : null,
              answerKind: "freeText" in answer ? "freeText" : "selected",
            })),
          );
          const freeResponse = canonicalAnswers.find((answer) => "freeText" in answer);
          if (freeResponse && "freeText" in freeResponse) {
            await tx
              .insert(examAnswerAssessments)
              .values({
                submissionId: input.submissionId,
                questionId: freeResponse.questionId,
                revision,
                answerText: freeResponse.freeText.trim(),
                questionVersion: questionById.get(freeResponse.questionId)?.questionVersion ?? null,
                state: "pending",
                rubricVersion:
                  questionById.get(freeResponse.questionId)?.questionVersion ===
                  JEV_QUESTION_VERSION
                    ? JEV_RUBRIC_VERSION
                    : "unversioned",
                attempts: 0,
                nextAttemptAt: new Date(0),
              })
              .onConflictDoUpdate({
                target: [examAnswerAssessments.submissionId, examAnswerAssessments.questionId],
                set: {
                  revision,
                  answerText: freeResponse.freeText.trim(),
                  questionVersion:
                    questionById.get(freeResponse.questionId)?.questionVersion ?? null,
                  state: "pending",
                  rawScore: null,
                  normalizedScore: null,
                  confidence: null,
                  model: null,
                  attempts: 0,
                  nextAttemptAt: new Date(0),
                  gradedAt: null,
                  errorCode: null,
                  claimToken: null,
                  rubricVersion:
                    questionById.get(freeResponse.questionId)?.questionVersion ===
                    JEV_QUESTION_VERSION
                      ? JEV_RUBRIC_VERSION
                      : "unversioned",
                },
              });
          }
          if (!submission) {
            await tx.insert(examSubmissionOperations).values({
              operationId: input.operationId,
              submissionId: input.submissionId,
              payload,
              revision,
            });
          }
          return {
            submissionId: input.submissionId,
            revision,
            assessmentTarget: freeResponse ? { submissionId: input.submissionId, revision } : null,
          };
        }),
      retryRuntime,
      "write_transaction",
    );
  } catch (error) {
    if (error instanceof BatchSubmissionError || !isKnownSqliteConflict(error)) throw error;
    let recovered: Awaited<ReturnType<typeof recoverSubmissionConflict>>;
    try {
      // The recovery lookup is read-only, so it is safe to repeat when SQLite
      // remains busy after the write attempts. Never repeat the write here:
      // the original transaction may have committed before the adapter failed.
      recovered = await withAnswerTransactionRetry(
        () => recoverSubmissionConflict(input, payload),
        retryRuntime,
        "recovery_read",
      );
    } catch (recoveryError) {
      if (recoveryError instanceof BatchSubmissionError) throw recoveryError;
      if (isSqliteLockContention(recoveryError)) {
        throw new BatchSubmissionError(
          "Answer save is temporarily unavailable",
          503,
          "DATABASE_LOCKED",
        );
      }
      throw recoveryError;
    }
    if (recovered) return recovered;
    if (isSqliteLockContention(error)) {
      throw new BatchSubmissionError(
        "Answer save is temporarily unavailable",
        503,
        "DATABASE_LOCKED",
      );
    }
    throw error;
  }
}

async function readSubmissionOperationReplay(
  input: { submissionId: string; operationId: string; participantId: number },
  payload: string,
) {
  // A single autocommit read avoids taking SQLite's writer before the actual
  // save transaction. The transaction begins with a write reservation instead
  // of a deferred read-to-write upgrade.
  const [operation] = await db
    .select({
      submissionId: examSubmissionOperations.submissionId,
      payload: examSubmissionOperations.payload,
      revision: examSubmissionOperations.revision,
      ownerParticipantId: examAnswerSubmissions.participantId,
    })
    .from(examSubmissionOperations)
    .leftJoin(
      examAnswerSubmissions,
      eq(examAnswerSubmissions.id, examSubmissionOperations.submissionId),
    )
    .where(eq(examSubmissionOperations.operationId, input.operationId));
  if (!operation) return null;
  if (operation.ownerParticipantId !== input.participantId) {
    throw new BatchSubmissionError("Submission not found", 404);
  }
  if (operation.submissionId !== input.submissionId || operation.payload !== payload) {
    throw new BatchSubmissionError("Operation ID was already used", 409);
  }
  return {
    submissionId: input.submissionId,
    revision: operation.revision,
    assessmentTarget: null,
  };
}

async function readOperationReplayInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { submissionId: string; operationId: string; participantId: number },
  payload: string,
) {
  const [operation] = await tx
    .select()
    .from(examSubmissionOperations)
    .where(eq(examSubmissionOperations.operationId, input.operationId));
  if (!operation) return null;
  const [owner] = await tx
    .select({ participantId: examAnswerSubmissions.participantId })
    .from(examAnswerSubmissions)
    .where(eq(examAnswerSubmissions.id, operation.submissionId));
  if (!owner || owner.participantId !== input.participantId) {
    throw new BatchSubmissionError("Submission not found", 404);
  }
  if (operation.submissionId !== input.submissionId || operation.payload !== payload) {
    throw new BatchSubmissionError("Operation ID was already used", 409);
  }
  return { submissionId: input.submissionId, revision: operation.revision, assessmentTarget: null };
}

function equalJitterDelay(capMs: number, random: number): number {
  const minimumMs = Math.ceil(capMs / 2);
  return minimumMs + Math.floor(random * (capMs - minimumMs + 1));
}

async function withAnswerTransactionRetry<T>(
  run: () => Promise<T>,
  runtime: AnswerSaveRetryRuntime,
  phase: AnswerSaveRetryPhase,
): Promise<T> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSqliteLockContention(error) || attempt >= maxAttempts - 1) throw error;
      const capMs = 25 * 2 ** attempt;
      const delayMs = equalJitterDelay(capMs, runtime.random());
      runtime.onRetryScheduled?.({ phase, retryNumber: attempt + 1, capMs, delayMs });
      if (runtime.sleep) await runtime.sleep(delayMs);
      else await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function isSqliteLockContention(error: unknown): boolean {
  return sqliteCauseObjects(error).some((value) => {
    const codes = [value.code, value.extendedCode].filter(
      (code): code is string => typeof code === "string",
    );
    return codes.some(
      (code) => /^SQLITE_BUSY(?:_|$)/.test(code) || /^SQLITE_LOCKED(?:_|$)/.test(code),
    );
  });
}

function isKnownSqliteConflict(error: unknown): boolean {
  for (const value of sqliteCauseObjects(error)) {
    const code = typeof value.code === "string" ? value.code : "";
    const extendedCode = typeof value.extendedCode === "string" ? value.extendedCode : "";
    if (/^SQLITE_BUSY(?:_|$)/.test(code) || /^SQLITE_LOCKED(?:_|$)/.test(code)) return true;
    if (
      [code, extendedCode].some(
        (candidate) =>
          candidate === "SQLITE_CONSTRAINT_UNIQUE" || candidate === "SQLITE_CONSTRAINT_PRIMARYKEY",
      )
    ) {
      return true;
    }
    if (
      code === "SQLITE_CONSTRAINT" &&
      typeof value.message === "string" &&
      /^UNIQUE constraint failed:/i.test(value.message)
    ) {
      return true;
    }
  }
  return false;
}

/** Re-read committed state only after a recognized adapter conflict and rollback. */
async function recoverSubmissionConflict(
  input: {
    submissionId: string;
    operationId: string;
    expectedRevision: number;
    participantId: number;
  },
  payload: string,
) {
  const [operation] = await db
    .select()
    .from(examSubmissionOperations)
    .where(eq(examSubmissionOperations.operationId, input.operationId));
  if (operation) {
    const [owner] = await db
      .select({ participantId: examAnswerSubmissions.participantId })
      .from(examAnswerSubmissions)
      .where(eq(examAnswerSubmissions.id, operation.submissionId));
    if (!owner || owner.participantId !== input.participantId) {
      throw new BatchSubmissionError("Submission not found", 404);
    }
    if (operation.submissionId === input.submissionId && operation.payload === payload) {
      return {
        submissionId: input.submissionId,
        revision: operation.revision,
        assessmentTarget: null,
      };
    }
    throw new BatchSubmissionError("Operation ID was already used", 409);
  }

  const [submission] = await db
    .select()
    .from(examAnswerSubmissions)
    .where(eq(examAnswerSubmissions.id, input.submissionId));
  if (!submission) return null;
  if (submission.participantId !== input.participantId) {
    throw new BatchSubmissionError("Submission not found", 404);
  }
  if (submission.revision !== input.expectedRevision) {
    throw new BatchSubmissionError("Submission revision conflict", 409);
  }
  return null;
}

export async function recordAnswer(input: {
  questionId: number;
  selectedIndex: number;
  isCorrect: boolean;
  participantId?: number;
}) {
  await db.insert(examAnswerLogs).values({
    questionId: input.questionId,
    selectedIndex: input.selectedIndex,
    isCorrect: input.isCorrect ? 1 : 0,
    participantId: input.participantId ?? null,
  });
}

export async function getStats() {
  const dayStart = jstDayStart();
  // The two answer-log counts share the same table and predicate (answered
  // since JST day start), so fold them into one conditional aggregate. The
  // question count is independent, so run it in parallel.
  const [qCountResult, todayStats] = await Promise.all([
    db.select({ count: count(examQuestions.id) }).from(examQuestions),
    db
      .select({
        answers: count(examAnswerLogs.id),
        correct: sql<number>`sum(case when ${examAnswerLogs.isCorrect} = 1 then 1 else 0 end)`,
      })
      .from(examAnswerLogs)
      .where(gte(examAnswerLogs.answeredAt, dayStart)),
  ]);

  const totalQuestions = Number(qCountResult?.[0]?.count ?? 0);
  const todayAnswers = Number(todayStats?.[0]?.answers ?? 0);
  const todayCorrect = Number(todayStats?.[0]?.correct ?? 0);

  const todayAccuracy = todayAnswers > 0 ? todayCorrect / todayAnswers : 0;

  return {
    totalQuestions,
    todayAnswers,
    todayAccuracy,
  };
}

/** Process at most five durable jobs sequentially. Each request gets a unique
 * lease token so an expired worker cannot apply a late response. */
export async function processDueAssessments(
  retryFailed = false,
  target?: { submissionId: string; revision: number },
) {
  if (retryFailed)
    await db
      .update(examAnswerAssessments)
      .set({
        state: "pending",
        attempts: 0,
        nextAttemptAt: new Date(0),
        errorCode: null,
        claimToken: null,
      })
      .where(eq(examAnswerAssessments.state, "failed"));
  let graded = 0;
  let retried = 0;
  let failed = 0;
  const maxJobs = target ? 1 : 5;
  for (let index = 0; index < maxJobs; index += 1) {
    const now = new Date();
    const dueConditions = [
      or(eq(examAnswerAssessments.state, "pending"), eq(examAnswerAssessments.state, "processing")),
      lte(examAnswerAssessments.nextAttemptAt, now),
      eq(examAnswerAssessments.questionVersion, JEV_QUESTION_VERSION),
      eq(examAnswerAssessments.rubricVersion, JEV_RUBRIC_VERSION),
    ];
    if (target) {
      dueConditions.push(
        eq(examAnswerAssessments.submissionId, target.submissionId),
        eq(examAnswerAssessments.revision, target.revision),
      );
    }
    const [job] = await db
      .select()
      .from(examAnswerAssessments)
      .where(and(...dueConditions))
      .limit(1);
    if (!job) break;
    const attempts = job.attempts + 1;
    const claimToken = randomUUID();
    const claim = await db
      .update(examAnswerAssessments)
      .set({
        state: "processing",
        attempts,
        claimToken,
        nextAttemptAt: new Date(Date.now() + 45_000),
      })
      .where(
        and(
          eq(examAnswerAssessments.submissionId, job.submissionId),
          eq(examAnswerAssessments.questionId, job.questionId),
          eq(examAnswerAssessments.revision, job.revision),
          eq(examAnswerAssessments.answerText, job.answerText),
          eq(examAnswerAssessments.questionVersion, JEV_QUESTION_VERSION),
          eq(examAnswerAssessments.rubricVersion, job.rubricVersion),
          eq(examAnswerAssessments.rubricVersion, JEV_RUBRIC_VERSION),
          eq(examAnswerAssessments.state, job.state),
          lte(examAnswerAssessments.nextAttemptAt, now),
          sql`EXISTS (
            SELECT 1 FROM exam_answer_submissions
            WHERE exam_answer_submissions.id = ${job.submissionId}
              AND exam_answer_submissions.revision = ${job.revision}
          )`,
        ),
      )
      .returning({ submissionId: examAnswerAssessments.submissionId });
    if (!claim.length) continue;
    try {
      const result = await gradeFreeResponse(
        job.answerText,
        job.questionVersion,
        job.rubricVersion,
      );
      const applied = await db
        .update(examAnswerAssessments)
        .set({
          state: "graded",
          rawScore: result.score,
          normalizedScore: scoreQ5(job.answerText, result.score),
          confidence: result.confidence,
          model: result.model,
          gradedAt: new Date(),
          nextAttemptAt: null,
          errorCode: null,
          claimToken: null,
        })
        .where(
          and(
            eq(examAnswerAssessments.submissionId, job.submissionId),
            eq(examAnswerAssessments.questionId, job.questionId),
            eq(examAnswerAssessments.revision, job.revision),
            eq(examAnswerAssessments.answerText, job.answerText),
            eq(examAnswerAssessments.questionVersion, JEV_QUESTION_VERSION),
            eq(examAnswerAssessments.rubricVersion, job.rubricVersion),
            eq(examAnswerAssessments.rubricVersion, JEV_RUBRIC_VERSION),
            eq(examAnswerAssessments.state, "processing"),
            eq(examAnswerAssessments.claimToken, claimToken),
            sql`EXISTS (
              SELECT 1 FROM exam_answer_submissions
              WHERE exam_answer_submissions.id = ${job.submissionId}
                AND exam_answer_submissions.revision = ${job.revision}
            )`,
          ),
        )
        .returning({ submissionId: examAnswerAssessments.submissionId });
      if (applied.length) graded += 1;
    } catch (error) {
      const code =
        error instanceof Error && error.message.startsWith("jev_")
          ? error.message
          : error instanceof Error && error.message === "Unsupported question/rubric version pair"
            ? "jev_unknown_version_pair"
            : "jev_transport_error";
      const permanent = [
        "jev_validation",
        "jev_invalid_json",
        "jev_invalid_response",
        "jev_not_configured",
        "jev_unknown_version_pair",
      ].includes(code);
      const terminal = permanent || attempts >= 8;
      const nextAttemptAt = terminal
        ? null
        : new Date(Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7)));
      const changed = await db
        .update(examAnswerAssessments)
        .set({
          state: terminal ? "failed" : "pending",
          attempts,
          nextAttemptAt,
          errorCode: code,
          claimToken: null,
        })
        .where(
          and(
            eq(examAnswerAssessments.submissionId, job.submissionId),
            eq(examAnswerAssessments.questionId, job.questionId),
            eq(examAnswerAssessments.revision, job.revision),
            eq(examAnswerAssessments.answerText, job.answerText),
            eq(examAnswerAssessments.questionVersion, JEV_QUESTION_VERSION),
            eq(examAnswerAssessments.rubricVersion, job.rubricVersion),
            eq(examAnswerAssessments.rubricVersion, JEV_RUBRIC_VERSION),
            eq(examAnswerAssessments.state, "processing"),
            eq(examAnswerAssessments.claimToken, claimToken),
          ),
        )
        .returning({ submissionId: examAnswerAssessments.submissionId });
      if (changed.length) {
        if (terminal) failed += 1;
        else retried += 1;
      }
    }
  }
  return { processed: graded + retried + failed, graded, retried, failed };
}
