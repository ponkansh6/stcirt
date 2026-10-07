import { after } from "next/server";
import { fail, ok, withErrorHandling } from "@/lib/api/response";
import { submitAnswerBatchSchema } from "@/lib/api/schemas";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  BatchSubmissionError,
  getAnswerSubmission,
  processDueAssessments,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";
import {
  getParticipantCookie,
  requestHasValidOrigin,
  verifyParticipantSession,
} from "@/lib/participants/security";
import { z } from "zod";

export const maxDuration = 60;

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
    const saved = await saveAnswerSubmission({ ...parsed.data, participantId: session.id });
    if (saved.assessmentTarget) {
      const target = saved.assessmentTarget;
      try {
        after(async () => {
          if (!process.env.TYPESAFE_API_KEY) {
            console.warn("answer_assessment_skipped", { reason: "missing_api_key" });
            return;
          }
          try {
            await processDueAssessments(false, target);
          } catch {
            console.error("answer_assessment_failed", { reason: "worker_failed" });
          }
        });
      } catch {
        console.error("answer_assessment_failed", { reason: "schedule_failed" });
      }
    }
    return ok({ submissionId: saved.submissionId, revision: saved.revision });
  } catch (error) {
    if (error instanceof BatchSubmissionError) {
      return fail(error.message, error.status);
    }
    throw error;
  }
}, "POST /api/answers/batch");
