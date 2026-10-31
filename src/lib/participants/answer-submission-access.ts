import { z } from "zod";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";
import { getParticipantCookie, verifyParticipantSession } from "@/lib/participants/security";

export type AnswerSubmissionAccess = {
  submissionId: string;
  participantId: number;
};

export type AnswerSubmissionAccessResult =
  | AnswerSubmissionAccess
  | { error: string; status: 400 | 401 | 404 };

/** Resolve the authenticated owner/assisted scope and requested submission ID. */
export async function resolveAnswerSubmissionAccess(
  request: Request,
): Promise<AnswerSubmissionAccessResult> {
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    return { error: "Participant session required", status: 401 };
  }

  const url = new URL(request.url);
  const scope = await resolveAnswerScope(session.id, url.searchParams.get("scope"));
  if ("error" in scope) return scope;

  const parsedId = z.uuid().safeParse(url.searchParams.get("submissionId"));
  if (!parsedId.success) return { error: "Invalid submission ID", status: 400 };

  return { submissionId: parsedId.data, participantId: scope.participantId };
}
