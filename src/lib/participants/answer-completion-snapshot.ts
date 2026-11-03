import "server-only";
import { answerCompletionSnapshotSchema } from "@/lib/api/schemas";
import { getAnswerSubmissionCompletionVisibility } from "@/lib/db/repository/answer-repository";
import { getParticipantResultState } from "@/lib/db/repository/presentation-repository.reads";

type AnswerCompletionSnapshot = ReturnType<typeof answerCompletionSnapshotSchema.parse>;

export async function getAnswerCompletionSnapshot(input: {
  scope: "owner" | "assisted";
  ownerParticipantId: number;
  participantId: number;
  submissionId: string;
  revision: number;
}): Promise<AnswerCompletionSnapshot> {
  const identity = {
    scope: input.scope,
    ownerParticipantId: input.ownerParticipantId,
    participantId: input.participantId,
    submissionId: input.submissionId,
    revision: input.revision,
  };

  try {
    // Each repository reader opens its own transaction. Keep them sequential
    // so SQLite-backed deployments do not contend over concurrent read txs.
    const resultsState = await getParticipantResultState(input.participantId);
    const submissionVisibility = await getAnswerSubmissionCompletionVisibility(
      input.submissionId,
      input.participantId,
    );
    if (!submissionVisibility || submissionVisibility.revision !== input.revision) {
      throw new Error("Answer completion snapshot identity mismatch");
    }
    if ((resultsState === "waiting") !== !submissionVisibility.resultsVisible) {
      throw new Error("Answer completion snapshot publication state changed during read");
    }

    return answerCompletionSnapshotSchema.parse({
      status: "ready",
      identity,
      resultsState,
      resultsVisible: submissionVisibility.resultsVisible,
    });
  } catch {
    return answerCompletionSnapshotSchema.parse({
      status: "failed",
      identity,
      resultsState: null,
      resultsVisible: null,
    });
  }
}
