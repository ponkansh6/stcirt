import type { QuizQuestion } from "@/types/quiz";
import type { ShuffledChoices } from "@/lib/shuffle";
import { EXAM_QUESTION_COUNT } from "@/lib/constants";

export type LoadedQuiz = { question: QuizQuestion; shuffled: ShuffledChoices };

export type AssistedDraft = {
  schemaVersion: number;
  expiresAt: number;
  participantId: number;
  quizzes: LoadedQuiz[];
  selections: Record<number, number>;
  freeResponses: Record<number, string>;
  legacyAnswerIds: number[];
  submissionId: string;
  revision: number;
};

const ASSISTED_DRAFT_KEY = "stcirt-assisted-answer-draft";
const ASSISTED_DRAFT_SCHEMA_VERSION = 1;
const ASSISTED_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export function clearAssistedDraft() {
  try {
    window.sessionStorage.removeItem(ASSISTED_DRAFT_KEY);
  } catch {
    // Storage may be unavailable; the draft then cannot be resumed.
  }
}

export function readAssistedDraft(expectedParticipantId: number): AssistedDraft | null {
  try {
    const raw = window.sessionStorage.getItem(ASSISTED_DRAFT_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      clearAssistedDraft();
      return null;
    }
    const draft = value as Partial<AssistedDraft>;
    if (
      draft.schemaVersion !== ASSISTED_DRAFT_SCHEMA_VERSION ||
      !Number.isFinite(draft.expiresAt) ||
      draft.expiresAt! <= Date.now() ||
      !Number.isInteger(draft.participantId) ||
      draft.participantId !== expectedParticipantId ||
      !Array.isArray(draft.quizzes) ||
      draft.quizzes.length !== EXAM_QUESTION_COUNT ||
      !draft.selections ||
      typeof draft.selections !== "object" ||
      Array.isArray(draft.selections) ||
      !draft.freeResponses ||
      typeof draft.freeResponses !== "object" ||
      Array.isArray(draft.freeResponses) ||
      (draft.legacyAnswerIds !== undefined &&
        (!Array.isArray(draft.legacyAnswerIds) ||
          draft.legacyAnswerIds.some((id) => !Number.isInteger(id) || id <= 0))) ||
      typeof draft.submissionId !== "string" ||
      draft.submissionId.length === 0 ||
      !Number.isInteger(draft.revision) ||
      draft.revision! < 0
    ) {
      clearAssistedDraft();
      return null;
    }
    const ids = draft.quizzes.map(({ question }) => question.id);
    if (
      new Set(ids).size !== EXAM_QUESTION_COUNT ||
      ids.some((id, index) => index > 0 && id <= ids[index - 1]!) ||
      draft.quizzes.some(
        ({ question, shuffled }) =>
          !Number.isInteger(question.id) ||
          question.id <= 0 ||
          typeof question.question !== "string" ||
          !Array.isArray(question.choices) ||
          question.choices.some((choice) => typeof choice !== "string") ||
          (question.answerType !== "selected" && question.answerType !== "freeText") ||
          (question.answerType === "selected" && question.choices.length === 0) ||
          (question.answerType === "freeText" && question.choices.length !== 0) ||
          !shuffled ||
          !Array.isArray(shuffled.choices) ||
          shuffled.choices.length !== question.choices.length ||
          shuffled.choices.some((choice) => typeof choice !== "string") ||
          new Set(question.choices).size !== question.choices.length ||
          new Set(shuffled.choices).size !== shuffled.choices.length ||
          !question.choices.every((choice) => shuffled.choices.includes(choice)) ||
          !Array.isArray(shuffled.choiceIndices) ||
          shuffled.choiceIndices.length !== question.choices.length ||
          new Set(shuffled.choiceIndices).size !== shuffled.choiceIndices.length ||
          shuffled.choiceIndices.some(
            (index, displayIndex) =>
              !Number.isInteger(index) ||
              index < 0 ||
              index >= question.choices.length ||
              shuffled.choices[displayIndex] !== question.choices[index],
          ),
      ) ||
      Object.entries(draft.selections).some(([questionId, index]) => {
        const quiz = draft.quizzes!.find(({ question }) => question.id === Number(questionId));
        return (
          !quiz ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= quiz.shuffled.choiceIndices.length
        );
      }) ||
      Object.entries(draft.freeResponses).some(
        ([questionId, response]) =>
          !ids.includes(Number(questionId)) ||
          typeof response !== "string" ||
          response.length > 1000,
      ) ||
      (draft.legacyAnswerIds ?? []).some((id) => !ids.includes(id))
    ) {
      clearAssistedDraft();
      return null;
    }
    return { ...draft, legacyAnswerIds: draft.legacyAnswerIds ?? [] } as AssistedDraft;
  } catch {
    clearAssistedDraft();
    return null;
  }
}

export function writeAssistedDraft(draft: Omit<AssistedDraft, "schemaVersion" | "expiresAt">) {
  try {
    window.sessionStorage.setItem(
      ASSISTED_DRAFT_KEY,
      JSON.stringify({
        ...draft,
        schemaVersion: ASSISTED_DRAFT_SCHEMA_VERSION,
        expiresAt: Date.now() + ASSISTED_DRAFT_TTL_MS,
      } satisfies AssistedDraft),
    );
  } catch {
    // Storage may be unavailable; in-memory answers remain usable for this visit.
  }
}
