import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
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

export type PresentationState =
  | "not_started"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "finished";
export type PresentationMode = "full" | "short";
export type PresentationAction = "start" | "advance" | "previous" | "hide" | "show" | "setMode";

export class PresentationConflictError extends Error {
  readonly status = 409;
}

type AdminPresentation = {
  state: PresentationState;
  version: number;
  questionIndex: number;
  questionCount: number;
  projectionHidden: boolean;
  presentationMode: PresentationMode;
  participantResultsVisible: boolean;
  participantResultsReady: boolean;
  questions: {
    id: number;
    question: string;
    choices: string[];
    correctIndex: number;
    correctAnswer: string;
    explanation: string | null;
    answerType: "selected" | "freeText";
  }[];
  entries: {
    displayName: string;
    score: number;
    rank: number;
    answers?: {
      questionId: number;
      answerKind: "selected" | "freeText" | "legacy" | "unanswered";
      selectedIndex: number | null;
      freeText: string | null;
      rawScore: number | null;
      normalizedScore: number | null;
    }[];
  }[];
};

type PresentationAnswerSnapshot = {
  questionId: number;
  answerKind: "selected" | "freeText" | "legacy" | "unanswered";
  selectedIndex: number | null;
  freeText: string | null;
  rawScore: number | null;
  normalizedScore: number | null;
};

export type ParticipantResultQuestion = {
  position: number;
  question: string;
  answer:
    | { kind: "selected"; value: string; correctness: "correct" | "incorrect" | "unavailable" }
    | { kind: "freeText"; value: string; score: number | null }
    | { kind: "unanswered" }
    | { kind: "legacy" };
};

export type ParticipantResult =
  | { state: "waiting" }
  | { state: "unavailable" }
  | { state: "visible"; score: number; rank: number; questions: ParticipantResultQuestion[] };

function stageForRank(rank: number): PresentationState {
  return rank === 3 ? "third" : rank === 2 ? "second" : "first";
}

function rankForStage(state: PresentationState) {
  return state === "third" ? 3 : state === "second" ? 2 : state === "first" ? 1 : null;
}

async function readAdminPresentation(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const [session] = await tx
    .select()
    .from(presentationSessions)
    .where(eq(presentationSessions.id, 1));
  if (!session) {
    const [resultSettings] = await tx
      .select({ visible: participantResultSettings.visible })
      .from(participantResultSettings)
      .where(eq(participantResultSettings.id, 1));
    return {
      state: "not_started",
      version: 0,
      questionIndex: 0,
      questionCount: 0,
      projectionHidden: false,
      presentationMode: "full",
      participantResultsVisible: resultSettings?.visible ?? false,
      participantResultsReady: false,
      questions: [],
      entries: [],
    } satisfies AdminPresentation;
  }
  const [questions, entries] = await Promise.all([
    tx
      .select()
      .from(presentationQuestions)
      .where(eq(presentationQuestions.sessionId, 1))
      .orderBy(asc(presentationQuestions.position)),
    tx
      .select()
      .from(presentationEntries)
      .where(eq(presentationEntries.sessionId, 1))
      .orderBy(asc(presentationEntries.rank), asc(presentationEntries.displayName)),
  ]);
  const [resultSettings] = await tx
    .select({ visible: participantResultSettings.visible })
    .from(participantResultSettings)
    .where(eq(participantResultSettings.id, 1));
  return {
    state: session.state as PresentationState,
    version: session.version,
    questionIndex: session.questionIndex,
    questionCount: session.questionCount,
    projectionHidden: session.projectionHidden,
    presentationMode: session.presentationMode as PresentationMode,
    participantResultsVisible: resultSettings?.visible ?? false,
    participantResultsReady:
      session.state !== "not_started" || questions.length > 0 || entries.length > 0,
    questions: questions.map((question) => ({
      id: question.sourceQuestionId,
      question: question.question,
      choices: question.choices,
      correctIndex: question.correctIndex,
      correctAnswer: question.choices[question.correctIndex] ?? "",
      explanation: question.explanation,
      answerType: question.choices.length === 0 ? ("freeText" as const) : ("selected" as const),
    })),
    entries: entries.map(({ displayName, score, rank, answers }) => ({
      displayName,
      score,
      rank,
      answers,
    })),
  } satisfies AdminPresentation;
}

