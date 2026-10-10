import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/presentation/deck/route";

vi.mock("@/lib/presentation/admin-auth", () => ({
  isAdminPresentationAuthConfigured: vi.fn(),
  isAdminPresentationRequest: vi.fn(),
}));

vi.mock("@/lib/db/repository/presentation-repository", () => ({
  getAdminPresentationDeck: vi.fn(),
}));

import { getAdminPresentationDeck } from "@/lib/db/repository/presentation-repository";
import {
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
} from "@/lib/presentation/admin-auth";

const deck = {
  snapshotRevision: 3,
  questionCount: 1,
  questionIndex: 0,
  slides: [
    { state: "opening", questionIndex: 0, projection: { state: "opening" } },
    { state: "question", questionIndex: 0, projection: { state: "question" } },
    {
      state: "third",
      questionIndex: 0,
      projection: {
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
      },
    },
    {
      state: "second",
      questionIndex: 0,
      projection: {
        state: "second",
        winners: [{ displayName: "凛", score: 9, rank: 2, questionResults: [] }],
      },
    },
    {
      state: "first",
      questionIndex: 0,
      projection: {
        state: "first",
        winners: [{ displayName: "悠", score: 10, rank: 1, questionResults: [] }],
      },
    },
  ],
} satisfies Awaited<ReturnType<typeof getAdminPresentationDeck>>;

function request() {
  return new Request("http://localhost/api/admin/presentation/deck", {
    headers: { Host: "localhost" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAdminPresentationAuthConfigured).mockReturnValue(true);
  vi.mocked(isAdminPresentationRequest).mockReturnValue(true);
  vi.mocked(getAdminPresentationDeck).mockResolvedValue(deck);
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/admin/presentation/deck", () => {
  it("fails closed when auth is not configured or the request is unauthenticated", async () => {
    vi.mocked(isAdminPresentationAuthConfigured).mockReturnValueOnce(false);
    const unavailable = await GET(request());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store, private");

    vi.mocked(isAdminPresentationRequest).mockReturnValueOnce(false);
    const unauthorized = await GET(request());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store, private");
    expect(getAdminPresentationDeck).not.toHaveBeenCalled();
  });

  it("returns the complete deck without caching after authentication", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const payload = await response.json();
    expect(payload).toEqual(deck);
    expect(
      payload.slides
        .filter((slide: { state: string }) => ["third", "second", "first"].includes(slide.state))
        .every((slide: { projection: { winners: { questionResults?: unknown[] }[] } }) =>
          slide.projection.winners.every((winner) => Array.isArray(winner.questionResults)),
        ),
    ).toBe(true);
    expect(getAdminPresentationDeck).toHaveBeenCalledOnce();
  });

  it("returns unavailable when loading the deck fails", async () => {
    vi.mocked(getAdminPresentationDeck).mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
});
