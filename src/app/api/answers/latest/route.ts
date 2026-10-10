import { fail, ok, withErrorHandling } from "@/lib/api/response";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { getLatestAnswerSubmission } from "@/lib/db/repository/answer-repository";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";
import { getParticipantCookie, verifyParticipantSession } from "@/lib/participants/security";

export const GET = withErrorHandling(async function (request: Request) {
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    const response = fail("Participant session required", 401);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  const scope = await resolveAnswerScope(
    session.id,
    new URL(request.url).searchParams.get("scope"),
  );
  if ("error" in scope) return fail(scope.error, scope.status);
  const submission = await getLatestAnswerSubmission(scope.participantId);
  const response = ok({ submission });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}, "GET /api/answers/latest");
