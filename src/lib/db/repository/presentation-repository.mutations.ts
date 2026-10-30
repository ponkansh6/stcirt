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
import { sqliteCauseObjects } from "./sqlite-cause-traversal";

export class PresentationConflictError extends Error {
  readonly status = 409;
}

export type PresentationAggregationSummary = {
  snapshotUpdated: boolean;
  includedSubmissionCount: number;
  excludedSubmissionCount: number;
  excludedReasonCounts: {
    questionVersionMismatch: number;
    q5AssessmentVersionMismatch: number;
  };
};

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
  "position",
  "hide",
  "show",
  "aggregate",
  "reset",
]);

const supportedPresentationStates = new Set<PresentationState>([
  "opening",
  "question",
  "answer",
  "podium_preview",
  "third",
  "second",
  "first",
  "first_prize",
  "finished",
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
          phase = "acquire_session";
          await acquirePresentationSession(tx);
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

export async function acquirePresentationSession(
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
): Promise<{
  session: typeof presentationSessions.$inferSelect;
  aggregationSummary: PresentationAggregationSummary;
}> {
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
  type ValidatedLatestSubmission = {
    submission: (typeof submissions)[number];
    assessment: (typeof assessments)[number];
    q5Score: number;
  };
  const validatedLatestSubmissionByParticipant = new Map<number, ValidatedLatestSubmission>();
  const excludedSubmissionIds = new Set<string>();
  const excludedReasonCounts = {
    questionVersionMismatch: 0,
    q5AssessmentVersionMismatch: 0,
  };

  const answersBySubmission = new Map<string, Map<number, (typeof savedAnswers)[number]>>();
  for (const answer of savedAnswers) {
    const answers =
      answersBySubmission.get(answer.submissionId) ??
      new Map<number, (typeof savedAnswers)[number]>();
    answers.set(answer.questionId, answer);
    answersBySubmission.set(answer.submissionId, answers);
  }

  const q5 = currentQuestions.find((question) => question.key === "it-literacy-005")!;
  const q5Id = q5.id;
  for (const submission of submissions) {
    if (validatedLatestSubmissionByParticipant.has(submission.participantId)) continue;

    const answers = answersBySubmission.get(submission.id);
    const q5Answer = answers?.get(q5Id);
    const hasCurrentQuestionSet =
      submission.questionIds.length === currentQuestions.length &&
      currentQuestions.every((question) => submission.questionIds.includes(question.id));
    const hasCompleteValidAnswers =
      answers !== undefined &&
      answers.size === currentQuestions.length &&
      currentQuestions.every((question) => {
        const answer = answers.get(question.id);
        return question.key === "it-literacy-005"
          ? answer?.answerKind === "legacy" || answer?.answerKind === "freeText"
          : answer?.answerKind === "selected" &&
              answer.selectedIndex !== null &&
              answer.selectedIndex >= 0 &&
              answer.selectedIndex < question.choices.length;
      });
    if (!hasCurrentQuestionSet || !hasCompleteValidAnswers) continue;

    const assessment = assessmentBySubmission.get(submission.id);
    const questionVersionMismatch = !sameVersionMap(
      submission.questionVersions,
      versionMaps.questionVersions,
    );
    const q5AssessmentVersionMismatch =
      assessment !== undefined &&
      (assessment.questionVersion !== q5.questionVersion ||
        assessment.rubricVersion !== versionMaps.rubricVersions[String(q5Id)] ||
        !isSupportedGraderVersionPair(assessment.questionVersion, assessment.rubricVersion));
    if (questionVersionMismatch) excludedReasonCounts.questionVersionMismatch += 1;
    if (q5AssessmentVersionMismatch) excludedReasonCounts.q5AssessmentVersionMismatch += 1;
    if (questionVersionMismatch || q5AssessmentVersionMismatch) {
      excludedSubmissionIds.add(submission.id);
      continue;
    }

    if (q5Answer?.answerKind === "freeText") {
      if (
        !assessment ||
        assessment.revision !== submission.revision ||
        assessment.state !== "graded"
      ) {
        throw new PresentationConflictError(
          "Free-response assessments must finish before results are aggregated",
        );
      }
    } else {
      throw new PresentationConflictError(
        `Submission ${submission.id} has an unsupported legacy Q5 answer; audit or resubmit it before aggregating`,
      );
    }

    validatedLatestSubmissionByParticipant.set(submission.participantId, {
      submission,
      assessment,
      q5Score: Number(assessment.normalizedScore),
    });
  }

  if (validatedLatestSubmissionByParticipant.size === 0 && excludedSubmissionIds.size > 0) {
    return {
      session,
      aggregationSummary: {
        snapshotUpdated: false,
        includedSubmissionCount: 0,
        excludedSubmissionCount: excludedSubmissionIds.size,
        excludedReasonCounts,
      },
    };
  }

  const scored = participants.map((participant) => {
    const validatedLatest = validatedLatestSubmissionByParticipant.get(participant.id);
    const submission = validatedLatest?.submission;
    const answers = submission ? answersBySubmission.get(submission.id) : undefined;
    const validCompleteSet = validatedLatest !== undefined;
    const assessment = validatedLatest?.assessment;
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
        rawScore: question.key === "it-literacy-005" && assessment ? assessment.rawScore : null,
        normalizedScore:
          question.key === "it-literacy-005" && assessment ? assessment.normalizedScore : null,
      };
    });
    const score = validatedLatest
      ? currentQuestions.reduce((sum, question) => {
          if (question.key === "it-literacy-005") return sum + validatedLatest.q5Score;
          return sum + Number(answers?.get(question.id)?.selectedIndex === question.correctIndex);
        }, 0)
      : 0;
    return {
      participant,
      answers: answerSnapshot,
      score,
      isAggregationTarget: validCompleteSet,
    };
  });
  const eligibleScored = scored.filter((entry) => entry.isAggregationTarget);
  eligibleScored.sort(
    (left, right) => right.score - left.score || left.participant.id - right.participant.id,
  );
  let priorScore: number | undefined;
  let priorRank = 0;
  const rankedEligible = eligibleScored.map((entry, index) => {
    if (entry.score !== priorScore) {
      priorRank = index + 1;
      priorScore = entry.score;
    }
    return { ...entry, rank: priorRank };
  });
  const rankByParticipantId = new Map(
    rankedEligible.map((entry) => [entry.participant.id, entry.rank]),
  );
  const ranked = scored.map((entry) => ({
    ...entry,
    rank: rankByParticipantId.get(entry.participant.id) ?? 0,
  }));

  setOperationPhase?.("delete_entries");
  await tx.delete(presentationEntries).where(eq(presentationEntries.sessionId, 1));
  setOperationPhase?.("delete_questions");
  await tx.delete(presentationQuestions).where(eq(presentationQuestions.sessionId, 1));
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
  if (ranked.length) {
    setOperationPhase?.("insert_entries");
    await tx.insert(presentationEntries).values(
      ranked.map(({ participant, score, rank, answers, isAggregationTarget }) => ({
        sessionId: 1,
        participantId: participant.id,
        displayName: participant.displayName,
        score,
        rank,
        isAggregationTarget,
        answers,
      })),
    );
  }
  const invalidQuestionCursor =
    session.questionIndex < 0 || session.questionIndex >= currentQuestions.length;
  const preserveTerminalOrUnstartedState =
    session.state === "not_started" || session.state === "opening" || session.state === "finished";
  const nextState =
    invalidQuestionCursor && !preserveTerminalOrUnstartedState ? "question" : session.state;
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
  return {
    session: snapshottedSession,
    aggregationSummary: {
      snapshotUpdated: true,
      includedSubmissionCount: validatedLatestSubmissionByParticipant.size,
      excludedSubmissionCount: excludedSubmissionIds.size,
      excludedReasonCounts,
    },
  };
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
  // Awards are announced in 3rd, 2nd, 1st order. First place is followed by
  // its prize slide, making that the last existing step when it has winners.
  for (const rank of [1, 2, 3]) {
    const [winner] = await tx
      .select({ participantId: presentationEntries.participantId })
      .from(presentationEntries)
      .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, rank)))
      .limit(1);
    if (winner) return rank === 1 ? ("first_prize" as const) : stageForRank(rank);
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
  if (state === "first") {
    const [winner] = await tx
      .select({ participantId: presentationEntries.participantId })
      .from(presentationEntries)
      .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, 1)))
      .limit(1);
    return { state: winner ? ("first_prize" as const) : "finished", questionIndex };
  }
  if (state === "first_prize") return { state: "finished" as const, questionIndex };
  const currentRank = rankForStage(state);
  if (currentRank !== null) {
    return { state: await nextNonemptyRank(tx, currentRank), questionIndex };
  }
  throw new PresentationConflictError("Presentation cannot advance from its current state");
}

