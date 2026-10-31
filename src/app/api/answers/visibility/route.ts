import { fail, ok, withErrorHandling } from "@/lib/api/response";
import { getAnswerSubmissionVisibility } from "@/lib/db/repository/answer-repository";
import { resolveAnswerSubmissionAccess } from "@/lib/participants/answer-submission-access";

const getVisibility = withErrorHandling(async function (request: Request) {
  const access = await resolveAnswerSubmissionAccess(request);
  if ("error" in access) return fail(access.error, access.status);

  const visibility = await getAnswerSubmissionVisibility(access.submissionId, access.participantId);
  if (!visibility) return fail("Submission not found", 404);

  return ok(visibility);
}, "GET /api/answers/visibility");

export async function GET(request: Request) {
  const response = await getVisibility(request);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
