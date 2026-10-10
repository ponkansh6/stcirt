import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  examQuestions,
  presentationEntries,
  presentationQuestions,
  presentationSessions,
  participantResultSettings,
} from "@/lib/db/schema";

export type PresentationState =
  | "not_started"
  | "opening"
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

export type PresentationAnswerSnapshot = {
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

export function stageForRank(rank: number): PresentationState {
  return rank === 3 ? "third" : rank === 2 ? "second" : "first";
}

export function rankForStage(state: PresentationState) {
  return state === "third" ? 3 : state === "second" ? 2 : state === "first" ? 1 : null;
}

export async function readAdminPresentation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
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

export async function readAdminPresentationControls(
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

type WinnerQuestionResult = {
  position: number;
  question: string | null;
  answer:
    | { kind: "selected"; value: string | null }
    | { kind: "freeText"; value: string | null }
    | { kind: "unanswered" }
    | { kind: "legacy" }
    | { kind: "unavailable" };
  correctness?: "correct" | "incorrect" | "unavailable";
  normalizedScore?: number | null;
  scoreStatus?: "unavailable";
};
type Winner = {
  displayName: string;
  score: number;
  rank: number;
  questionResults: WinnerQuestionResult[];
};
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
  admin: Pick<
    AdminPresentation,
    "state" | "questionIndex" | "questionCount" | "questions" | "entries"
  >,
  state: PresentationState,
  questionIndex: number,
  sourceQuestions: Map<number, { key: string; explanation: string | null }>,
  currentQuestion?: AdminPresentation["questions"][number],
): PublicProjection {
  if (state === "question" || state === "answer") {
    const row = currentQuestion ?? admin.questions[questionIndex];
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
      .map((entry) => ({
        displayName: entry.displayName,
        score: entry.score,
        rank: entry.rank,
        questionResults: admin.questions.map((question, position): WinnerQuestionResult => {
          const answer = entry.answers?.find((item) => item.questionId === question.id);
          const validQuestion =
            typeof question.question === "string" &&
            Array.isArray(question.choices) &&
            question.choices.every((choice) => typeof choice === "string");
          const questionText = validQuestion ? question.question : null;
          const unavailable = {
            position,
            question: questionText,
            answer: { kind: "unavailable" as const },
          };
          if (!answer || !validQuestion) return unavailable;
          if (answer.answerKind === "selected") {
            const selectedIndex = answer.selectedIndex;
            const correctIndex = question.correctIndex;
            const selectedValid =
              Number.isInteger(selectedIndex) &&
              selectedIndex !== null &&
              selectedIndex >= 0 &&
              selectedIndex < question.choices.length;
            const correctValid =
              Number.isInteger(correctIndex) &&
              correctIndex >= 0 &&
              correctIndex < question.choices.length;
            return {
              position,
              question: questionText,
              answer: {
                kind: "selected",
                value: selectedValid ? question.choices[selectedIndex as number] : null,
              },
              correctness:
                selectedValid && correctValid
                  ? selectedIndex === correctIndex
                    ? "correct"
                    : "incorrect"
                  : "unavailable",
            };
          }
          if (answer.answerKind === "freeText") {
            const isFifthQuestion = sourceQuestions.get(question.id)?.key === "it-literacy-005";
            const score = answer.normalizedScore;
            const validScore =
              score === null || (Number.isFinite(score) && score >= 0 && score <= 1);
            return {
              position,
              question: questionText,
              answer: {
                kind: "freeText",
                value: typeof answer.freeText === "string" ? answer.freeText : null,
              },
              ...(isFifthQuestion && validScore ? { normalizedScore: score } : {}),
              ...(!validScore || !isFifthQuestion ? { scoreStatus: "unavailable" as const } : {}),
            };
          }
          if (answer.answerKind === "unanswered") {
            return {
              position,
              question: questionText,
              answer: { kind: "unanswered" },
            };
          }
          if (answer.answerKind === "legacy") {
            return {
              position,
              question: questionText,
              answer: { kind: "legacy" },
            };
          }
          return unavailable;
        }),
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
    slides.push({
      state: "opening",
      questionIndex: 0,
      projection: buildPublicProjection(admin, "opening", 0, sourceQuestions),
    });
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
      .select({
        state: presentationSessions.state,
        questionIndex: presentationSessions.questionIndex,
        questionCount: presentationSessions.questionCount,
        projectionHidden: presentationSessions.projectionHidden,
      })
      .from(presentationSessions)
      .where(eq(presentationSessions.id, 1));
    if (session?.projectionHidden) return { state: "standby" };
    const state = (session?.state ?? "not_started") as PresentationState;
    const questionIndex = session?.questionIndex ?? 0;
    const questionCount = session?.questionCount ?? 0;
    const rank = rankForStage(state);
    const activeQuestion = state === "question" || state === "answer";
    let questions: AdminPresentation["questions"];
    if (state === "answer") {
      const rows = await tx
        .select({
          sourceQuestionId: presentationQuestions.sourceQuestionId,
          question: presentationQuestions.question,
          choices: presentationQuestions.choices,
          correctIndex: presentationQuestions.correctIndex,
          explanation: presentationQuestions.explanation,
        })
        .from(presentationQuestions)
        .where(
          and(
            eq(presentationQuestions.sessionId, 1),
            eq(presentationQuestions.position, questionIndex),
          ),
        );
      questions = rows.map((row) => ({
        id: row.sourceQuestionId,
        question: row.question,
        choices: row.choices,
        correctIndex: row.correctIndex,
        correctAnswer: row.choices[row.correctIndex] ?? "",
        explanation: row.explanation,
        answerType: row.choices.length === 0 ? ("freeText" as const) : ("selected" as const),
      }));
    } else if (state === "question") {
      const rows = await tx
        .select({
          sourceQuestionId: presentationQuestions.sourceQuestionId,
          question: presentationQuestions.question,
          choices: presentationQuestions.choices,
        })
        .from(presentationQuestions)
        .where(
          and(
            eq(presentationQuestions.sessionId, 1),
            eq(presentationQuestions.position, questionIndex),
          ),
        );
      questions = rows.map((row) => ({
        id: row.sourceQuestionId,
        question: row.question,
        choices: row.choices,
        correctIndex: 0,
        correctAnswer: row.choices[0] ?? "",
        explanation: null,
        answerType: row.choices.length === 0 ? ("freeText" as const) : ("selected" as const),
      }));
    } else if (rank !== null) {
      const rows = await tx
        .select({
          sourceQuestionId: presentationQuestions.sourceQuestionId,
          question: presentationQuestions.question,
          choices: presentationQuestions.choices,
          correctIndex: presentationQuestions.correctIndex,
        })
        .from(presentationQuestions)
        .where(eq(presentationQuestions.sessionId, 1))
        .orderBy(asc(presentationQuestions.position));
      questions = rows.map((row) => ({
        id: row.sourceQuestionId,
        question: row.question,
        choices: row.choices,
        correctIndex: row.correctIndex,
        correctAnswer: row.choices[row.correctIndex] ?? "",
        explanation: null,
        answerType: row.choices.length === 0 ? ("freeText" as const) : ("selected" as const),
      }));
    } else {
      questions = [];
    }
    const admin = {
      state,
      questionIndex,
      questionCount,
      questions: activeQuestion ? [] : questions,
      entries: [] as AdminPresentation["entries"],
    };
    let sourceQuestions = new Map<number, { key: string; explanation: string | null }>();
    if ((state === "answer" || rank !== null) && questions.length > 0) {
      // Snapshot IDs are not foreign-keyed. Resolve only this stage's questions
      // for legacy explanation fallback, Q5 privacy, and winner score identity.
      if (state === "answer") {
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
              questions.map(({ id }) => id),
            ),
          );
        sourceQuestions = new Map(
          rows.map(({ id, key, explanation }) => [id, { key, explanation }]),
        );
      } else {
        const rows = await tx
          .select({ id: examQuestions.id, key: examQuestions.key })
          .from(examQuestions)
          .where(
            inArray(
              examQuestions.id,
              questions.map(({ id }) => id),
            ),
          );
        sourceQuestions = new Map(rows.map(({ id, key }) => [id, { key, explanation: null }]));
      }
    }
    const currentQuestion = activeQuestion ? questions[0] : undefined;
    if (
      state === "answer" &&
      currentQuestion?.answerType === "freeText" &&
      sourceQuestions.get(currentQuestion.id)?.key !== "it-literacy-005"
    ) {
      const entryRows = await tx
        .select({
          displayName: presentationEntries.displayName,
          answers: presentationEntries.answers,
          rank: presentationEntries.rank,
        })
        .from(presentationEntries)
        .where(eq(presentationEntries.sessionId, 1))
        .orderBy(asc(presentationEntries.rank), asc(presentationEntries.displayName));
      admin.entries = entryRows.map((entry) => ({ ...entry, score: 0 }));
    } else if (rank !== null) {
      const entryRows = await tx
        .select({
          displayName: presentationEntries.displayName,
          score: presentationEntries.score,
          rank: presentationEntries.rank,
          answers: presentationEntries.answers,
        })
        .from(presentationEntries)
        .where(and(eq(presentationEntries.sessionId, 1), eq(presentationEntries.rank, rank)))
        .orderBy(asc(presentationEntries.rank), asc(presentationEntries.displayName));
      admin.entries = entryRows;
    }
    return buildPublicProjection(admin, state, questionIndex, sourceQuestions, currentQuestion);
  });
}
