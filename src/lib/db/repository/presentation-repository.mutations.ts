import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  makePresentationOperationError,
  type PresentationOperationPhase,
} from "@/lib/presentation/operation-diagnostics";
import {
  examAnswerSubmissions,
  examAnswerAssessments,
  examParticipants,
  examQuestions,
  examSubmissionAnswers,
  presentationEntries,
  presentationOperations,
  presentationQuestions,
  presentationSessions,
  participantResultSettings,
} from "@/lib/db/schema";
import {
  rankForStage,
  readAdminPresentation,
  readAdminPresentationControls,
  stageForRank,
} from "./presentation-repository.reads";
import type {
  PresentationAnswerSnapshot,
  PresentationAction,
  PresentationState,
  AdminPresentationControls,
} from "./presentation-repository.reads";
import {
  getRubricVersionForQuestionVersion,
  isSupportedGraderVersionPair,
  JEV_QUESTION_VERSION,
  JEV_RUBRIC_VERSION,
} from "@/lib/jev/adapter";

export class PresentationConflictError extends Error {
  readonly status = 409;
}

function makeVersionMaps(questions: { id: number; key: string; questionVersion: string | null }[]) {
  const questionVersions: Record<string, string> = {};
  const rubricVersions: Record<string, string> = {};
  for (const question of questions) {
    if (!question.questionVersion) return null;
    questionVersions[String(question.id)] = question.questionVersion;
    if (question.key === "it-literacy-005") {
      const rubricVersion = getRubricVersionForQuestionVersion(question.questionVersion);
      if (
        !rubricVersion ||
        !isSupportedGraderVersionPair(question.questionVersion, rubricVersion) ||
        question.questionVersion !== JEV_QUESTION_VERSION ||
        rubricVersion !== JEV_RUBRIC_VERSION
      ) {
        return null;
      }
      rubricVersions[String(question.id)] = rubricVersion;
    }
  }
  if (!questions.some((question) => question.key === "it-literacy-005")) return null;
  return { questionVersions, rubricVersions };
}

function sameVersionMap(value: unknown, expected: Record<string, string>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const map = value as Record<string, unknown>;
  const keys = Object.keys(map).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index] && map[key] === expected[key])
  );
}

const presentationActions = new Set<string>([
  "start",
  "advance",
  "previous",
  "hide",
  "show",
  "aggregate",
  "reset",
]);

export async function setParticipantResultsVisible(visible: boolean) {
  let phase: PresentationOperationPhase = "transaction_begin";
  try {
    return await withTransactionRetry(() => {
      // Reset this before every attempt so a failed transaction cannot leak a
      // phase from the attempt that is being retried.
      phase = "transaction_begin";
      return db.transaction(async (tx) => {
        if (visible) {
          phase = "acquire_session";
          const session = await acquirePresentationSession(tx);
          if (
            session.snapshotRevision === 0 ||
            (session.state === "not_started" && session.questionCount === 0)
          ) {
            throw new PresentationConflictError("Results are not ready");
          }
          phase = "write_visibility";
          await tx
            .insert(participantResultSettings)
            .values({ id: 1, visible: true, everPublished: true })
            .onConflictDoUpdate({
              target: participantResultSettings.id,
              set: { visible: true, everPublished: true },
            });
        } else {
          phase = "hide_results";
          await tx
            .update(participantResultSettings)
            .set({ visible: false })
            .where(eq(participantResultSettings.id, 1));
        }
        phase = "transaction_commit";
        return { visible };
      });
    });
  } catch (error) {
    if (error instanceof PresentationConflictError) throw error;
    throw makePresentationOperationError(phase, error);
  }
}

