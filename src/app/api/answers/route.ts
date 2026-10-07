import { getQuestionById } from "@/lib/db/repository/question-repository";
import { recordAnswer } from "@/lib/db/repository/answer-repository";
import { submitAnswerSchema } from "@/lib/api/schemas";
import { ok, fail, withErrorHandling } from "@/lib/api/response";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  getParticipantCookie,
  requestHasValidOrigin,
  verifyParticipantSession,
} from "@/lib/participants/security";

export const POST = withErrorHandling(async function (request: Request) {
  if (!requestHasValidOrigin(request)) {
    return fail("Invalid request origin", 403);
  }

  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    return fail("Participant session required", 401);
  }

  const json = await request.json();
  if (
    json &&
    typeof json === "object" &&
    Object.prototype.hasOwnProperty.call(json, "participantId")
  ) {
    return fail("Invalid parameters", 400);
  }
  const parsed = submitAnswerSchema.safeParse(json);

  if (!parsed.success) {
    return fail("Invalid parameters", 400);
  }

  const { questionId, selectedIndex } = parsed.data;

  const question = await getQuestionById(questionId);
  if (!question) {
    return fail("Question not found", 404);
  }
  if (question.choices.length === 0 || selectedIndex >= question.choices.length) {
    return fail("Invalid parameters", 400);
  }

  const isCorrect = selectedIndex === question.correctIndex;

  await recordAnswer({
    questionId,
    selectedIndex,
    isCorrect,
    participantId: session.id,
  });

  return ok({ recorded: true });
}, "POST /api/answers");
