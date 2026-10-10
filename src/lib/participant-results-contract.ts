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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isNormalizedScore = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;

export const parseParticipantResult = (payload: unknown): ParticipantResult | null => {
  if (!isRecord(payload)) return null;
  if (payload.state === "waiting") return { state: "waiting" };
  if (payload.state === "unavailable") return { state: "unavailable" };
  if (
    payload.state !== "visible" ||
    !isPositiveInteger(payload.rank) ||
    !isFiniteNumber(payload.score) ||
    !Array.isArray(payload.questions) ||
    payload.questions.length === 0
  ) {
    return null;
  }

  const questions: ParticipantResultQuestion[] = [];
  for (const candidate of payload.questions) {
    if (
      !isRecord(candidate) ||
      !isNonNegativeInteger(candidate.position) ||
      typeof candidate.question !== "string" ||
      !isRecord(candidate.answer)
    ) {
      return null;
    }

    const answer = candidate.answer;
    if (
      answer.kind === "selected" &&
      typeof answer.value === "string" &&
      (answer.correctness === "correct" ||
        answer.correctness === "incorrect" ||
        answer.correctness === "unavailable")
    ) {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: {
          kind: "selected",
          value: answer.value,
          correctness: answer.correctness,
        },
      });
    } else if (
      answer.kind === "freeText" &&
      typeof answer.value === "string" &&
      (answer.score === null || isNormalizedScore(answer.score))
    ) {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: { kind: "freeText", value: answer.value, score: answer.score },
      });
    } else if (answer.kind === "unanswered") {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: { kind: "unanswered" },
      });
    } else if (answer.kind === "legacy") {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: { kind: "legacy" },
      });
    } else {
      return null;
    }
  }

  if (payload.score < 0 || payload.score > questions.length) return null;

  return { state: "visible", score: payload.score, rank: payload.rank, questions };
};
