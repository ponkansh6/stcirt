import type { QuizQuestion } from "@/types/quiz";

export function makeQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return { id: 1, question: "What is TypeScript?", choices: ["A", "B", "C", "D"], ...overrides };
}
