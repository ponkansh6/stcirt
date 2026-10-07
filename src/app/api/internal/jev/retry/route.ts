import { timingSafeEqual } from "node:crypto";
import { processDueAssessments } from "@/lib/db/repository/answer-repository";
import { fail, ok, withErrorHandling } from "@/lib/api/response";

export const runtime = "nodejs";

export const POST = withErrorHandling(async function (request: Request) {
  const secret = process.env.JEV_RETRY_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const expected = secret ? `Bearer ${secret}` : "";
  if (
    !secret ||
    authorization.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
  ) {
    return fail("Unauthorized", 401);
  }
  const retryFailed = new URL(request.url).searchParams.get("retryFailed") === "1";
  return ok(await processDueAssessments(retryFailed));
}, "POST /api/internal/jev/retry");
