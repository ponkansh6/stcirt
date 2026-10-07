import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/participants/results/route";

vi.mock("@/lib/db/repository/participant-repository", () => ({ findParticipantById: vi.fn() }));
vi.mock("@/lib/db/repository/presentation-repository", () => ({ getParticipantResult: vi.fn() }));
vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: vi.fn((request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  ),
  verifyParticipantSession: vi.fn((token?: string) =>
    token === "valid-session" ? { id: 42, expiresAt: new Date() } : null,
  ),
}));

import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findParticipantById).mockResolvedValue({ id: 42, name: "参加者" });
});

describe("GET /api/participants/results", () => {
  it("requires an existing participant session and never queries for an invalid session", async () => {
    const response = await GET(new Request("http://localhost/api/participants/results"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("returns only the waiting state while results are private", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({ state: "waiting" });
    const response = await GET(
      new Request("http://localhost/api/participants/results", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ state: "waiting" });
    expect(getParticipantResult).toHaveBeenCalledWith(42);
  });

  it("returns only the authenticated participant's rank, score, and question details", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce(
      Object.assign(
        { state: "visible" as const, rank: 3, score: 0.5 },
        {
          questions: [
            {
              position: 0,
              question: "Question",
              answer: {
                kind: "selected" as const,
                value: "My choice",
                correctness: "incorrect" as const,
              },
            },
          ],
        },
      ),
    );
    const response = await GET(
      new Request("http://localhost/api/participants/results?participantId=7", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    await expect(response.json()).resolves.toEqual({
      state: "visible",
      rank: 3,
      score: 0.5,
      questions: [
        {
          position: 0,
          question: "Question",
          answer: { kind: "selected", value: "My choice", correctness: "incorrect" },
        },
      ],
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getParticipantResult).toHaveBeenCalledWith(42);
  });
});
