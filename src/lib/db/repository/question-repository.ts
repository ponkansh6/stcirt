import { asc, eq } from "drizzle-orm";
import { db } from "../index";
import { examQuestions } from "../schema";
import { QuizQuestion, Question } from "@/types/quiz";

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
    explanation: q.explanation,
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
    })
    .from(examQuestions)
    .orderBy(asc(examQuestions.id))
    .limit(5);

  return rows.map((question) => ({
    id: question.id,
    question: question.question,
    choices: question.choices,
    answerType: question.key === "it-literacy-005" ? "freeText" : "selected",
  }));
}