async function previousState(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  state: Exclude<PresentationState, "not_started">,
  questionIndex: number,
  questionCount: number,
): Promise<{ state: PresentationState; questionIndex: number }> {
  switch (state) {
    case "opening":
      throw new PresentationConflictError("Presentation is already at its first state");
    case "question":
      return questionIndex === 0
        ? { state: "opening", questionIndex: 0 }
        : { state: "answer", questionIndex: questionIndex - 1 };
    case "answer":
      return { state: "question", questionIndex };
    case "podium_preview":
      return questionCount > 0
        ? { state: "answer", questionIndex: questionCount - 1 }
        : { state: "opening", questionIndex: 0 };
    case "third":
      return { state: "podium_preview", questionIndex };
    case "second":
    case "first": {
      const currentRank = state === "first" ? 1 : 2;
      for (let rank = currentRank + 1; rank <= 3; rank += 1) {
        const [winner] = await tx
          .select({ participantId: presentationEntries.participantId })
          .from(presentationEntries)
          .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, rank)))
          .limit(1);
        if (winner) return { state: stageForRank(rank), questionIndex };
      }
      return { state: "podium_preview", questionIndex };
    }
    case "first_prize":
      return { state: "first", questionIndex };
    case "finished":
      return {
        state: (await lastAnnouncedRank(tx)) ?? "podium_preview",
        questionIndex,
      };
  }
}