export async function setParticipantResultsVisible(visible: boolean) {
  return withTransactionRetry(() =>
    db.transaction(async (tx) => {
      if (visible) {
        await ensurePresentationSnapshot(tx);
      }
      await tx
        .insert(participantResultSettings)
        .values({ id: 1, visible })
        .onConflictDoUpdate({ target: participantResultSettings.id, set: { visible } });
      return { visible };
    }),
  );
}

export async function getParticipantResult(participantId: number): Promise<ParticipantResult> {
  return db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ visible: participantResultSettings.visible })
      .from(participantResultSettings)
      .where(eq(participantResultSettings.id, 1));
    if (!settings?.visible) {
      return { state: "waiting" as const };
    }
    const [entry] = await tx
      .select({
        score: presentationEntries.score,
        rank: presentationEntries.rank,
        answers: presentationEntries.answers,
      })
      .from(presentationEntries)
      .where(
        and(
          eq(presentationEntries.sessionId, 1),
          eq(presentationEntries.participantId, participantId),
        ),
      );
    if (!entry) return { state: "unavailable" as const };
    const questionRows = await tx
      .select()
      .from(presentationQuestions)
      .where(eq(presentationQuestions.sessionId, 1))
      .orderBy(asc(presentationQuestions.position));
    if (
      !Number.isFinite(entry.score) ||
      entry.score < 0 ||
      entry.score > questionRows.length ||
      !Number.isInteger(entry.rank) ||
      entry.rank < 1 ||
      questionRows.length === 0 ||
      !Array.isArray(entry.answers) ||
      entry.answers.length !== questionRows.length
    ) {
      return { state: "unavailable" as const };
    }

    const answerByQuestionId = new Map<number, PresentationAnswerSnapshot>();
    const questionIds = new Set<number>();
    const positions = new Set<number>();
    for (const [index, question] of questionRows.entries()) {
      if (
        !Number.isInteger(question.position) ||
        question.position !== index ||
        positions.has(question.position) ||
        !Number.isInteger(question.sourceQuestionId) ||
        questionIds.has(question.sourceQuestionId)
      ) {
        return { state: "unavailable" as const };
      }
      positions.add(question.position);
      questionIds.add(question.sourceQuestionId);
    }
    for (const item of entry.answers as unknown[]) {
      if (
        !item ||
        typeof item !== "object" ||
        !("questionId" in item) ||
        typeof item.questionId !== "number" ||
        !Number.isInteger(item.questionId) ||
        !("answerKind" in item) ||
        !["selected", "freeText", "legacy", "unanswered"].includes(String(item.answerKind)) ||
        answerByQuestionId.has(item.questionId as number)
      ) {
        return { state: "unavailable" as const };
      }
      answerByQuestionId.set(item.questionId as number, item as PresentationAnswerSnapshot);
    }

    const questions: ParticipantResultQuestion[] = [];
    for (const question of questionRows) {
      const answer = answerByQuestionId.get(question.sourceQuestionId);
      if (
        !answer ||
        typeof question.question !== "string" ||
        !Array.isArray(question.choices) ||
        !Array.from(question.choices).every((choice) => typeof choice === "string")
      ) {
        return { state: "unavailable" as const };
      }
      let answerDto: ParticipantResultQuestion["answer"];
      if (answer.answerKind === "selected") {
        if (question.choices.length === 0) return { state: "unavailable" as const };
        const selectedIndex = answer.selectedIndex;
        const validCorrectIndex =
          Number.isInteger(question.correctIndex) &&
          question.correctIndex >= 0 &&
          question.correctIndex < question.choices.length;
        if (
          !validCorrectIndex ||
          !Number.isInteger(selectedIndex) ||
          selectedIndex === null ||
          selectedIndex < 0 ||
          selectedIndex >= question.choices.length
        ) {
          answerDto = { kind: "selected", value: "", correctness: "unavailable" };
        } else {
          answerDto = {
            kind: "selected",
            value: question.choices[selectedIndex],
            correctness: selectedIndex === question.correctIndex ? "correct" : "incorrect",
          };
        }
      } else if (answer.answerKind === "freeText") {
        if (question.choices.length > 0) return { state: "unavailable" as const };
        if (typeof answer.freeText !== "string") return { state: "unavailable" as const };
        const score = answer.normalizedScore;
        if (score !== null && (!Number.isFinite(score) || score < 0 || score > 1)) {
          return { state: "unavailable" as const };
        }
        answerDto = { kind: "freeText", value: answer.freeText, score };
      } else if (answer.answerKind === "legacy") {
        // The historical legacy answer is the final free-response question:
        // its original choices are no longer in the snapshot, but its old
        // selected index is retained without interpreting it.
        if (
          question.position !== questionRows.length - 1 ||
          question.choices.length !== 0 ||
          !Number.isInteger(answer.selectedIndex) ||
          answer.selectedIndex === null ||
          answer.selectedIndex < 0 ||
          answer.freeText !== null ||
          answer.rawScore !== null ||
          answer.normalizedScore !== null
        ) {
          return { state: "unavailable" as const };
        }
        answerDto = { kind: "legacy" };
      } else {
        answerDto = { kind: "unanswered" };
      }
      questions.push({
        position: question.position,
        question: question.question,
        answer: answerDto,
      });
    }
    return { state: "visible" as const, score: entry.score, rank: entry.rank, questions };
  });
}
export async function getAdminPresentation() {
  return db.transaction((tx) => readAdminPresentation(tx));
}

