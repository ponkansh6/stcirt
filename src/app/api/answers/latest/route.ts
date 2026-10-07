import { fail, ok, withErrorHandling } from "@/lib/api/response";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { getLatestAnswerSubmission } from "@/lib/db/repository/answer-repository";
import { getParticipantCookie, verifyParticipantSession } from "@/lib/participants/security";

export const GET = withErrorHandling(async function (request: Request) {
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    const response = fail("Participant session required", 401);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  const submission = await getLatestAnswerSubmission(session.id);
  const response = ok({ submission });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}, "GET /api/answers/latest");
