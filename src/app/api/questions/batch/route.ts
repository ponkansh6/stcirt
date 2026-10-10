import { getExamQuestions } from "@/lib/db/repository/question-repository";
import { ok, withErrorHandling } from "@/lib/api/response";

export const GET = withErrorHandling(async function () {
  const questions = await getExamQuestions();
  return ok({ questions });
}, "GET /api/questions/batch");