export async function getPublicPresentation() {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ projectionHidden: presentationSessions.projectionHidden })
      .from(presentationSessions)
      .where(eq(presentationSessions.id, 1));
    if (session?.projectionHidden) return { state: "standby" };
    const admin = await readAdminPresentation(tx);
    if (admin.state === "question" || admin.state === "answer") {
      const row = admin.questions[admin.questionIndex];
      if (!row) return { state: admin.state };
      const question = {
        id: row.id,
        ordinal: admin.questionIndex + 1,
        total: admin.questionCount,
        question: row.question,
        choices: row.choices,
        answerType: row.answerType,
        ...(admin.state === "answer"
          ? row.answerType === "freeText"
            ? {
                expectedAnswer: row.explanation,
                responses: admin.entries.map((entry) => {
                  const answer = entry.answers?.find((item) => item.questionId === row.id);
                  return {
                    displayName: entry.displayName,
                    answer: answer?.freeText,
                    answerKind: answer?.answerKind ?? "unanswered",
                    similarity: answer?.rawScore,
                    score: answer?.normalizedScore,
                  };
                }),
              }
            : {
                correctAnswer: row.correctAnswer,
                correctIndex: row.correctIndex,
                ...(admin.presentationMode === "full" ? { explanation: row.explanation } : {}),
              }
          : {}),
      };
      return { state: admin.state, question };
    }
    const rank = rankForStage(admin.state);
    if (rank !== null) {
      const winners = admin.entries
        .filter((entry) => entry.rank === rank)
        .map(({ displayName, score, rank: winnerRank }) => ({
          displayName,
          score,
          rank: winnerRank,
        }));
      return { state: admin.state, winners };
    }
    return { state: admin.state };
  });
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
      presentationMode: "full",
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
  const previousSession = await ensurePresentationSnapshot(tx, acquiredSession, true);
  const state: PresentationState = previousSession.questionCount ? "question" : "podium_preview";
  const version = previousSession.version + 1;
  const updated = await tx
    .update(presentationSessions)
    .set({ state, version, questionIndex: 0 })
    .where(
      and(
        eq(presentationSessions.id, 1),
        eq(presentationSessions.version, previousSession.version),
      ),
    )
    .returning({ id: presentationSessions.id });
  if (!updated.length)
    throw new PresentationConflictError("Presentation state changed concurrently");
  return version;
}

