import { describe, expect, it } from "vitest";
import { parseParticipantResult } from "@/lib/participant-results-contract";

describe("participant result contract", () => {
  it("accepts the extra Q5 point in the published maximum score", () => {
    expect(
      parseParticipantResult({
        state: "visible",
        score: 1,
        maxScore: 2,
        rank: 1,
        isAggregationTarget: true,
        isReference: false,
        equivalentRank: null,
        participantCount: 1,
        rankParticipantCount: 1,
        questions: [
          {
            position: 0,
            question: "A question",
            answer: { kind: "selected", value: "Answer", correctness: "correct" },
          },
        ],
      }),
    ).toMatchObject({ state: "visible", score: 1, maxScore: 2 });
  });

  it("continues accepting snapshots that use the legacy one-point-per-question maximum", () => {
    expect(
      parseParticipantResult({
        state: "visible",
        score: 1,
        maxScore: 1,
        rank: 1,
        isAggregationTarget: true,
        isReference: false,
        equivalentRank: null,
        participantCount: 1,
        rankParticipantCount: 1,
        questions: [
          {
            position: 0,
            question: "A question",
            answer: { kind: "selected", value: "Answer", correctness: "correct" },
          },
        ],
      }),
    ).toMatchObject({ state: "visible", score: 1, maxScore: 1 });
  });
});
