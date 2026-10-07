import { and, asc, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../index";
import {
  examAnswerLogs,
  examAnswerAssessments,
  examAnswerSubmissions,
  examQuestions,
  examSubmissionAnswers,
  examSubmissionOperations,
} from "../schema";
import { jstDayStart } from "../../date";
import { gradeFreeResponse, JEV_RUBRIC_VERSION } from "@/lib/jev/adapter";
import { randomUUID } from "node:crypto";

export type BatchAnswer =
  | { questionId: number; selectedIndex: number }
  | { questionId: number; freeText: string };

export class BatchSubmissionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "BatchSubmissionError";
  }
}

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
    const answerByQuestion = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
    type RestoredAnswer = {
      questionId: number;
      answerKind: "selected" | "legacy" | "freeText";
      selectedIndex: number | null;
      freeText: string | null;
    };
    const answers = submission.questionIds.flatMap<RestoredAnswer>((questionId) => {
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
    return { submissionId: submission.id, revision: submission.revision, answers };
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
    const answerByQuestion = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
    type RestoredAnswer = {
      questionId: number;
      answerKind: "selected" | "legacy" | "freeText";
      selectedIndex: number | null;
      freeText: string | null;
    };
    const answers = submission.questionIds.flatMap<RestoredAnswer>((questionId) => {
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
    return { submissionId: submission.id, revision: submission.revision, answers };
  });
}

/** Save or revise one fixed five-question answer set atomically. */
export async function saveAnswerSubmission(input: {
  submissionId: string;
  operationId: string;
  expectedRevision: number;
  participantId: number;
  answers: BatchAnswer[];
}) {
  const canonicalAnswers = [...input.answers].sort(
    (left, right) => left.questionId - right.questionId,
  );
  const payload = JSON.stringify({
    submissionId: input.submissionId,
    expectedRevision: input.expectedRevision,
    answers: canonicalAnswers,
  });

  try {
    return await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(examSubmissionOperations)
        .where(eq(examSubmissionOperations.operationId, input.operationId));
      if (operation) {
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
        return {
          submissionId: input.submissionId,
          revision: operation.revision,
          assessmentTarget: null,
        };
      }

      if (
        input.answers.length !== 5 ||
        new Set(input.answers.map((a) => a.questionId)).size !== 5
      ) {
        throw new BatchSubmissionError("Exactly five distinct answers are required", 400);
      }

      const [submission] = await tx
        .select()
        .from(examAnswerSubmissions)
        .where(eq(examAnswerSubmissions.id, input.submissionId));
      if (submission && submission.participantId !== input.participantId) {
        throw new BatchSubmissionError("Submission not found", 404);
      }
      if (input.expectedRevision !== (submission?.revision ?? 0)) {
        throw new BatchSubmissionError("Submission revision conflict", 409);
      }

      const examSet = await tx
        .select({ id: examQuestions.id, key: examQuestions.key, choices: examQuestions.choices })
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
      if (!submission && examSet.length !== 5) {
        throw new BatchSubmissionError("Five exam questions are required", 400);
      }
      const questions = submission
        ? await tx
            .select({
              id: examQuestions.id,
              key: examQuestions.key,
              choices: examQuestions.choices,
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
      )
        throw new BatchSubmissionError("Answer type does not match its question", 400);

      const revision = submission ? submission.revision + 1 : 1;

      if (submission) {
        const updated = await tx
          .update(examAnswerSubmissions)
          .set({ revision, updatedAt: new Date() })
          .where(
            and(
              eq(examAnswerSubmissions.id, input.submissionId),
              eq(examAnswerSubmissions.revision, input.expectedRevision),
            ),
          )
          .returning({ id: examAnswerSubmissions.id });
        if (updated.length === 0) {
          const [latest] = await tx
            .select({ revision: examAnswerSubmissions.revision })
            .from(examAnswerSubmissions)
            .where(eq(examAnswerSubmissions.id, input.submissionId));
          if (!latest) throw new BatchSubmissionError("Submission not found", 404);
          throw new BatchSubmissionError("Submission revision conflict", 409);
        }
        await tx
          .delete(examSubmissionAnswers)
          .where(eq(examSubmissionAnswers.submissionId, input.submissionId));
      } else {
        await tx.insert(examAnswerSubmissions).values({
          id: input.submissionId,
          participantId: input.participantId,
          questionIds: expectedQuestionIds,
          revision,
        });
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
            state: "pending",
            rubricVersion: JEV_RUBRIC_VERSION,
            attempts: 0,
            nextAttemptAt: new Date(0),
          })
          .onConflictDoUpdate({
            target: [examAnswerAssessments.submissionId, examAnswerAssessments.questionId],
            set: {
              revision,
              answerText: freeResponse.freeText.trim(),
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
              rubricVersion: JEV_RUBRIC_VERSION,
            },
          });
      }
      await tx.insert(examSubmissionOperations).values({
        operationId: input.operationId,
        submissionId: input.submissionId,
        payload,
        revision,
      });
      return {
        submissionId: input.submissionId,
        revision,
        assessmentTarget: freeResponse ? { submissionId: input.submissionId, revision } : null,
      };
    });
  } catch (error) {
    if (error instanceof BatchSubmissionError || !isKnownSqliteConflict(error)) throw error;
    const recovered = await recoverSubmissionConflict(input, payload);
    if (recovered) return recovered;
    throw error;
  }
}

function isKnownSqliteConflict(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  for (let depth = 0; pending.length > 0 && depth < 6; depth += 1) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    const value = current as {
      code?: unknown;
      extendedCode?: unknown;
      message?: unknown;
      cause?: unknown;
      originalError?: unknown;
      original?: unknown;
      error?: unknown;
    };
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

    pending.push(value.cause, value.originalError, value.original, value.error);
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
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(examSubmissionOperations)
      .where(eq(examSubmissionOperations.operationId, input.operationId));
    if (operation) {
      const [owner] = await tx
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

    const [submission] = await tx
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
  });
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
          eq(examAnswerAssessments.state, job.state),
          lte(examAnswerAssessments.nextAttemptAt, now),
        ),
      )
      .returning({ submissionId: examAnswerAssessments.submissionId });
    if (!claim.length) continue;
    try {
      const result = await gradeFreeResponse(job.answerText);
      const current = await db
        .select({ revision: examAnswerSubmissions.revision })
        .from(examAnswerSubmissions)
        .where(eq(examAnswerSubmissions.id, job.submissionId));
      const applied =
        current[0]?.revision === job.revision
          ? await db
              .update(examAnswerAssessments)
              .set({
                state: "graded",
                rawScore: result.score,
                normalizedScore: result.score / 2,
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
                  eq(examAnswerAssessments.state, "processing"),
                  eq(examAnswerAssessments.claimToken, claimToken),
                ),
              )
              .returning({ submissionId: examAnswerAssessments.submissionId })
          : [];
      if (applied.length) graded += 1;
    } catch (error) {
      const code =
        error instanceof Error && error.message.startsWith("jev_")
          ? error.message
          : "jev_transport_error";
      const permanent = [
        "jev_validation",
        "jev_invalid_json",
        "jev_invalid_response",
        "jev_not_configured",
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
