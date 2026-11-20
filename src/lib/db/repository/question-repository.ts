import { asc, eq } from "drizzle-orm";
import { db } from "../index";
import { examQuestions } from "../schema";
import { QuizQuestion, Question } from "@/types/quiz";
import { EXAM_QUESTION_COUNT, orderExamQuestionsForDisplay } from "@/lib/constants";

export async function getQuestionById(id: number): Promise<Question | null> {
  const [q] = await db.select().from(examQuestions).where(eq(examQuestions.id, id));
  if (!q) return null;
  return {
    id: q.id,
    key: q.key,
    questionVersion: q.questionVersion,
    question: q.question,
    choices: q.choices,
    correctIndex: q.correctIndex,
    correctIndices: q.correctIndices,
    explanation: q.explanation,
    selectionMode: q.selectionMode === "multiple" ? "multiple" : "single",
    createdAt: q.createdAt,
  };
}

export async function getExamQuestions(): Promise<QuizQuestion[]> {
  const rows = await db
    .select({
      id: examQuestions.id,
      question: examQuestions.question,
      choices: examQuestions.choices,
      key: examQuestions.key,
      selectionMode: examQuestions.selectionMode,
    })
    .from(examQuestions)
    .orderBy(asc(examQuestions.id))
    .limit(EXAM_QUESTION_COUNT);

  return orderExamQuestionsForDisplay(
    rows.map((question) => ({
      id: question.id,
      question: question.question,
      choices: question.choices,
      answerType: question.key === "it-literacy-005" ? "freeText" : "selected",
      selectionMode: question.selectionMode === "multiple" ? "multiple" : "single",
    })),
  );
}
