import { getAssistedTargetId } from "@/lib/db/repository/assisted-participant-repository";

export type AnswerScopeResult =
  | { participantId: number }
  | { error: "Invalid answer scope"; status: 400 }
  | { error: "Assisted participant not found"; status: 404 };

export async function resolveAnswerScope(
  ownerParticipantId: number,
  scope: string | null,
): Promise<AnswerScopeResult> {
  if (scope === null) return { participantId: ownerParticipantId } satisfies AnswerScopeResult;
  if (scope !== "assisted") {
    return { error: "Invalid answer scope", status: 400 } satisfies AnswerScopeResult;
  }
  const participantId = await getAssistedTargetId(ownerParticipantId);
  if (participantId === null) {
    return { error: "Assisted participant not found", status: 404 } satisfies AnswerScopeResult;
  }
  return { participantId } satisfies AnswerScopeResult;
}
