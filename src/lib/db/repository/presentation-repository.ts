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

export type PresentationState =
  | "not_started"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "finished";
export type PresentationAction =
  | "start"
  | "advance"
  | "previous"
  | "hide"
  | "show"
  | "aggregate"
  | "reset";
const presentationActions = new Set<string>([
  "start",
  "advance",
  "previous",
  "hide",
  "show",
  "aggregate",
  "reset",
]);

export class PresentationConflictError extends Error {
  readonly status = 409;
}

type AdminPresentation = {
  state: PresentationState;
  version: number;
  snapshotRevision: number;
  questionIndex: number;
  questionCount: number;
  projectionHidden: boolean;
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

export type AdminPresentationControls = Pick<
  AdminPresentation,
  "state" | "version" | "snapshotRevision" | "questionIndex" | "questionCount" | "projectionHidden"
>;

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
      snapshotRevision: 0,
      questionIndex: 0,
      questionCount: 0,
      projectionHidden: false,
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
    snapshotRevision: session.snapshotRevision,
    questionIndex: session.questionIndex,
    questionCount: session.questionCount,
    projectionHidden: session.projectionHidden,
    participantResultsVisible: resultSettings?.visible ?? false,
    participantResultsReady:
      session.snapshotRevision > 0 &&
      (session.questionCount > 0 || session.state !== "not_started"),
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
    const answerByQuestionId = new Map<number, PresentationAnswerSnapshot>();
    for (const item of entry.answers as unknown[]) {
      if (
        !item ||
        typeof item !== "object" ||
        !("questionId" in item) ||
        typeof item.questionId !== "number" ||
        !Number.isInteger(item.questionId) ||
        !questionIds.has(item.questionId) ||
        !("answerKind" in item) ||
        !["selected", "freeText", "legacy", "unanswered"].includes(String(item.answerKind)) ||
        answerByQuestionId.has(item.questionId)
      ) {
        return { state: "unavailable" as const };
      }
      answerByQuestionId.set(item.questionId, item as PresentationAnswerSnapshot);
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

export async function getAdminPresentationControls() {
  return db.transaction(readAdminPresentationControls);
}

async function readAdminPresentationControls(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<AdminPresentationControls> {
  const [session] = await tx
    .select({
      state: presentationSessions.state,
      version: presentationSessions.version,
      snapshotRevision: presentationSessions.snapshotRevision,
      questionIndex: presentationSessions.questionIndex,
      questionCount: presentationSessions.questionCount,
      projectionHidden: presentationSessions.projectionHidden,
    })
    .from(presentationSessions)
    .where(eq(presentationSessions.id, 1));
  const fallback: AdminPresentationControls = {
    state: "not_started",
    version: 0,
    snapshotRevision: 0,
    questionIndex: 0,
    questionCount: 0,
    projectionHidden: false,
  };
  return session ? { ...session, state: session.state as PresentationState } : fallback;
}

type PublicProjection =
  | { state: "question"; question?: PublicProjectedQuestion }
  | { state: "answer"; question?: PublicProjectedQuestion }
  | { state: "third" | "second" | "first"; winners: Winner[]; question?: PublicProjectedQuestion }
  | {
      state: Exclude<PresentationState, "question" | "answer" | "third" | "second" | "first">;
      question?: PublicProjectedQuestion;
    };

type Winner = { displayName: string; score: number; rank: number };
type PublicProjectedQuestion = {
  id: number;
  ordinal: number;
  total: number;
  question: string;
  choices: string[];
  answerType: "selected" | "freeText";
  correctAnswer?: string;
  correctIndex?: number;
  explanation?: string | null;
  expectedAnswer?: string | null;
  responses?: {
    displayName: string;
    answer: string | null | undefined;
    answerKind: "selected" | "freeText" | "legacy" | "unanswered";
    similarity: number | null | undefined;
    score: number | null | undefined;
  }[];
};

function buildPublicProjection(
  admin: AdminPresentation,
  state: PresentationState,
  questionIndex: number,
  sourceQuestions: Map<number, { key: string; explanation: string | null }>,
): PublicProjection {
  if (state === "question" || state === "answer") {
    const row = admin.questions[questionIndex];
    if (!row) return { state };
    const sourceQuestion = sourceQuestions.get(row.id);
    const explanation = row.explanation?.trim() ? row.explanation : sourceQuestion?.explanation;
    const question = {
      id: row.id,
      ordinal: questionIndex + 1,
      total: admin.questionCount,
      question: row.question,
      choices: row.choices,
      answerType: row.answerType,
      ...(state === "answer"
        ? row.answerType === "freeText"
          ? {
              expectedAnswer: explanation,
              ...(sourceQuestion?.key === "it-literacy-005"
                ? {}
                : {
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
                  }),
            }
          : {
              correctAnswer: row.correctAnswer,
              correctIndex: row.correctIndex,
              explanation,
            }
        : {}),
    };
    return { state, question };
  }
  const rank = rankForStage(state);
  if (rank !== null) {
    const winners = admin.entries
      .filter((entry) => entry.rank === rank)
      .map(({ displayName, score, rank: winnerRank }) => ({
        displayName,
        score,
        rank: winnerRank,
      }));
    return { state, winners };
  }
  return {
    state: state as Exclude<
      PresentationState,
      "question" | "answer" | "third" | "second" | "first"
    >,
  };
}

export async function getAdminPresentationDeck() {
  return db.transaction(async (tx) => {
    const admin = await readAdminPresentation(tx);
    const questionIds = admin.questions.map(({ id }) => id);
    const sourceRows = questionIds.length
      ? await tx
          .select({
            id: examQuestions.id,
            key: examQuestions.key,
            explanation: examQuestions.explanation,
          })
          .from(examQuestions)
          .where(inArray(examQuestions.id, questionIds))
      : [];
    const sourceQuestions = new Map(
      sourceRows.map(({ id, key, explanation }) => [id, { key, explanation }]),
    );
    const slides: {
      state: PresentationState;
      questionIndex: number;
      projection: PublicProjection;
    }[] = [];
    for (let index = 0; index < admin.questionCount; index += 1) {
      slides.push(
        {
          state: "question",
          questionIndex: index,
          projection: buildPublicProjection(admin, "question", index, sourceQuestions),
        },
        {
          state: "answer",
          questionIndex: index,
          projection: buildPublicProjection(admin, "answer", index, sourceQuestions),
        },
      );
    }
    slides.push({
      state: "podium_preview",
      questionIndex: admin.questionIndex,
      projection: buildPublicProjection(
        admin,
        "podium_preview",
        admin.questionIndex,
        sourceQuestions,
      ),
    });
    for (const [state, rank] of [
      ["third", 3],
      ["second", 2],
      ["first", 1],
    ] as const) {
      if (admin.entries.some((entry) => entry.rank === rank)) {
        slides.push({
          state,
          questionIndex: admin.questionIndex,
          projection: buildPublicProjection(admin, state, admin.questionIndex, sourceQuestions),
        });
      }
    }
    slides.push({
      state: "finished",
      questionIndex: admin.questionIndex,
      projection: buildPublicProjection(admin, "finished", admin.questionIndex, sourceQuestions),
    });
    return {
      snapshotRevision: admin.snapshotRevision,
      questionCount: admin.questionCount,
      questionIndex: admin.questionIndex,
      slides,
    };
  });
}

export async function getPublicPresentation(): Promise<
  PublicProjection | { state: "standby"; question?: PublicProjectedQuestion }
> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ projectionHidden: presentationSessions.projectionHidden })
      .from(presentationSessions)
      .where(eq(presentationSessions.id, 1));
    if (session?.projectionHidden) return { state: "standby" };
    const admin = await readAdminPresentation(tx);
    let sourceQuestions = new Map<number, { key: string; explanation: string | null }>();
    if (admin.state === "answer") {
      // Snapshot IDs are not foreign-keyed. Resolve source data in one batch
      // for legacy snapshots with an empty explanation and free-text privacy.
      const rows = await tx
        .select({
          id: examQuestions.id,
          key: examQuestions.key,
          explanation: examQuestions.explanation,
        })
        .from(examQuestions)
        .where(
          inArray(
            examQuestions.id,
            admin.questions.map(({ id }) => id),
          ),
        );
      sourceQuestions = new Map(rows.map(({ id, key, explanation }) => [id, { key, explanation }]));
    }
    return buildPublicProjection(admin, admin.state, admin.questionIndex, sourceQuestions);
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
  const state: PresentationState = acquiredSession.questionCount ? "question" : "podium_preview";
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
    session.state === "not_started" || session.state === "finished";
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
          const state: PresentationState = session.questionCount ? "question" : "podium_preview";
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