async function acquirePresentationSession(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<typeof presentationSessions.$inferSelect> {
  await tx
    .insert(presentationSessions)
    .values({
      id: 1,
      state: "not_started",
      version: 0,
      questionIndex: 0,
      questionCount: 0,
      projectionHidden: false,
    })
    .onConflictDoNothing({ target: presentationSessions.id });
  // Serialize publication and presentation actions before any reads in the
  // transaction, avoiding a deferred-transaction read-to-write upgrade.
  await tx
    .update(presentationSessions)
    .set({ version: sql`${presentationSessions.version}` })
    .where(eq(presentationSessions.id, 1));
  const [session] = await tx
    .select()
    .from(presentationSessions)
    .where(eq(presentationSessions.id, 1));
  if (!session) throw new PresentationConflictError("Presentation session is unavailable");
  return session;
}

async function startPresentation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  acquiredSession: typeof presentationSessions.$inferSelect,
) {
  if (acquiredSession.snapshotRevision === 0) {
    throw new PresentationConflictError("Aggregate results before starting the presentation");
  }
  const currentQuestions = await tx.select().from(examQuestions).orderBy(asc(examQuestions.id));
  const currentVersions = makeVersionMaps(currentQuestions);
  if (
    !currentVersions ||
    !sameVersionMap(acquiredSession.questionVersions, currentVersions.questionVersions) ||
    !sameVersionMap(acquiredSession.rubricVersions, currentVersions.rubricVersions)
  ) {
    throw new PresentationConflictError(
      "Presentation snapshot versions are missing or outdated; aggregate results again",
    );
  }
  const state: PresentationState = "opening";
  const version = acquiredSession.version + 1;
  const updated = await tx
    .update(presentationSessions)
    .set({ state, version, questionIndex: 0 })
    .where(
      and(
        eq(presentationSessions.id, 1),
        eq(presentationSessions.version, acquiredSession.version),
      ),
    )
    .returning({ id: presentationSessions.id });
  if (!updated.length)
    throw new PresentationConflictError("Presentation state changed concurrently");
  return version;
}

