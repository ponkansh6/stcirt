import { after, NextResponse } from "next/server";
import { fail, ok, withErrorHandling } from "@/lib/api/response";
import { submitAnswerBatchSchema } from "@/lib/api/schemas";
import {
  BatchSubmissionError,
  getAnswerSubmission,
  processDueAssessments,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  getParticipantCookie,
  requestHasValidOrigin,
  verifyParticipantSession,
} from "@/lib/participants/security";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";
import { resolveAnswerSubmissionAccess } from "@/lib/participants/answer-submission-access";

export const maxDuration = 60;

export const GET = withErrorHandling(async function (request: Request) {
  const access = await resolveAnswerSubmissionAccess(request);
  if ("error" in access) return fail(access.error, access.status);

  const submission = await getAnswerSubmission(access.submissionId, access.participantId);
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

  const scope = await resolveAnswerScope(
    session.id,
    new URL(request.url).searchParams.get("scope"),
  );
  if ("error" in scope) return fail(scope.error, scope.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid parameters", 400);
  }
  const parsed = submitAnswerBatchSchema.safeParse(body);
  if (!parsed.success) return fail("Invalid parameters", 400);

  try {
    const saved = await saveAnswerSubmission({
      ...parsed.data,
      participantId: scope.participantId,
    });
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
      if (error.code) {
        return NextResponse.json(
          { message: error.message, error: error.code },
          { status: error.status },
        );
      }
      return fail(error.message, error.status);
    }
    throw error;
  }
}, "POST /api/answers/batch");
