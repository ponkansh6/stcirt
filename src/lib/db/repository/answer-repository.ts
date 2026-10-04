import { gte, count, sql } from "drizzle-orm";
import { db } from "../index";
import { examAnswerLogs, examQuestions } from "../schema";
import { jstDayStart } from "../../date";

export async function recordAnswer(input: {
  questionId: number;
  selectedIndex: number;
  isCorrect: boolean;
}) {
  await db.insert(examAnswerLogs).values({
    questionId: input.questionId,
    selectedIndex: input.selectedIndex,
    isCorrect: input.isCorrect ? 1 : 0,
  });
}

export async function getStats() {
  const dayStart = jstDayStart();
  // The two answer-log counts share the same table and predicate (answered
  // since JST day start), so fold them into one conditional aggregate. The
  // question count is independent, so run it in parallel.
  const [qCountResult, todayStats] = await Promise.all([
    db.select({ count: count(examQuestions.id) }).from(examQuestions),
    db
      .select({
        answers: count(examAnswerLogs.id),
        correct: sql<number>`sum(case when ${examAnswerLogs.isCorrect} = 1 then 1 else 0 end)`,
      })
      .from(examAnswerLogs)
      .where(gte(examAnswerLogs.answeredAt, dayStart)),
  ]);

  const totalQuestions = Number(qCountResult?.[0]?.count ?? 0);
  const todayAnswers = Number(todayStats?.[0]?.answers ?? 0);
  const todayCorrect = Number(todayStats?.[0]?.correct ?? 0);

  const todayAccuracy = todayAnswers > 0 ? todayCorrect / todayAnswers : 0;

  return {
    totalQuestions,
    todayAnswers,
    todayAccuracy,
  };
}