async function isValidPresentationPosition(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  state: PresentationState,
  questionIndex: number,
  session: { questionCount: number; questionIndex: number },
) {
  const knownStates: PresentationState[] = [
    "opening",
    "question",
    "answer",
    "podium_preview",
    "third",
    "second",
    "first",
    "first_prize",
    "finished",
  ];
  if (!knownStates.includes(state) || !Number.isInteger(questionIndex)) return false;
  if (state === "opening") return questionIndex === 0;
  if (state === "question" || state === "answer") {
    return questionIndex >= 0 && questionIndex < session.questionCount;
  }
  if (questionIndex !== Math.max(session.questionCount - 1, 0)) return false;
  if (state === "first_prize") {
    const [winner] = await tx
      .select({ participantId: presentationEntries.participantId })
      .from(presentationEntries)
      .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, 1)))
      .limit(1);
    return Boolean(winner);
  }
  const rank = rankForStage(state);
  if (rank === null) return true;
  const [winner] = await tx
    .select({ participantId: presentationEntries.participantId })
    .from(presentationEntries)
    .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, rank)))
    .limit(1);
  return Boolean(winner);
}

export async function operatePresentation(operationId: string, action: PresentationAction) {
  return operatePresentationWithResponse(operationId, action, readAdminPresentation);
}

export async function operatePresentationControls(
  operationId: string,
  action: PresentationAction,
  expectedSnapshotRevision?: number,
): Promise<AdminPresentationControls & { aggregationSummary?: PresentationAggregationSummary }> {
  return operatePresentationWithResponse(
    operationId,
    action,
    readAdminPresentationControls,
    expectedSnapshotRevision,
  );
}

export async function setPresentationPosition(
  operationId: string,
  state: PresentationState,
  questionIndex: number,
  expectedSnapshotRevision: number,
  expectedSessionVersion: number,
): Promise<AdminPresentationControls> {
  return operatePresentationWithResponse(
    operationId,
    "position",
    readAdminPresentationControls,
    expectedSnapshotRevision,
    { state, questionIndex },
    expectedSessionVersion,
  );
}

