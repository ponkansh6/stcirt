import { beforeEach, describe, it, expect, vi } from "vitest";
import { POST } from "@/app/api/answers/route";

// Mock repositories and schemas
vi.mock("@/lib/db/repository/question-repository", () => ({
  getQuestionById: vi.fn(),
}));

vi.mock("@/lib/db/repository/answer-repository", () => ({
  recordAnswer: vi.fn(),
}));

vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: vi.fn(),
}));

vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: vi.fn((request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  ),
  requestHasValidOrigin: vi.fn(
    (request: Request) => request.headers.get("origin") === new URL(request.url).origin,
  ),
  verifyParticipantSession: vi.fn((token?: string) =>
    token === "valid-session" ? { id: 42, expiresAt: new Date() } : null,
  ),
}));

import { getQuestionById } from "@/lib/db/repository/question-repository";
import { recordAnswer } from "@/lib/db/repository/answer-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";

const headers = {
  "Content-Type": "application/json",
  Origin: "http://localhost",
  Cookie: "stcirt_participant_session=valid-session",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findParticipantById).mockResolvedValue({ id: 42, name: "参加者" });
});

describe("POST /api/answers route handler", () => {
  it("1. Valid request -> 200 with grading", async () => {
    vi.mocked(getQuestionById).mockResolvedValueOnce({
      id: 1,
      key: "it-literacy-001",
      question: "Q1?",
      choices: ["A", "B", "C", "D"],
      correctIndex: 1,
      explanation: "Explanation 1",
      createdAt: new Date(),
    });

    const req = new Request("http://localhost/api/answers", {
      method: "POST",
      headers,
      body: JSON.stringify({ questionId: 1, selectedIndex: 1 }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      isCorrect: true,
      correctIndex: 1,
      explanation: "Explanation 1",
    });
    expect(recordAnswer).toHaveBeenCalledWith({
      questionId: 1,
      selectedIndex: 1,
      isCorrect: true,
      participantId: 42,
    });
  });

  it("2. Wrong answer -> isCorrect false", async () => {
    vi.mocked(getQuestionById).mockResolvedValueOnce({
      id: 1,
      key: "it-literacy-001",
      question: "Q1?",
      choices: ["A", "B", "C", "D"],
      correctIndex: 1,
      explanation: "Explanation 1",
      createdAt: new Date(),
    });

    const req = new Request("http://localhost/api/answers", {
      method: "POST",
      headers,
      body: JSON.stringify({ questionId: 1, selectedIndex: 0 }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.isCorrect).toBe(false);
    expect(recordAnswer).toHaveBeenCalledWith({
      questionId: 1,
      selectedIndex: 0,
      isCorrect: false,
      participantId: 42,
    });
  });

  it("3. Invalid selectedIndex (out of range) -> 400", async () => {
    const req = new Request("http://localhost/api/answers", {
      method: "POST",
      headers,
      body: JSON.stringify({ questionId: 1, selectedIndex: 99 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("4. Invalid questionId (non-number) -> 400", async () => {
    const req = new Request("http://localhost/api/answers", {
      method: "POST",
      headers,
      body: JSON.stringify({ questionId: "abc", selectedIndex: 0 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("5. Question not found -> 404", async () => {
    vi.mocked(getQuestionById).mockResolvedValueOnce(null);

    const req = new Request("http://localhost/api/answers", {
      method: "POST",
      headers,
      body: JSON.stringify({ questionId: 999, selectedIndex: 0 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("requires a valid participant cookie and matching Origin", async () => {
    const noCookie = await POST(
      new Request("http://localhost/api/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ questionId: 1, selectedIndex: 0 }),
      }),
    );
    expect(noCookie.status).toBe(401);

    const wrongOrigin = await POST(
      new Request("http://localhost/api/answers", {
        method: "POST",
        headers: { ...headers, Origin: "https://attacker.example" },
        body: JSON.stringify({ questionId: 1, selectedIndex: 0 }),
      }),
    );
    expect(wrongOrigin.status).toBe(403);
    expect(recordAnswer).not.toHaveBeenCalled();
  });

  it("rejects participantId supplied in the request body", async () => {
    const req = new Request("http://localhost/api/answers", {
      method: "POST",
      headers,
      body: JSON.stringify({ questionId: 1, selectedIndex: 0, participantId: 999 }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(recordAnswer).not.toHaveBeenCalled();
  });
});