async function ensurePresentationSnapshot(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  acquiredSession?: typeof presentationSessions.$inferSelect,
  allowEmptyQuestions = false,
): Promise<typeof presentationSessions.$inferSelect> {
  const session = acquiredSession ?? (await acquirePresentationSession(tx));
  const [snapshotQuestion] = await tx
    .select({ position: presentationQuestions.position })
    .from(presentationQuestions)
    .where(eq(presentationQuestions.sessionId, 1))
    .limit(1);
  const [snapshotEntry] = await tx
    .select({ participantId: presentationEntries.participantId })
    .from(presentationEntries)
    .where(eq(presentationEntries.sessionId, 1))
    .limit(1);
  if (snapshotQuestion || snapshotEntry) return session;
  // A started session proves that start already froze the snapshot, even when
  // that snapshot legitimately contains no question or participant rows.
  if (session.state !== "not_started") return session;

  const currentQuestions = await tx.select().from(examQuestions).orderBy(asc(examQuestions.id));
  if (!currentQuestions.length) {
    if (!allowEmptyQuestions) throw new PresentationConflictError("Results are not ready");
  }

  const participants = await tx.select().from(examParticipants).orderBy(asc(examParticipants.id));
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
  const savedAnswers = submissionIds.length
    ? await tx
        .select()
        .from(examSubmissionAnswers)
        .where(inArray(examSubmissionAnswers.submissionId, submissionIds))
    : [];
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
          "Free-response assessments must finish before presentation starts",
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

  if (currentQuestions.length) {
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
  await tx
    .update(presentationSessions)
    .set({ questionCount: currentQuestions.length })
    .where(eq(presentationSessions.id, 1));
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
  if (state === "question" && questionIndex > 0) {
    return { state: "answer" as const, questionIndex: questionIndex - 1 };
  }
  if (state === "answer") return { state: "question" as const, questionIndex };
  if (state === "podium_preview" && questionCount > 0) {
    return { state: "answer" as const, questionIndex: questionCount - 1 };
  }
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

export async function operatePresentation(
  operationId: string,
  action: PresentationAction,
  requestedMode?: PresentationMode,
) {
  if (action === "setMode" && requestedMode !== "full" && requestedMode !== "short") {
    throw new PresentationConflictError("Presentation mode is required");
  }
  try {
    return await withTransactionRetry(() =>
      db.transaction(async (tx) => {
        const session = await acquirePresentationSession(tx);
        const [operation] = await tx
          .select()
          .from(presentationOperations)
          .where(eq(presentationOperations.operationId, operationId));
        if (operation) {
          if (
            operation.action !== action ||
            (action === "setMode" && operation.mode !== requestedMode)
          )
            throw new PresentationConflictError("Operation ID conflict");
          return readAdminPresentation(tx);
        }

        if (action === "start") {
          if (session.state !== "not_started")
            throw new PresentationConflictError("Presentation has already started");
          const version = await startPresentation(tx, session);
          await tx.insert(presentationOperations).values({ operationId, action, version });
          return readAdminPresentation(tx);
        }
        if (action === "setMode") {
          const presentationMode = requestedMode!;
          if (!session) {
            await tx.insert(presentationSessions).values({
              id: 1,
              state: "not_started",
              version: 1,
              questionIndex: 0,
              questionCount: 0,
              projectionHidden: false,
              presentationMode,
            });
            await tx
              .insert(presentationOperations)
              .values({ operationId, action, mode: presentationMode, version: 1 });
            return readAdminPresentation(tx);
          }
          const version = session.version + 1;
          const changed = await tx
            .update(presentationSessions)
            .set({ presentationMode, version })
            .where(
              and(
                eq(presentationSessions.id, 1),
                eq(presentationSessions.version, session.version),
              ),
            )
            .returning({ id: presentationSessions.id });
          if (!changed.length)
            throw new PresentationConflictError("Presentation state changed concurrently");
          await tx
            .insert(presentationOperations)
            .values({ operationId, action, mode: presentationMode, version });
          return readAdminPresentation(tx);
        }
        if (action === "hide" || action === "show") {
          const projectionHidden = action === "hide";
          if (!session) {
            await tx.insert(presentationSessions).values({
              id: 1,
              state: "not_started",
              version: 1,
              questionIndex: 0,
              questionCount: 0,
              projectionHidden,
            });
            await tx.insert(presentationOperations).values({ operationId, action, version: 1 });
            return readAdminPresentation(tx);
          }
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
          return readAdminPresentation(tx);
        }
        if (!session || session.state === "not_started")
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
        return readAdminPresentation(tx);
      }),
    );
  } catch (error) {
    // Lock contention is retried by starting a fresh transaction above. If all
    // attempts are exhausted, preserve the database error for the caller.
    if (isSqliteLockRace(error)) throw error;
    if (!isKnownTransactionRace(error)) throw error;
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(presentationOperations)
        .where(eq(presentationOperations.operationId, operationId));
      if (operation) {
        if (
          operation.action !== action ||
          (action === "setMode" && operation.mode !== requestedMode)
        )
          throw new PresentationConflictError("Operation ID conflict");
        return readAdminPresentation(tx);
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
      codes.some((code) => /^SQLITE_BUSY(?:_|$)/.test(code) || /^SQLITE_LOCKED(?:_|$)/.test(code))
    ) {
      return true;
    }
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
