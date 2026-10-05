import { fail, ok, withErrorHandling } from "@/lib/api/response";
import { submitAnswerBatchSchema } from "@/lib/api/schemas";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  BatchSubmissionError,
  getAnswerSubmission,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";
import {
  getParticipantCookie,
  requestHasValidOrigin,
  verifyParticipantSession,
} from "@/lib/participants/security";
import { z } from "zod";

export const GET = withErrorHandling(async function (request: Request) {
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    return fail("Participant session required", 401);
  }

  const submissionId = new URL(request.url).searchParams.get("submissionId");
  const parsedId = z.uuid().safeParse(submissionId);
  if (!parsedId.success) return fail("Invalid submission ID", 400);

  const submission = await getAnswerSubmission(parsedId.data, session.id);
  if (!submission) return fail("Submission not found", 404);
  return ok(submission);
}, "GET /api/answers/batch");

export const POST = withErrorHandling(async function (request: Request) {
  if (!requestHasValidOrigin(request)) {
    return fail("Invalid request origin", 403);
  }

  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    return fail("Participant session required", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid parameters", 400);
  }
  const parsed = submitAnswerBatchSchema.safeParse(body);
  if (!parsed.success) return fail("Invalid parameters", 400);

  try {
    return ok(await saveAnswerSubmission({ ...parsed.data, participantId: session.id }));
  } catch (error) {
    if (error instanceof BatchSubmissionError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
}, "POST /api/answers/batch");