async function ensurePresentationSnapshot(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  session: typeof presentationSessions.$inferSelect,
  setOperationPhase?: (phase: PresentationOperationPhase) => void,
): Promise<typeof presentationSessions.$inferSelect> {
  setOperationPhase?.("source_questions_read");
  const currentQuestions = await tx.select().from(examQuestions).orderBy(asc(examQuestions.id));
  const versionMaps = makeVersionMaps(currentQuestions);
  if (!versionMaps) {
    throw new PresentationConflictError(
      "Current questions include missing or unsupported versions; update the question and rubric version registry before aggregating",
    );
  }
  setOperationPhase?.("participants_read");
  const participants = await tx.select().from(examParticipants).orderBy(asc(examParticipants.id));
  setOperationPhase?.("submissions_read");
  const submissions = await tx
    .select()
    .from(examAnswerSubmissions)
    .orderBy(
      asc(examAnswerSubmissions.participantId),
      desc(examAnswerSubmissions.updatedAt),
      desc(examAnswerSubmissions.revision),
      desc(examAnswerSubmissions.createdAt),
      desc(examAnswerSubmissions.id),
    );
  const submissionIds = submissions.map(({ id }) => id);
  if (submissionIds.length) setOperationPhase?.("answers_read");
  const savedAnswers = submissionIds.length
    ? await tx
        .select()
        .from(examSubmissionAnswers)
        .where(inArray(examSubmissionAnswers.submissionId, submissionIds))
    : [];
  if (submissionIds.length) setOperationPhase?.("assessments_read");
  const assessments = submissionIds.length
    ? await tx
        .select()
        .from(examAnswerAssessments)
        .where(inArray(examAnswerAssessments.submissionId, submissionIds))
    : [];
  const assessmentBySubmission = new Map(
    assessments.map((assessment) => [assessment.submissionId, assessment]),
  );

  const answersBySubmission = new Map<string, Map<number, (typeof savedAnswers)[number]>>();
  for (const answer of savedAnswers) {
    const answers =
      answersBySubmission.get(answer.submissionId) ??
      new Map<number, (typeof savedAnswers)[number]>();
    answers.set(answer.questionId, answer);
    answersBySubmission.set(answer.submissionId, answers);
  }

  const latestSubmissionByParticipant = new Map<number, (typeof submissions)[number]>();
  for (const submission of submissions) {
    if (!latestSubmissionByParticipant.has(submission.participantId)) {
      latestSubmissionByParticipant.set(submission.participantId, submission);
    }
  }
  for (const submission of latestSubmissionByParticipant.values()) {
    if (!sameVersionMap(submission.questionVersions, versionMaps.questionVersions)) {
      throw new PresentationConflictError(
        `Submission ${submission.id} has missing or outdated question versions; audit or resubmit it before aggregating`,
      );
    }
    const q5 = currentQuestions.find((question) => question.key === "it-literacy-005");
    const q5Answer = q5 ? answersBySubmission.get(submission.id)?.get(q5.id) : undefined;
    const assessment = assessmentBySubmission.get(submission.id);
    if (
      !q5 ||
      q5Answer?.answerKind !== "freeText" ||
      !assessment ||
      assessment.revision !== submission.revision ||
      assessment.state !== "graded" ||
      assessment.questionVersion !== q5.questionVersion ||
      assessment.rubricVersion !== versionMaps.rubricVersions[String(q5.id)] ||
      !isSupportedGraderVersionPair(assessment.questionVersion, assessment.rubricVersion)
    ) {
      throw new PresentationConflictError(
        `Submission ${submission.id} has a missing or incompatible Q5 answer/assessment version; audit and regrade it before aggregating`,
      );
    }
  }

  const firstSubmissionByParticipant = new Set<number>();
  for (const submission of submissions) {
    if (firstSubmissionByParticipant.has(submission.participantId)) continue;
    firstSubmissionByParticipant.add(submission.participantId);
    const q5 = currentQuestions.find((question) => question.key === "it-literacy-005");
    const answer = q5 ? answersBySubmission.get(submission.id)?.get(q5.id) : undefined;
    if (answer?.answerKind === "freeText") {
      const assessment = assessmentBySubmission.get(submission.id);
      if (
        !assessment ||
        assessment.revision !== submission.revision ||
        assessment.state !== "graded"
      ) {
        throw new PresentationConflictError(
          "Free-response assessments must finish before results are aggregated",
        );
      }
    }
  }

  const scored = participants.map((participant) => {
    const submission = submissions.find((candidate) => {
      if (candidate.participantId !== participant.id) return false;
      const answers = answersBySubmission.get(candidate.id);
      const assessment = assessmentBySubmission.get(candidate.id);
      return (
        candidate.questionIds.length === currentQuestions.length &&
        currentQuestions.every((question) => candidate.questionIds.includes(question.id)) &&
        answers?.size === currentQuestions.length &&
        currentQuestions.every((question) => {
          const selected = answers?.get(question.id);
          return question.key === "it-literacy-005"
            ? selected?.answerKind === "legacy" ||
                (selected?.answerKind === "freeText" &&
                  assessment?.revision === candidate.revision &&
                  assessment.state === "graded")
            : selected?.answerKind === "selected" &&
                selected.selectedIndex !== null &&
                selected.selectedIndex >= 0 &&
                selected.selectedIndex < question.choices.length;
        })
      );
    });
    const answers = submission ? answersBySubmission.get(submission.id) : undefined;
    const validCompleteSet = Boolean(submission);
    const assessment = submission ? assessmentBySubmission.get(submission.id) : undefined;
    const answerSnapshot: PresentationAnswerSnapshot[] = currentQuestions.map((question) => {
      const answer = validCompleteSet ? answers?.get(question.id) : undefined;
      const answerKind: PresentationAnswerSnapshot["answerKind"] =
        answer?.answerKind === "selected" ||
        answer?.answerKind === "freeText" ||
        answer?.answerKind === "legacy"
          ? answer.answerKind
          : "unanswered";
      return {
        questionId: question.id,
        answerKind,
        selectedIndex: answer?.selectedIndex ?? null,
        freeText: answer?.freeText ?? null,
        rawScore:
          question.key === "it-literacy-005" && assessment?.state === "graded"
            ? assessment.rawScore
            : null,
        normalizedScore:
          question.key === "it-literacy-005" && assessment?.state === "graded"
            ? assessment.normalizedScore
            : null,
      };
    });
    const score = validCompleteSet
      ? currentQuestions.reduce((sum, question) => {
          if (question.key === "it-literacy-005")
            return sum + (assessment?.state === "graded" ? Number(assessment.normalizedScore) : 0);
          return sum + Number(answers?.get(question.id)?.selectedIndex === question.correctIndex);
        }, 0)
      : 0;
    return { participant, answers: answerSnapshot, score };
  });
  scored.sort(
    (left, right) => right.score - left.score || left.participant.id - right.participant.id,
  );
  let priorScore: number | undefined;
  let priorRank = 0;
  const ranked = scored.map((entry, index) => {
    if (entry.score !== priorScore) {
      priorRank = index + 1;
      priorScore = entry.score;
    }
    return { ...entry, rank: priorRank };
  });

  setOperationPhase?.("delete_entries");
  await tx.delete(presentationEntries).where(eq(presentationEntries.sessionId, 1));
  setOperationPhase?.("delete_questions");
  await tx.delete(presentationQuestions).where(eq(presentationQuestions.sessionId, 1));
  if (currentQuestions.length) {
    setOperationPhase?.("insert_questions");
    await tx.insert(presentationQuestions).values(
      currentQuestions.map((question, position) => ({
        sessionId: 1,
        position,
        sourceQuestionId: question.id,
        question: question.question,
        choices: question.choices,
        correctIndex: question.correctIndex,
        explanation: question.explanation,
      })),
    );
  }
  if (ranked.length) {
    setOperationPhase?.("insert_entries");
    await tx.insert(presentationEntries).values(
      ranked.map(({ participant, score, rank, answers }) => ({
        sessionId: 1,
        participantId: participant.id,
        displayName: participant.displayName,
        score,
        rank,
        answers,
      })),
    );
  }
  const invalidQuestionCursor =
    session.questionIndex < 0 || session.questionIndex >= currentQuestions.length;
  const preserveTerminalOrUnstartedState =
    session.state === "not_started" || session.state === "opening" || session.state === "finished";
  const nextState =
    invalidQuestionCursor && !preserveTerminalOrUnstartedState
      ? currentQuestions.length === 0
        ? "podium_preview"
        : "question"
      : session.state;
  const questionIndex = invalidQuestionCursor ? 0 : session.questionIndex;
  setOperationPhase?.("update_session");
  const updated = await tx
    .update(presentationSessions)
    .set({
      questionCount: currentQuestions.length,
      questionVersions: versionMaps.questionVersions,
      rubricVersions: versionMaps.rubricVersions,
      questionIndex,
      snapshotRevision: session.snapshotRevision + 1,
      version: session.version + 1,
      ...(nextState !== session.state ? { state: nextState } : {}),
    })
    .where(and(eq(presentationSessions.id, 1), eq(presentationSessions.version, session.version)))
    .returning({ id: presentationSessions.id });
  if (!updated.length)
    throw new PresentationConflictError("Presentation state changed concurrently");
  setOperationPhase?.("read_session");
  const [snapshottedSession] = await tx
    .select()
    .from(presentationSessions)
    .where(eq(presentationSessions.id, 1));
  if (!snapshottedSession)
    throw new PresentationConflictError("Presentation session is unavailable");
  return snapshottedSession;
}

