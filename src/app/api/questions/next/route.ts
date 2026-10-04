import { getNextQuestion } from "@/lib/db/repository/question-repository";
import { ok, fail, withErrorHandling } from "@/lib/api/response";

export const GET = withErrorHandling(async function (request: Request) {
  const url = new URL(request.url);
  const afterIdParam = url.searchParams.get("afterId");
  const afterId = afterIdParam === null ? undefined : Number(afterIdParam);
  if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 1)) {
    return fail("Invalid question cursor", 400);
  }

  const question = await getNextQuestion(afterId);

  if (!question) {
    return fail("No questions available", 404);
  }

  return ok(question);
}, "GET /api/questions/next");
