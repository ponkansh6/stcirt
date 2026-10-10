import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/participants/results/route";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";

const findParticipantByIdMock = vi.hoisted(() =>
  vi.fn<(id: number) => Promise<{ id: number; name: string } | null>>(),
);

vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: findParticipantByIdMock,
}));
vi.mock("@/lib/db/repository/presentation-repository", () => ({ getParticipantResult: vi.fn() }));
vi.mock("@/lib/participants/answer-scope", () => ({ resolveAnswerScope: vi.fn() }));
vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: vi.fn((request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  ),
  verifyParticipantSession: vi.fn((token?: string) =>
    token === "valid-session" ? { id: 42, expiresAt: new Date() } : null,
  ),
}));

import { getParticipantResult } from "@/lib/db/repository/presentation-repository";

beforeEach(() => {
  vi.clearAllMocks();
  findParticipantByIdMock.mockResolvedValue({ id: 42, name: "参加者" });
  vi.mocked(resolveAnswerScope).mockResolvedValue({ participantId: 42 });
});

describe("GET /api/participants/results", () => {
  it("requires an existing participant session and never queries for an invalid session", async () => {
    const response = await GET(new Request("http://localhost/api/participants/results"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("rejects a session whose participant no longer exists", async () => {
    findParticipantByIdMock.mockResolvedValueOnce(null);
    const response = await GET(
      new Request("http://localhost/api/participants/results", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Participant session required" });
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

  it("rejects an invalid scope without querying a result", async () => {
    vi.mocked(resolveAnswerScope).mockResolvedValueOnce({
      error: "Invalid answer scope",
      status: 400,
    });

    const response = await GET(
      new Request("http://localhost/api/participants/results?scope=other", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Invalid answer scope" });
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("returns not found when no assisted target resolves without querying a result", async () => {
    vi.mocked(resolveAnswerScope).mockResolvedValueOnce({
      error: "Assisted participant not found",
      status: 404,
    });

    const response = await GET(
      new Request("http://localhost/api/participants/results?scope=assisted", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Assisted participant not found" });
    expect(resolveAnswerScope).toHaveBeenCalledWith(42, "assisted");
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("returns the unavailable state while results cannot be assembled", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({ state: "unavailable" });
    const response = await GET(
      new Request("http://localhost/api/participants/results", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ state: "unavailable" });
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

  it("projects free-text and unanswered answers without exposing extra fields", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({
      state: "visible",
      rank: 1,
      score: 0.75,
      questions: [
        {
          position: 0,
          question: "Explain",
          answer: { kind: "freeText", value: "My answer", score: 0.5 },
        },
        {
          position: 1,
          question: "Skipped",
          answer: { kind: "unanswered" },
        },
      ],
    });
    const response = await GET(
      new Request("http://localhost/api/participants/results", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      state: "visible",
      rank: 1,
      score: 0.75,
      questions: [
        {
          position: 0,
          question: "Explain",
          answer: { kind: "freeText", value: "My answer", score: 0.5 },
        },
        {
          position: 1,
          question: "Skipped",
          answer: { kind: "unanswered" },
        },
      ],
    });
  });

  it("maps repository failures to a generic no-store 503", async () => {
    vi.mocked(getParticipantResult).mockRejectedValueOnce(new Error("private database detail"));
    const response = await GET(
      new Request("http://localhost/api/participants/results", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Results are unavailable" });
  });
});
