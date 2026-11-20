import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { isValidFreeTextParts, normalizeSelectedChoiceIndices } from "./answer-repository";
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
  | "statistics"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "third_prize"
  | "second_prize"
  | "first_prize"
  | "finished";
export type PresentationAction =
  | "start"
  | "advance"
  | "previous"
  | "position"
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
    sourceQuestionKey: string | null;
    question: string;
    choices: string[];
    correctIndex: number;
    correctIndices: number[] | null;
    selectionMode: "single" | "multiple" | null;
    correctAnswer: string;
    explanation: string | null;
    answerType: "selected" | "freeText";
  }[];
  entries: {
    displayName: string;
    score: number;
    rank: number | null;
    isAggregationTarget: boolean;
    isReference: boolean;
    answers: {
      questionId: number;
      answerKind: "selected" | "freeText" | "legacy" | "unanswered";
      selectedIndex: number | null;
      selectedIndices?: number[] | null;
      freeText: string | null;
      freeTextParts?: { a: string; b: string };
      rawScore: number | null;
      normalizedScore: number | null;
    }[];
  }[];
};

function isQ5TextParts(value: unknown): value is { a: string; b: string } {
  return isValidFreeTextParts(value);
}

export type AdminPresentationControls = Pick<
  AdminPresentation,
  "state" | "version" | "snapshotRevision" | "questionIndex" | "questionCount" | "projectionHidden"
>;

export type PresentationAnswerSnapshot = {
  questionId: number;
  answerKind: "selected" | "freeText" | "legacy" | "unanswered";
  selectedIndex: number | null;
  selectedIndices?: number[] | null;
  freeText: string | null;
  freeTextParts?: { a: string; b: string };
  rawScore: number | null;
  normalizedScore: number | null;
};

export type ParticipantResultQuestion = {
  position: number;
  question: string;
  answer:
    | { kind: "selected"; value: string; correctness: "correct" | "incorrect" | "unavailable" }
    | { kind: "freeText"; value: string; score: number | null; parts?: { a: string; b: string } }
    | { kind: "unanswered" }
    | { kind: "legacy" };
};

export type ParticipantResult =
  | { state: "waiting" }
  | { state: "unavailable" }
  | {
      state: "visible";
      score: number;
      maxScore: number;
      rank: number | null;
      isAggregationTarget: boolean;
      isReference: boolean;
      equivalentRank: number | null;
      participantCount: number;
      rankParticipantCount: number;
      questions: ParticipantResultQuestion[];
    };

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
      sourceQuestionKey: question.sourceQuestionKey,
      question: question.question,
      choices: question.choices,
      correctIndex: question.correctIndex,
      correctIndices: question.correctIndices,
      selectionMode: question.selectionMode,
      correctAnswer: (question.correctIndices ?? [question.correctIndex])
        .map((i) => question.choices[i])
        .filter(Boolean)
        .join("、"),
      explanation: question.explanation,
      answerType: question.choices.length === 0 ? ("freeText" as const) : ("selected" as const),
    })),
    entries: entries.map(
      ({ displayName, score, rank, isAggregationTarget, isReference, answers }) => ({
        displayName,
        score,
        rank: isAggregationTarget && !isReference ? rank : null,
        isAggregationTarget,
        isReference,
        answers,
      }),
    ),
  } satisfies AdminPresentation;
}

type ParticipantResultPublicationState = "unavailable" | "published";

function participantResultPublicationState(hasEntry: boolean): ParticipantResultPublicationState {
  return hasEntry ? "published" : "unavailable";
}

