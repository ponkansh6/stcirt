import { describe, expect, it } from "vitest";
import { parseParticipantResult } from "@/lib/participant-results-contract";

describe("participant result contract", () => {
  it("accepts a free-text score up to one point within a one-question maximum", () => {
    expect(
      parseParticipantResult({
        state: "visible",
        score: 0.75,
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
            question: "Q5",
            answer: { kind: "freeText", value: "Answer", score: 0.75 },
          },
        ],
      }),
    ).toMatchObject({ state: "visible", score: 0.75, maxScore: 1 });
  });

  it("rejects an extra maximum-score point beyond the question count", () => {
    expect(
      parseParticipantResult({
        state: "visible",
        score: 2,
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
    ).toBeNull();
  });
});