async function nextNonemptyRank(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  below: number,
) {
  for (const rank of [3, 2, 1]) {
    if (rank >= below) continue;
    const [winner] = await tx
      .select({ participantId: presentationEntries.participantId })
      .from(presentationEntries)
      .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, rank)))
      .limit(1);
    if (winner) return stageForRank(rank);
  }
  return "finished" as const;
}

async function lastAnnouncedRank(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  // Awards are announced in 3rd, 2nd, 1st order. The last existing step is
  // therefore the best (lowest-numbered) rank that has at least one winner.
  for (const rank of [1, 2, 3]) {
    const [winner] = await tx
      .select({ participantId: presentationEntries.participantId })
      .from(presentationEntries)
      .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, rank)))
      .limit(1);
    if (winner) return stageForRank(rank);
  }
  return null;
}

async function advanceState(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  state: PresentationState,
  questionIndex: number,
  questionCount: number,
) {
  if (state === "opening") {
    return questionCount > 0
      ? { state: "question" as const, questionIndex: 0 }
      : { state: "podium_preview" as const, questionIndex: 0 };
  }
  if (state === "question") return { state: "answer" as const, questionIndex };
  if (state === "answer") {
    if (questionIndex + 1 < questionCount) {
      return { state: "question" as const, questionIndex: questionIndex + 1 };
    }
    return { state: "podium_preview" as const, questionIndex };
  }
  if (state === "podium_preview") return { state: await nextNonemptyRank(tx, 4), questionIndex };
  const currentRank = rankForStage(state);
  if (currentRank !== null) {
    return { state: await nextNonemptyRank(tx, currentRank), questionIndex };
  }
  throw new PresentationConflictError("Presentation cannot advance from its current state");
}

