import type { examQuestions } from "@/lib/db/schema";

export type Question = typeof examQuestions.$inferSelect;

export interface QuizQuestion {
  id: number;
  question: string;
  choices: string[];
  answerType: "selected" | "freeText";
  selectionMode?: "single" | "multiple";
}

export interface AnswerResult {
  isCorrect: boolean;
  correctIndex: number;
  explanation: string | null;
}