function isValidParticipantResultSnapshot(
  entry: {
    score: number;
    rank: number | null;
    isAggregationTarget: boolean;
    isReference: boolean;
    equivalentRank: number | null;
    answers: unknown;
  },
  questionRows: Pick<
    typeof presentationQuestions.$inferSelect,
    "position" | "sourceQuestionId" | "question" | "choices" | "correctIndex" | "correctIndices"
  >[],
  participantCount: number,
  rankParticipantCount: number,
): boolean {
  if (
    !Number.isFinite(entry.score) ||
    entry.score < 0 ||
    entry.score > questionRows.length + 1 ||
    (entry.isAggregationTarget &&
      entry.isReference &&
      (entry.rank !== null ||
        !Number.isInteger(entry.equivalentRank) ||
        entry.equivalentRank! < 1)) ||
    (entry.isAggregationTarget &&
      !entry.isReference &&
      (!Number.isInteger(entry.rank) ||
        entry.rank! < 1 ||
        entry.rank! > rankParticipantCount ||
        entry.equivalentRank !== null)) ||
    (!entry.isAggregationTarget && (entry.rank !== null || entry.equivalentRank !== null)) ||
    (entry.isAggregationTarget && participantCount < 1) ||
    (entry.isAggregationTarget && !entry.isReference && rankParticipantCount < 1) ||
    questionRows.length === 0 ||
    !Array.isArray(entry.answers) ||
    entry.answers.length !== questionRows.length
  ) {
    return false;
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
      return false;
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
      return false;
    }
    answerByQuestionId.set(item.questionId, item as PresentationAnswerSnapshot);
  }

  for (const question of questionRows) {
    const answer = answerByQuestionId.get(question.sourceQuestionId);
    if (
      !answer ||
      typeof question.question !== "string" ||
      !Array.isArray(question.choices) ||
      !Array.from(question.choices).every((choice) => typeof choice === "string")
    ) {
      return false;
    }
    if (answer.answerKind === "selected" && question.choices.length === 0) return false;
    if (
      answer.answerKind === "freeText" &&
      (question.choices.length > 0 ||
        typeof answer.freeText !== "string" ||
        (answer.normalizedScore !== null &&
          (!Number.isFinite(answer.normalizedScore) ||
            answer.normalizedScore < 0 ||
            answer.normalizedScore > 2)))
    ) {
      return false;
    }
    if (
      answer.answerKind === "legacy" &&
      (question.position !== questionRows.length - 1 ||
        question.choices.length !== 0 ||
        !Number.isInteger(answer.selectedIndex) ||
        answer.selectedIndex === null ||
        answer.selectedIndex < 0 ||
        answer.freeText !== null ||
        answer.rawScore !== null ||
        answer.normalizedScore !== null)
    ) {
      return false;
    }
  }
  return true;
}

async function readParticipantResultState(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  participantId: number,
): Promise<"waiting" | "visible" | "unavailable"> {
  const [settings] = await tx
    .select({ visible: participantResultSettings.visible })
    .from(participantResultSettings)
    .where(eq(participantResultSettings.id, 1));
  if (!settings?.visible) return "waiting";

  const [entry] = await tx
    .select({
      score: presentationEntries.score,
      rank: presentationEntries.rank,
      isAggregationTarget: presentationEntries.isAggregationTarget,
      isReference: presentationEntries.isReference,
      equivalentRank: presentationEntries.equivalentRank,
      answers: presentationEntries.answers,
    })
    .from(presentationEntries)
    .where(
      and(
        eq(presentationEntries.sessionId, 1),
        eq(presentationEntries.participantId, participantId),
      ),
    );
  const state = participantResultPublicationState(Boolean(entry));
  if (state !== "published") return state;

  const [questionRows, participantCount, rankParticipantCount] = await Promise.all([
    tx
      .select({
        position: presentationQuestions.position,
        sourceQuestionId: presentationQuestions.sourceQuestionId,
        question: presentationQuestions.question,
        choices: presentationQuestions.choices,
        correctIndex: presentationQuestions.correctIndex,
        correctIndices: presentationQuestions.correctIndices,
      })
      .from(presentationQuestions)
      .where(eq(presentationQuestions.sessionId, 1))
      .orderBy(asc(presentationQuestions.position)),
    tx
      .select({ value: count() })
      .from(presentationEntries)
      .where(
        and(
          eq(presentationEntries.sessionId, 1),
          eq(presentationEntries.isAggregationTarget, true),
        ),
      ),
    tx
      .select({ value: count() })
      .from(presentationEntries)
      .where(
        and(
          eq(presentationEntries.sessionId, 1),
          eq(presentationEntries.isAggregationTarget, true),
          eq(presentationEntries.isReference, false),
        ),
      ),
  ]);
  return isValidParticipantResultSnapshot(
    entry,
    questionRows,
    participantCount[0]!.value,
    rankParticipantCount[0]!.value,
  )
    ? "visible"
    : "unavailable";
}

