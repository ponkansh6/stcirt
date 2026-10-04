import type { AnswerResult } from "@/types/quiz";

export function makeAnswerResult(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return { isCorrect: true, correctIndex: 0, explanation: "Explanation", ...overrides };
}