async function previousState(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  state: PresentationState,
  questionIndex: number,
  questionCount: number,
) {
  if (state === "opening")
    throw new PresentationConflictError("Presentation is already at its first state");
  if (state === "question" && questionIndex === 0)
    return { state: "opening" as const, questionIndex: 0 };
  if (state === "question" && questionIndex > 0) {
    return { state: "answer" as const, questionIndex: questionIndex - 1 };
  }
  if (state === "answer") return { state: "question" as const, questionIndex };
  if (state === "podium_preview" && questionCount > 0) {
    return { state: "answer" as const, questionIndex: questionCount - 1 };
  }
  if (state === "podium_preview" && questionCount === 0)
    return { state: "opening" as const, questionIndex: 0 };
  if (state === "third") return { state: "podium_preview" as const, questionIndex };
  const currentRank = rankForStage(state);
  if (currentRank !== null) {
    for (let rank = currentRank + 1; rank <= 3; rank += 1) {
      const [winner] = await tx
        .select({ participantId: presentationEntries.participantId })
        .from(presentationEntries)
        .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, rank)))
        .limit(1);
      if (winner) return { state: stageForRank(rank), questionIndex };
    }
    return { state: "podium_preview" as const, questionIndex };
  }
  if (state === "finished") {
    return {
      state: (await lastAnnouncedRank(tx)) ?? "podium_preview",
      questionIndex,
    };
  }
  throw new PresentationConflictError("Presentation is already at its first state");
}

export async function operatePresentation(operationId: string, action: PresentationAction) {
  return operatePresentationWithResponse(operationId, action, readAdminPresentation);
}

export async function operatePresentationControls(
  operationId: string,
  action: PresentationAction,
  expectedSnapshotRevision?: number,
): Promise<AdminPresentationControls> {
  return operatePresentationWithResponse(
    operationId,
    action,
    readAdminPresentationControls,
    expectedSnapshotRevision,
  );
}

