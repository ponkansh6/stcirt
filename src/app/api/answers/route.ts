import { getQuestionById } from "@/lib/db/repository/question-repository";
import { recordAnswer } from "@/lib/db/repository/answer-repository";
import { submitAnswerSchema } from "@/lib/api/schemas";
import { ok, fail, withErrorHandling } from "@/lib/api/response";

export const POST = withErrorHandling(async function (request: Request) {
  const json = await request.json();
  const parsed = submitAnswerSchema.safeParse(json);

  if (!parsed.success) {
    return fail("Invalid parameters", 400);
  }

  const { questionId, selectedIndex } = parsed.data;

  const question = await getQuestionById(questionId);
  if (!question) {
    return fail("Question not found", 404);
  }

  const isCorrect = selectedIndex === question.correctIndex;

  await recordAnswer({
    questionId,
    selectedIndex,
    isCorrect,
  });

  return ok({
    isCorrect,
    correctIndex: question.correctIndex,
    explanation: question.explanation,
  });
}, "POST /api/answers");
