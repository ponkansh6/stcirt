import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repository/presentation-repository", () => ({
  getPublicPresentation: vi.fn(),
}));

import { GET } from "@/app/api/presentation/route";
import { getPublicPresentation } from "@/lib/db/repository/presentation-repository";

const responseBoundaryCases = [
  {
    state: "answer" as const,
    question: {
      id: 5,
      ordinal: 5,
      total: 5,
      question: "第五問",
      choices: [],
      answerType: "freeText" as const,
      expectedAnswer: "模範回答",
    },
  },
  { state: "standby" as const },
] satisfies Awaited<ReturnType<typeof getPublicPresentation>>[];

beforeEach(() => vi.clearAllMocks());

describe("GET /api/presentation", () => {
  it("returns the repository projection unchanged with no-store caching", async () => {
    vi.mocked(getPublicPresentation).mockResolvedValueOnce({
      state: "answer",
      question: {
        id: 105,
        ordinal: 5,
        total: 5,
        question: "Fifth question",
        choices: [],
        answerType: "freeText",
        expectedAnswer: "Model answer",
      },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    const payload = await response.json();
    expect(payload).toEqual({
      state: "answer",
      question: {
        id: 105,
        ordinal: 5,
        total: 5,
        question: "Fifth question",
        choices: [],
        answerType: "freeText",
        expectedAnswer: "Model answer",
      },
    });
    expect(payload.question).not.toHaveProperty("responses");
  });

  it("returns only the current rank's winners with their question breakdowns", async () => {
    vi.mocked(getPublicPresentation).mockResolvedValueOnce({
      state: "third",
      winners: [
        {
          displayName: "葵",
          score: 8,
          rank: 3,
          questionResults: [
            {
              position: 0,
              question: "一問目",
              answer: { kind: "selected", value: "青" },
              correctness: "correct",
            },
          ],
        },
      ],
    });

    const response = await GET();
    const payload = await response.json();

    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(payload).toEqual({
      state: "third",
      winners: [
        {
          displayName: "葵",
          score: 8,
          rank: 3,
          questionResults: [
            {
              position: 0,
              question: "一問目",
              answer: { kind: "selected", value: "青" },
              correctness: "correct",
            },
          ],
        },
      ],
    });
    expect(payload.winners).toHaveLength(1);
    expect(payload.winners[0]).not.toHaveProperty("rawScore");
  });

  it.each(responseBoundaryCases)(
    "preserves the response boundary for $state projections",
    async (projection) => {
      vi.mocked(getPublicPresentation).mockResolvedValueOnce(projection);

      const response = await GET();
      const payload = await response.json();

      expect(payload).toEqual(projection);
      if (payload.state === "answer") expect(payload.question).not.toHaveProperty("responses");
      if (payload.state === "standby") expect(Object.keys(payload)).toEqual(["state"]);
    },
  );

  it("returns a private no-store error when projection loading fails", async () => {
    vi.mocked(getPublicPresentation).mockRejectedValueOnce(new Error("projection unavailable"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ error: "Presentation is unavailable" });
  });
});
