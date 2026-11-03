import "server-only";
import { answerBootstrapSchema } from "@/lib/api/schemas";
import { getLatestAnswerSubmission } from "@/lib/db/repository/answer-repository";
import { getAssistedParticipant } from "@/lib/db/repository/assisted-participant-repository";
import { getExamQuestions } from "@/lib/db/repository/question-repository";
import { getAnswerCompletionSnapshot } from "@/lib/participants/answer-completion-snapshot";

export type AnswerBootstrapMode = "owner" | "assisted";
export type AnswerBootstrapOwner = { id: number; name: string };
export type AnswerBootstrapResult = ReturnType<typeof answerBootstrapSchema.parse>;

export class AnswerBootstrapError extends Error {
  constructor(
    message: string,
    readonly status: 404,
  ) {
    super(message);
    this.name = "AnswerBootstrapError";
  }
}

export async function getAnswerBootstrap(
  owner: AnswerBootstrapOwner,
  mode: AnswerBootstrapMode,
): Promise<AnswerBootstrapResult> {
  const participant = mode === "owner" ? owner : await getAssistedParticipant(owner.id);
  if (!participant) {
    throw new AnswerBootstrapError("Assisted participant not found", 404);
  }

  const submission = await getLatestAnswerSubmission(participant.id);
  if (submission !== null) {
    const completionSnapshot = await getAnswerCompletionSnapshot({
      scope: mode,
      ownerParticipantId: owner.id,
      participantId: participant.id,
      submissionId: submission.submissionId,
      revision: submission.revision,
    });
    return answerBootstrapSchema.parse({
      mode,
      owner,
      participant,
      submission,
      completionSnapshot,
    });
  }

  const questions = await getExamQuestions();
  return answerBootstrapSchema.parse({
    mode,
    owner,
    participant,
    submission,
    completionSnapshot: null,
    questions,
  });
}