/** Read the result state with only fields needed to validate publication data. */
export async function getParticipantResultState(
  participantId: number,
): Promise<"waiting" | "visible" | "unavailable"> {
  return db.transaction((tx) => readParticipantResultState(tx, participantId));
}

export async function getParticipantResult(participantId: number): Promise<ParticipantResult> {
  return db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ visible: participantResultSettings.visible })
      .from(participantResultSettings)
      .where(eq(participantResultSettings.id, 1));
    if (!settings?.visible) return { state: "waiting" as const };

    const [entry] = await tx
      .select({
        score: presentationEntries.score,
        rank: presentationEntries.rank,
        isAggregationTarget: presentationEntries.isAggregationTarget,
        isReference: presentationEntries.isReference,
        equivalentRank: presentationEntries.equivalentRank,
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
    const [[entryCount], [rankEntryCount]] = await Promise.all([
      tx
        .select({ value: count() })
        .from(presentationEntries)
        .where(
          and(
            eq(presentationEntries.sessionId, 1),
            eq(presentationEntries.isAggregationTarget, true),
          ),
        ),
      tx
        .select({ value: count() })
        .from(presentationEntries)
        .where(
          and(
            eq(presentationEntries.sessionId, 1),
            eq(presentationEntries.isAggregationTarget, true),
            eq(presentationEntries.isReference, false),
          ),
        ),
    ]);
    if (
      !isValidParticipantResultSnapshot(
        entry,
        questionRows,
        entryCount!.value,
        rankEntryCount!.value,
      )
    ) {
      return { state: "unavailable" as const };
    }
    const answerByQuestionId = new Map(
      (entry.answers as PresentationAnswerSnapshot[]).map((answer) => [answer.questionId, answer]),
    );

    const questions: ParticipantResultQuestion[] = [];
    for (const question of questionRows) {
      const answer = answerByQuestionId.get(question.sourceQuestionId)!;
      let answerDto: ParticipantResultQuestion["answer"];
      if (answer.answerKind === "selected") {
        const selectedIndex = answer.selectedIndex;
        if (question.selectionMode === "multiple") {
          const selection = normalizeSelectedChoiceIndices({
            selectionMode: question.selectionMode,
            choiceCount: question.choices.length,
            selectedIndex,
            selectedIndices: answer.selectedIndices,
          });
          const correctSelection = normalizeSelectedChoiceIndices({
            selectionMode: question.selectionMode,
            choiceCount: question.choices.length,
            selectedIndex: null,
            selectedIndices: question.correctIndices,
          });
          if (!selection || !correctSelection) {
            answerDto = { kind: "selected", value: "", correctness: "unavailable" };
          } else {
            const selectedSet = new Set(selection.indices);
            answerDto = {
              kind: "selected",
              value: selection.indices.map((index) => question.choices[index]).join("、"),
              correctness: correctSelection.indices.every((index) => selectedSet.has(index))
                ? "correct"
                : "incorrect",
            };
          }
        } else {
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
        }
      } else if (answer.answerKind === "freeText") {
        const score = answer.normalizedScore;
        let parts: { a: string; b: string } | undefined;
        try {
          const parsed: unknown = JSON.parse(answer.freeText as string);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "a" in parsed &&
            "b" in parsed &&
            typeof parsed.a === "string" &&
            typeof parsed.b === "string"
          )
            parts = { a: parsed.a, b: parsed.b };
        } catch {
          parts = undefined;
        }
        answerDto = {
          kind: "freeText",
          value: parts ? `A: ${parts.a}\nB: ${parts.b}` : (answer.freeText as string),
          score,
          ...(parts ? { parts } : {}),
        };
      } else if (answer.answerKind === "legacy") {
        // The historical legacy answer is the final free-response question:
        // its original choices are no longer in the snapshot, but its old
        // selected index is retained without interpreting it.
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
    return {
      state: "visible" as const,
      score: entry.score,
      maxScore: questionRows.length,
      rank: entry.isAggregationTarget && !entry.isReference ? entry.rank : null,
      isAggregationTarget: entry.isAggregationTarget,
      isReference: entry.isReference,
      equivalentRank: entry.isAggregationTarget && entry.isReference ? entry.equivalentRank : null,
      participantCount: entryCount!.value,
      rankParticipantCount: rankEntryCount!.value,
      questions,
    };
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
  | { state: "statistics"; question?: PublicProjectedQuestion; statistics: PresentationStatistics }
  | { state: "statistics" }
  | { state: "third" | "second" | "first"; winners: Winner[]; question?: PublicProjectedQuestion }
  | {
      state: Exclude<
        PresentationState,
        "question" | "answer" | "statistics" | "third" | "second" | "first"
      >;
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
  correctIndex?: number | null;
  correctIndices?: number[] | null;
  explanation?: string | null;
  expectedAnswer?: string | null;
  expectedAnswerParts?: { a: string; b: string };
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
  sourceQuestions: Map<number, { explanation: string | null }>,
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
              ...(row.sourceQuestionKey === null || row.sourceQuestionKey === "it-literacy-005"
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
              ...(row.sourceQuestionKey === "it-literacy-005"
                ? {
                    expectedAnswerParts: {
                      a: "新鮮なロブスター",
                      b: "フレンチトースト",
                    },
                  }
                : {}),
            }
          : {
              correctAnswer: row.correctAnswer,
              correctIndex: row.correctIndex,
              correctIndices: row.correctIndices,
              explanation,
            }
        : {}),
    };
    return { state, question };
  }
  if (state === "statistics") {
    const row = currentQuestion ?? admin.questions[questionIndex];
    if (!row) return { state };
    return {
      state,
      question: {
        id: row.id,
        ordinal: questionIndex + 1,
        total: admin.questionCount,
        question: row.question,
        choices: row.choices,
        answerType: row.answerType,
        ...(row.answerType === "selected"
          ? { correctIndex: row.correctIndex, correctIndices: row.correctIndices }
          : {}),
      },
      statistics: buildPresentationStatistics(
        row,
        admin.entries,
        row.sourceQuestionKey === "it-literacy-005",
      ),
    };
  }
  const rank = rankForStage(state);
  if (rank !== null) {
    const winners = admin.entries
      .filter(
        (entry) =>
          entry.isAggregationTarget &&
          !entry.isReference &&
          entry.rank !== null &&
          entry.rank === rank,
      )
      .map((entry) => ({
        displayName: entry.displayName,
        score: entry.score,
        rank,
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
            const selectedIndices = Array.isArray(answer.selectedIndices)
              ? answer.selectedIndices
              : answer.selectedIndex === null
                ? []
                : [answer.selectedIndex];
            const correctIndex = question.correctIndex;
            const correctIndices = question.correctIndices ?? [correctIndex];
            const selectedValid =
              selectedIndices.length > 0 &&
              selectedIndices.every(
                (index) => Number.isInteger(index) && index >= 0 && index < question.choices.length,
              );
            const correctValid =
              correctIndices.length > 0 &&
              correctIndices.every(
                (index) => Number.isInteger(index) && index >= 0 && index < question.choices.length,
              );
            const isCorrect =
              selectedIndices.length === correctIndices.length &&
              selectedIndices.every((index) => correctIndices.includes(index));
            return {
              position,
              question: questionText,
              answer: {
                kind: "selected",
                value: selectedValid
                  ? selectedIndices.map((index) => question.choices[index]).join("、")
                  : null,
              },
              correctness:
                selectedValid && correctValid
                  ? isCorrect
                    ? "correct"
                    : "incorrect"
                  : "unavailable",
            };
          }
          if (answer.answerKind === "freeText") {
            const isFifthQuestion = question.sourceQuestionKey === "it-literacy-005";
            const score = answer.normalizedScore;
            const validScore =
              score === null || (Number.isFinite(score) && score >= 0 && score <= 2);
            const freeTextParts =
              isFifthQuestion && isQ5TextParts(answer.freeTextParts)
                ? answer.freeTextParts
                : undefined;
            return {
              position,
              question: questionText,
              answer: {
                kind: "freeText",
                value: freeTextParts
                  ? `A: ${freeTextParts.a}\nB: ${freeTextParts.b}`
                  : typeof answer.freeText === "string"
                    ? answer.freeText
                    : null,
                ...(freeTextParts ? { parts: freeTextParts } : {}),
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
      "question" | "answer" | "statistics" | "third" | "second" | "first"
    >,
  };
}

export type PresentationStatistics =
  | {
      kind: "selected";
      multiple: boolean | null;
      participantCount: number;
      validRespondentCount: number;
      uncountableCount: number;
      choices: { label: string; count: number }[];
    }
  | {
      kind: "freeText";
      participantCount: number;
      gradedCount: number;
      ungradedCount: number;
      uncountableCount: number;
      ranges: { label: string; count: number }[];
    };

type NormalizedStatisticsAnswer =
  | { kind: "unanswered" }
  | { kind: "selected"; indices: number[]; multiple: boolean }
  | { kind: "freeText"; score: number | null }
  | { kind: "unavailable" };

export function assertStatisticsCategoryTotal(
  participantCount: number,
  categoryCounts: readonly number[],
): void {
  if (categoryCounts.reduce((sum, categoryCount) => sum + categoryCount, 0) !== participantCount)
    throw new Error("Presentation statistics categories do not match the participant count");
}

function normalizeStatisticsAnswer(
  answer: Record<string, unknown>,
  isQ5: boolean,
  question: Pick<
    AdminPresentation["questions"][number],
    "id" | "choices" | "selectionMode" | "answerType"
  >,
): NormalizedStatisticsAnswer {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(answer, key);
  if (
    answer.questionId !== question.id ||
    Object.keys(answer).some(
      (key) =>
        ![
          "questionId",
          "answerKind",
          "selectedIndex",
          "selectedIndices",
          "freeText",
          "freeTextParts",
          "rawScore",
          "normalizedScore",
        ].includes(key),
    ) ||
    !["answerKind", "selectedIndex", "freeText", "rawScore", "normalizedScore"].every(has) ||
    !(
      answer.selectedIndices === undefined ||
      answer.selectedIndices === null ||
      Array.isArray(answer.selectedIndices)
    )
  )
    return { kind: "unavailable" };

  const selectedIndexIsEmpty = answer.selectedIndex === null;
  const selectedIndicesAreEmpty =
    answer.selectedIndices === undefined || answer.selectedIndices === null;
  if (answer.answerKind === "unanswered") {
    return selectedIndexIsEmpty &&
      selectedIndicesAreEmpty &&
      answer.freeText === null &&
      answer.rawScore === null &&
      answer.normalizedScore === null &&
      !has("freeTextParts")
      ? { kind: "unanswered" }
      : { kind: "unavailable" };
  }

  if (answer.answerKind === "selected" && question.answerType === "selected") {
    const commonFieldsValid =
      answer.freeText === null &&
      answer.rawScore === null &&
      answer.normalizedScore === null &&
      !has("freeTextParts");
    if (!commonFieldsValid) return { kind: "unavailable" };
    const selection = normalizeSelectedChoiceIndices({
      selectionMode: question.selectionMode,
      choiceCount: question.choices.length,
      selectedIndex: answer.selectedIndex,
      selectedIndices: answer.selectedIndices,
    });
    return selection ? { kind: "selected", ...selection } : { kind: "unavailable" };
  }

  if (answer.answerKind === "freeText" && question.answerType === "freeText") {
    const rawScoreValid =
      answer.rawScore === null ||
      (typeof answer.rawScore === "number" &&
        Number.isFinite(answer.rawScore) &&
        answer.rawScore >= 0 &&
        answer.rawScore <= 9);
    const scoreValid =
      answer.normalizedScore === null ||
      (typeof answer.normalizedScore === "number" &&
        Number.isFinite(answer.normalizedScore) &&
        answer.normalizedScore >= 0 &&
        answer.normalizedScore <= 2);
    const partsValid = has("freeTextParts")
      ? isQ5 && isValidFreeTextParts(answer.freeTextParts)
      : !isQ5;
    const freeTextValid =
      typeof answer.freeText === "string" &&
      (isQ5
        ? partsValid &&
          answer.freeText ===
            `A: ${(answer.freeTextParts as { a: string }).a.trim()}\nB: ${(answer.freeTextParts as { b: string }).b.trim()}`
        : answer.freeText.trim().length > 0 && answer.freeText.trim().length <= 1000);
    if (
      answer.selectedIndex !== null ||
      !selectedIndicesAreEmpty ||
      !freeTextValid ||
      !rawScoreValid ||
      !scoreValid ||
      !partsValid
    ) {
      return { kind: "unavailable" };
    }
    return { kind: "freeText", score: answer.normalizedScore as number | null };
  }

  return { kind: "unavailable" };
}

function buildPresentationStatistics(
  question: Pick<
    AdminPresentation["questions"][number],
    "id" | "choices" | "correctIndices" | "selectionMode" | "answerType"
  >,
  entries: { answers: unknown[] }[],
  isQ5 = false,
): PresentationStatistics {
  const participantCount = entries.length;
  const normalizedRecords = entries.map((entry) => {
    const matches = entry.answers.filter(
      (answer): answer is Record<string, unknown> =>
        typeof answer === "object" &&
        answer !== null &&
        !Array.isArray(answer) &&
        "questionId" in answer &&
        answer.questionId === question.id,
    );
    return {
      answer:
        matches.length === 1
          ? normalizeStatisticsAnswer(matches[0], isQ5, question)
          : { kind: "unavailable" as const },
    };
  });
  const normalized = normalizedRecords.map(({ answer }) => answer);
  if (question.answerType === "selected") {
    const counts = question.choices.map(() => 0);
    let validRespondentCount = 0;
    let uncountableCount = 0;
    let unansweredCount = 0;
    const observedModes = new Set<boolean>();
    for (const { answer } of normalizedRecords) {
      if (answer.kind === "selected") observedModes.add(answer.multiple);
    }
    const legacyModeConflict = question.selectionMode === null && observedModes.size > 1;
    const multiple =
      question.selectionMode === "multiple"
        ? true
        : question.selectionMode === "single"
          ? false
          : legacyModeConflict || observedModes.size === 0
            ? null
            : observedModes.has(true);
    for (const answer of normalized) {
      if (answer.kind === "unanswered") {
        unansweredCount += 1;
        continue;
      }
      if (answer.kind !== "selected" || legacyModeConflict) {
        uncountableCount += 1;
        continue;
      }
      validRespondentCount += 1;
      for (const index of answer.indices) counts[index] = counts[index]! + 1;
    }
    assertStatisticsCategoryTotal(participantCount, [
      validRespondentCount,
      uncountableCount,
      unansweredCount,
    ]);
    return {
      kind: "selected",
      multiple,
      participantCount,
      validRespondentCount,
      uncountableCount,
      choices: question.choices.map((label, index) => ({ label, count: counts[index]! })),
    };
  }

  const labels = ["0点", "0点超〜0.25点", "0.25点超〜0.5点", "0.5点超〜0.75点", "0.75点超〜1点"];
  const ranges = labels.map((label) => ({ label, count: 0 }));
  let ungradedCount = 0;
  let uncountableCount = 0;
  let unansweredCount = 0;
  for (const answer of normalized) {
    if (answer.kind === "unanswered") {
      unansweredCount += 1;
      continue;
    }
    if (answer.kind !== "freeText") {
      uncountableCount += 1;
      continue;
    }
    if (answer.score === null) {
      ungradedCount += 1;
      continue;
    }
    if (answer.score > 1) {
      uncountableCount += 1;
      continue;
    }
    const bucket = answer.score === 0 ? 0 : Math.ceil(answer.score * 4);
    ranges[bucket]!.count += 1;
  }
  const gradedCount = ranges.reduce((sum, range) => sum + range.count, 0);
  assertStatisticsCategoryTotal(participantCount, [
    gradedCount,
    ungradedCount,
    uncountableCount,
    unansweredCount,
  ]);
  return {
    kind: "freeText",
    participantCount,
    gradedCount,
    ungradedCount,
    uncountableCount,
    ranges,
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
            explanation: examQuestions.explanation,
          })
          .from(examQuestions)
          .where(inArray(examQuestions.id, questionIds))
      : [];
    const currentExplanations = new Map(sourceRows.map(({ id, explanation }) => [id, explanation]));
    const sourceQuestions = new Map(
      admin.questions.map(({ id }) => [id, { explanation: currentExplanations.get(id) ?? null }]),
    );
    const slides: {
      state: PresentationState;
      questionIndex: number;
      projection: PublicProjection;
    }[] = [];
    const terminalQuestionIndex = Math.max(admin.questionCount - 1, 0);
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
        {
          state: "statistics",
          questionIndex: index,
          projection: buildPublicProjection(admin, "statistics", index, sourceQuestions),
        },
      );
    }
    slides.push({
      state: "podium_preview",
      questionIndex: terminalQuestionIndex,
      projection: buildPublicProjection(
        admin,
        "podium_preview",
        terminalQuestionIndex,
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
          questionIndex: terminalQuestionIndex,
          projection: buildPublicProjection(admin, state, terminalQuestionIndex, sourceQuestions),
        });
      }
    }
    for (const [state, rank] of [
      ["third_prize", 3],
      ["second_prize", 2],
      ["first_prize", 1],
    ] as const) {
      if (
        admin.entries.some(
          (entry) => entry.isAggregationTarget && !entry.isReference && entry.rank === rank,
        )
      ) {
        slides.push({
          state,
          questionIndex: terminalQuestionIndex,
          projection: buildPublicProjection(admin, state, terminalQuestionIndex, sourceQuestions),
        });
      }
    }
    slides.push({
      state: "finished",
      questionIndex: terminalQuestionIndex,
      projection: buildPublicProjection(admin, "finished", terminalQuestionIndex, sourceQuestions),
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
    const activeQuestion = state === "question" || state === "answer" || state === "statistics";
    let questions: AdminPresentation["questions"];
    if (state === "answer" || state === "statistics") {
      const rows = await tx
        .select({
          sourceQuestionId: presentationQuestions.sourceQuestionId,
          sourceQuestionKey: presentationQuestions.sourceQuestionKey,
          question: presentationQuestions.question,
          choices: presentationQuestions.choices,
          correctIndex: presentationQuestions.correctIndex,
          correctIndices: presentationQuestions.correctIndices,
          selectionMode: presentationQuestions.selectionMode,
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
        sourceQuestionKey: row.sourceQuestionKey,
        question: row.question,
        choices: row.choices,
        correctIndex: row.correctIndex,
        correctIndices: row.correctIndices,
        selectionMode: row.selectionMode,
        correctAnswer: (row.correctIndices ?? [row.correctIndex])
          .map((i) => row.choices[i])
          .filter(Boolean)
          .join("、"),
        explanation: row.explanation,
        answerType: row.choices.length === 0 ? ("freeText" as const) : ("selected" as const),
      }));
    } else if (state === "question") {
      const rows = await tx
        .select({
          sourceQuestionId: presentationQuestions.sourceQuestionId,
          sourceQuestionKey: presentationQuestions.sourceQuestionKey,
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
        sourceQuestionKey: row.sourceQuestionKey,
        question: row.question,
        choices: row.choices,
        correctIndex: 0,
        correctIndices: null,
        selectionMode: null,
        correctAnswer: row.choices[0] ?? "",
        explanation: null,
        answerType: row.choices.length === 0 ? ("freeText" as const) : ("selected" as const),
      }));
    } else if (rank !== null) {
      const rows = await tx
        .select({
          sourceQuestionId: presentationQuestions.sourceQuestionId,
          sourceQuestionKey: presentationQuestions.sourceQuestionKey,
          question: presentationQuestions.question,
          choices: presentationQuestions.choices,
          correctIndex: presentationQuestions.correctIndex,
          correctIndices: presentationQuestions.correctIndices,
          selectionMode: presentationQuestions.selectionMode,
        })
        .from(presentationQuestions)
        .where(eq(presentationQuestions.sessionId, 1))
        .orderBy(asc(presentationQuestions.position));
      questions = rows.map((row) => ({
        id: row.sourceQuestionId,
        sourceQuestionKey: row.sourceQuestionKey,
        question: row.question,
        choices: row.choices,
        correctIndex: row.correctIndex,
        correctIndices: row.correctIndices,
        selectionMode: row.selectionMode,
        correctAnswer: (row.correctIndices ?? [row.correctIndex])
          .map((i) => row.choices[i])
          .filter(Boolean)
          .join("、"),
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
    let sourceQuestions = new Map<number, { explanation: string | null }>();
    if (state === "answer" && questions.length > 0) {
      // Only legacy explanation fallback is resolved from the current source row.
      const rows = await tx
        .select({
          id: examQuestions.id,
          explanation: examQuestions.explanation,
        })
        .from(examQuestions)
        .where(
          inArray(
            examQuestions.id,
            questions.map(({ id }) => id),
          ),
        );
      sourceQuestions = new Map(rows.map(({ id, explanation }) => [id, { explanation }]));
    }
    const currentQuestion = activeQuestion ? questions[0] : undefined;
    if (state === "statistics") {
      const entryRows = await tx
        .select({ answers: presentationEntries.answers })
        .from(presentationEntries)
        .where(eq(presentationEntries.sessionId, 1));
      admin.entries = entryRows.map((entry) => ({
        ...entry,
        displayName: "",
        score: 0,
        rank: null,
        isAggregationTarget: false,
        isReference: false,
      }));
    } else if (
      state === "answer" &&
      currentQuestion?.answerType === "freeText" &&
      currentQuestion.sourceQuestionKey !== null &&
      currentQuestion.sourceQuestionKey !== "it-literacy-005"
    ) {
      const entryRows = await tx
        .select({
          displayName: presentationEntries.displayName,
          answers: presentationEntries.answers,
          rank: presentationEntries.rank,
          isAggregationTarget: presentationEntries.isAggregationTarget,
          isReference: presentationEntries.isReference,
        })
        .from(presentationEntries)
        .where(
          and(
            eq(presentationEntries.sessionId, 1),
            eq(presentationEntries.isAggregationTarget, true),
          ),
        )
        .orderBy(asc(presentationEntries.rank), asc(presentationEntries.displayName));
      admin.entries = entryRows.map((entry) => ({ ...entry, score: 0 }));
    } else if (rank !== null) {
      const entryRows = await tx
        .select({
          displayName: presentationEntries.displayName,
          score: presentationEntries.score,
          rank: presentationEntries.rank,
          isAggregationTarget: presentationEntries.isAggregationTarget,
          isReference: presentationEntries.isReference,
          answers: presentationEntries.answers,
        })
        .from(presentationEntries)
        .where(
          and(
            eq(presentationEntries.sessionId, 1),
            eq(presentationEntries.isAggregationTarget, true),
            eq(presentationEntries.isReference, false),
            eq(presentationEntries.rank, rank),
          ),
        )
        .orderBy(asc(presentationEntries.rank), asc(presentationEntries.displayName));
      admin.entries = entryRows;
    }
    return buildPublicProjection(admin, state, questionIndex, sourceQuestions, currentQuestion);
  });
}