async function operatePresentationWithResponse<T>(
  operationId: string,
  action: PresentationAction,
  readResponse: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  expectedSnapshotRevision?: number,
): Promise<T> {
  if (!presentationActions.has(action))
    throw new PresentationConflictError("Unsupported presentation action");
  let phase: PresentationOperationPhase = "transaction_begin";
  try {
    return await withTransactionRetry(() => {
      phase = "transaction_begin";
      return db.transaction(async (tx) => {
        phase = "acquire_session";
        const session = await acquirePresentationSession(tx);
        const [operation] = await tx
          .select()
          .from(presentationOperations)
          .where(eq(presentationOperations.operationId, operationId));
        if (operation) {
          if (operation.action !== action)
            throw new PresentationConflictError("Operation ID conflict");
          return readResponse(tx);
        }
        if (
          expectedSnapshotRevision !== undefined &&
          session.snapshotRevision !== expectedSnapshotRevision
        ) {
          throw new PresentationConflictError("Presentation snapshot changed concurrently");
        }

        if (action === "start") {
          if (session.state !== "not_started")
            throw new PresentationConflictError("Presentation has already started");
          const version = await startPresentation(tx, session);
          await tx.insert(presentationOperations).values({ operationId, action, version });
          return readResponse(tx);
        }
        if (action === "aggregate") {
          const aggregated = await ensurePresentationSnapshot(tx, session, (nextPhase) => {
            phase = nextPhase;
          });
          phase = "transaction_commit";
          await tx
            .insert(presentationOperations)
            .values({ operationId, action, version: aggregated.version });
          return readResponse(tx);
        }
        if (action === "reset") {
          if (session.state === "not_started")
            throw new PresentationConflictError("Start the presentation before resetting it");
          const state: PresentationState = "opening";
          const version = session.version + 1;
          const changed = await tx
            .update(presentationSessions)
            .set({ state, questionIndex: 0, version })
            .where(
              and(
                eq(presentationSessions.id, 1),
                eq(presentationSessions.version, session.version),
              ),
            )
            .returning({ id: presentationSessions.id });
          if (!changed.length)
            throw new PresentationConflictError("Presentation state changed concurrently");
          await tx.insert(presentationOperations).values({ operationId, action, version });
          return readResponse(tx);
        }
        if (action === "hide" || action === "show") {
          const projectionHidden = action === "hide";
          const version = session.version + 1;
          const changed = await tx
            .update(presentationSessions)
            .set({ projectionHidden, version })
            .where(
              and(
                eq(presentationSessions.id, 1),
                eq(presentationSessions.version, session.version),
              ),
            )
            .returning({ id: presentationSessions.id });
          if (!changed.length)
            throw new PresentationConflictError("Presentation state changed concurrently");
          await tx.insert(presentationOperations).values({ operationId, action, version });
          return readResponse(tx);
        }
        if (session.state === "not_started")
          throw new PresentationConflictError("Presentation has not started");
        const cursorState = session.state as PresentationState;
        const next =
          action === "previous"
            ? await previousState(tx, cursorState, session.questionIndex, session.questionCount)
            : await advanceState(tx, cursorState, session.questionIndex, session.questionCount);
        const changed = await tx
          .update(presentationSessions)
          .set({
            state: next.state,
            questionIndex: next.questionIndex,
            version: session.version + 1,
          })
          .where(
            and(eq(presentationSessions.id, 1), eq(presentationSessions.version, session.version)),
          )
          .returning({ id: presentationSessions.id });
        if (!changed.length)
          throw new PresentationConflictError("Presentation state changed concurrently");
        await tx
          .insert(presentationOperations)
          .values({ operationId, action, version: session.version + 1 });
        return readResponse(tx);
      });
    });
  } catch (error) {
    if (error instanceof PresentationConflictError) throw error;
    // Lock contention is retried by starting a fresh transaction above. If all
    // attempts are exhausted, preserve the database error for the caller.
    if (isSqliteLockRace(error)) {
      if (action === "aggregate") throw makePresentationOperationError(phase, error);
      throw error;
    }
    if (!isKnownTransactionRace(error)) {
      if (action === "aggregate") throw makePresentationOperationError(phase, error);
      throw error;
    }
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(presentationOperations)
        .where(eq(presentationOperations.operationId, operationId));
      if (operation) {
        if (operation.action !== action)
          throw new PresentationConflictError("Operation ID conflict");
        return readResponse(tx);
      }
      throw new PresentationConflictError("Presentation state changed concurrently");
    });
  }
}

async function withTransactionRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSqliteLockRace(error) || attempt >= maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

function isSqliteLockRace(error: unknown) {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 6; depth += 1) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const value = current as {
      code?: unknown;
      extendedCode?: unknown;
      cause?: unknown;
      originalError?: unknown;
      original?: unknown;
      error?: unknown;
    };
    const codes = [value.code, value.extendedCode].filter(
      (code): code is string => typeof code === "string",
    );
    if (
      codes.some((code) => /^SQLITE_BUSY(?:_|$)/.test(code) || /^SQLITE_LOCKED(?:_|$)/.test(code))
    ) {
      return true;
    }
    pending.push(value.cause, value.originalError, value.original, value.error);
  }
  return false;
}

function isKnownTransactionRace(error: unknown) {
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
    const codes = [value.code, value.extendedCode].filter(
      (code): code is string => typeof code === "string",
    );
    if (
      codes.some(
        (code) => code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY",
      ) ||
      (codes.includes("SQLITE_CONSTRAINT") &&
        typeof value.message === "string" &&
        /^UNIQUE constraint failed:/i.test(value.message))
    ) {
      return true;
    }
    pending.push(value.cause, value.originalError, value.original, value.error);
  }
  return false;
}
