import { asc, eq, gt } from "drizzle-orm";
import { db } from "../index";
import { examQuestions } from "../schema";
import { QuizQuestion, Question } from "@/types/quiz";

export async function getQuestionById(id: number): Promise<Question | null> {
  const [q] = await db.select().from(examQuestions).where(eq(examQuestions.id, id));
  if (!q) return null;
  return {
    id: q.id,
    key: q.key,
    question: q.question,
    choices: q.choices,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    createdAt: q.createdAt,
  };
}

export async function getNextQuestion(afterId?: number): Promise<QuizQuestion | null> {
  const query = db
    .select({
      id: examQuestions.id,
      question: examQuestions.question,
      choices: examQuestions.choices,
      key: examQuestions.key,
    })
    .from(examQuestions);

  const [question] = await (afterId === undefined
    ? query.orderBy(asc(examQuestions.id)).limit(1)
    : query.where(gt(examQuestions.id, afterId)).orderBy(asc(examQuestions.id)).limit(1));
  return question
    ? {
        id: question.id,
        question: question.question,
        choices: question.choices,
        answerType: question.key === "it-literacy-005" ? "freeText" : "selected",
      }
    : null;
}
