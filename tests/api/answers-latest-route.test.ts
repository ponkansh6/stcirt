import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/answers/latest/route";

vi.mock("@/lib/db/repository/participant-repository", () => ({ findParticipantById: vi.fn() }));
vi.mock("@/lib/db/repository/answer-repository", () => ({
  getLatestAnswerSubmission: vi.fn(),
}));
vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: vi.fn((request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  ),
  verifyParticipantSession: vi.fn((token?: string) =>
    token === "valid-session" ? { id: 42, expiresAt: new Date() } : null,
  ),
}));

import { getLatestAnswerSubmission } from "@/lib/db/repository/answer-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findParticipantById).mockResolvedValue({ id: 42, name: "参加者" });
});

describe("GET /api/answers/latest", () => {
  it("requires a valid participant session", async () => {
    const response = await GET(new Request("http://localhost/api/answers/latest"));
    expect(response.status).toBe(401);
    expect(getLatestAnswerSubmission).not.toHaveBeenCalled();
  });

  it("returns null when the participant has no submission", async () => {
    vi.mocked(getLatestAnswerSubmission).mockResolvedValueOnce(null);
    const response = await GET(
      new Request("http://localhost/api/answers/latest", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ submission: null });
    expect(getLatestAnswerSubmission).toHaveBeenCalledWith(42);
  });

  it("returns the latest participant-owned submission", async () => {
    const submission = { submissionId: "submission", revision: 2, answers: [] };
    vi.mocked(getLatestAnswerSubmission).mockResolvedValueOnce(submission);
    const response = await GET(
      new Request("http://localhost/api/answers/latest", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ submission });
  });
});