async function operatePresentationWithResponse<T>(
  operationId: string,
  action: PresentationAction,
  readResponse: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  expectedSnapshotRevision?: number,
  target?: { state: PresentationState; questionIndex: number },
  expectedSessionVersion?: number,
): Promise<T & { aggregationSummary?: PresentationAggregationSummary }> {
  if (!presentationActions.has(action))
    throw new PresentationConflictError("Unsupported presentation action");
  const operationKey =
    action === "position" && target
      ? `position:${target.state}:${target.questionIndex}:${expectedSessionVersion}:${expectedSnapshotRevision}`
      : action;
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
          if (operation.action !== operationKey)
            throw new PresentationConflictError("Operation ID conflict");
          return {
            ...(await readResponse(tx)),
            ...(action === "aggregate" && operation.aggregationSummary
              ? { aggregationSummary: operation.aggregationSummary }
              : {}),
          } as T & { aggregationSummary?: PresentationAggregationSummary };
        }
        if (
          expectedSnapshotRevision !== undefined &&
          session.snapshotRevision !== expectedSnapshotRevision
        ) {
          throw new PresentationConflictError("Presentation snapshot changed concurrently");
        }
        if (action === "position" && session.version !== expectedSessionVersion) {
          throw new PresentationConflictError("Presentation session version changed concurrently");
        }

        if (action === "start") {
          if (session.state !== "not_started")
            throw new PresentationConflictError("Presentation has already started");
          const version = await startPresentation(tx, session);
          await tx.insert(presentationOperations).values({ operationId, action, version });
          return (await readResponse(tx)) as T & {
            aggregationSummary?: PresentationAggregationSummary;
          };
        }
        if (action === "aggregate") {
          const { session: aggregated, aggregationSummary } = await ensurePresentationSnapshot(
            tx,
            session,
            (nextPhase) => {
              phase = nextPhase;
            },
          );
          phase = "transaction_commit";
          await tx
            .insert(presentationOperations)
            .values({ operationId, action, version: aggregated.version, aggregationSummary });
          return {
            ...(await readResponse(tx)),
            aggregationSummary,
          } as T & { aggregationSummary?: PresentationAggregationSummary };
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
          return (await readResponse(tx)) as T & {
            aggregationSummary?: PresentationAggregationSummary;
          };
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
          return (await readResponse(tx)) as T & {
            aggregationSummary?: PresentationAggregationSummary;
          };
        }
        if (session.state === "not_started")
          throw new PresentationConflictError("Presentation has not started");
        const cursorState = session.state as PresentationState;
        if (
          (action === "advance" || action === "previous") &&
          !supportedPresentationStates.has(cursorState)
        ) {
          throw new PresentationConflictError("Presentation state is invalid");
        }
        if (
          action === "position" &&
          (!target ||
            !(await isValidPresentationPosition(tx, target.state, target.questionIndex, session)))
        ) {
          throw new PresentationConflictError("Invalid presentation position");
        }
        const next =
          action === "position"
            ? target!
            : action === "previous"
              ? await previousState(
                  tx,
                  cursorState as Exclude<PresentationState, "not_started">,
                  session.questionIndex,
                  session.questionCount,
                )
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
          .values({ operationId, action: operationKey, version: session.version + 1 });
        return (await readResponse(tx)) as T & {
          aggregationSummary?: PresentationAggregationSummary;
        };
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
        if (operation.action !== operationKey)
          throw new PresentationConflictError("Operation ID conflict");
        return {
          ...(await readResponse(tx)),
          ...(action === "aggregate" && operation.aggregationSummary
            ? { aggregationSummary: operation.aggregationSummary }
            : {}),
        } as T & { aggregationSummary?: PresentationAggregationSummary };
      }
      throw new PresentationConflictError("Presentation state changed concurrently");
    });
  }
}

async function withTransactionRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSqliteLockRace(error) || attempt >= maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function isSqliteLockRace(error: unknown) {
  for (const value of sqliteCauseObjects(error)) {
    const codes = [value.code, value.extendedCode].filter(
      (code): code is string => typeof code === "string",
    );
    if (
      codes.some((code) => /^SQLITE_BUSY(?:_|$)/.test(code) || /^SQLITE_LOCKED(?:_|$)/.test(code))
    ) {
      return true;
    }
  }
  return false;
}

function isKnownTransactionRace(error: unknown) {
  for (const value of sqliteCauseObjects(error)) {
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
  }
  return false;
}
