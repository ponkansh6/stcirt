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
  slides: [{ state: "question", questionIndex: 0, projection: { state: "question" } }],
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
    await expect(response.json()).resolves.toEqual(deck);
    expect(getAdminPresentationDeck).toHaveBeenCalledOnce();
  });

  it("returns unavailable when loading the deck fails", async () => {
    vi.mocked(getAdminPresentationDeck).mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
});
