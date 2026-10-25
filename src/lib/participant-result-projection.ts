import type { ParticipantResult as RepositoryParticipantResult } from "@/lib/db/repository/presentation-repository";
import type { ParticipantResult } from "./participant-results-contract";

export function mapParticipantResult(result: RepositoryParticipantResult): ParticipantResult {
  if (result.state !== "visible") {
    return { state: result.state };
  }

  return {
    state: "visible",
    rank: result.rank,
    isAggregationTarget: result.isAggregationTarget,
    participantCount: result.participantCount,
    score: result.score,
    maxScore: result.maxScore,
    questions: result.questions.map(({ position, question, answer }) => ({
      position,
      question,
      answer:
        answer.kind === "selected"
          ? {
              kind: "selected",
              value: answer.value,
              correctness: answer.correctness,
            }
          : answer.kind === "freeText"
            ? { kind: "freeText", value: answer.value, score: answer.score }
            : { kind: answer.kind },
    })),
  };
}
