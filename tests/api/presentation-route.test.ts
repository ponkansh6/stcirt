import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repository/presentation-repository", () => ({
  getPublicPresentation: vi.fn(),
}));

import { GET } from "@/app/api/presentation/route";
import { getPublicPresentation } from "@/lib/db/repository/presentation-repository";

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

  it("returns a private no-store error when projection loading fails", async () => {
    vi.mocked(getPublicPresentation).mockRejectedValueOnce(new Error("projection unavailable"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ error: "Presentation is unavailable" });
  });
});
