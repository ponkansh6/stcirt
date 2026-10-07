import { beforeEach, describe, expect, it, vi } from "vitest";
import { after } from "next/server";
import { GET, POST } from "@/app/api/answers/batch/route";

const afterRef = vi.hoisted(() => ({ callback: null as null | (() => Promise<void>) }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((callback: () => Promise<void>) => {
      afterRef.callback = callback;
    }),
  };
});

vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: vi.fn(),
}));

vi.mock("@/lib/db/repository/answer-repository", () => ({
  BatchSubmissionError: class BatchSubmissionError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 404 | 409,
    ) {
      super(message);
    }
  },
  getAnswerSubmission: vi.fn(),
  processDueAssessments: vi.fn(),
  saveAnswerSubmission: vi.fn(),
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

import {
  getAnswerSubmission,
  processDueAssessments,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";

const submissionId = "550e8400-e29b-41d4-a716-446655440000";
const operationId = "550e8400-e29b-41d4-a716-446655440001";
const headers = {
  "Content-Type": "application/json",
  Origin: "http://localhost",
  Cookie: "stcirt_participant_session=valid-session",
};
const answers = [1, 2, 3, 4, 5].map((questionId) => ({ questionId, selectedIndex: 0 }));

beforeEach(() => {
  vi.clearAllMocks();
  afterRef.callback = null;
  process.env.TYPESAFE_API_KEY = "test-key";
  vi.mocked(findParticipantById).mockResolvedValue({ id: 42, name: "参加者" });
});

describe("/api/answers/batch route handlers", () => {
  it("GET requires an authenticated participant", async () => {
    const response = await GET(
      new Request(`http://localhost/api/answers/batch?submissionId=${submissionId}`),
    );

    expect(response.status).toBe(401);
    expect(getAnswerSubmission).not.toHaveBeenCalled();
  });

  it("GET rejects an invalid submission ID", async () => {
    const response = await GET(
      new Request("http://localhost/api/answers/batch?submissionId=invalid", {
        headers: { Cookie: headers.Cookie },
      }),
    );

    expect(response.status).toBe(400);
    expect(getAnswerSubmission).not.toHaveBeenCalled();
  });

  it("GET returns the participant's submission", async () => {
    const submission = {
      submissionId,
      revision: 1,
      answers: answers.map((answer) => ({
        ...answer,
        answerKind: "selected" as const,
        freeText: null,
      })),
    };
    vi.mocked(getAnswerSubmission).mockResolvedValueOnce(submission);

    const response = await GET(
      new Request(`http://localhost/api/answers/batch?submissionId=${submissionId}`, {
        headers: { Cookie: headers.Cookie },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(submission);
    expect(getAnswerSubmission).toHaveBeenCalledWith(submissionId, 42);
  });

  it("POST rejects an invalid Origin", async () => {
    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers: { ...headers, Origin: "https://attacker.example" },
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(403);
    expect(saveAnswerSubmission).not.toHaveBeenCalled();
  });

  it("POST requires an authenticated participant", async () => {
    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers: { "Content-Type": headers["Content-Type"], Origin: headers.Origin },
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(401);
    expect(saveAnswerSubmission).not.toHaveBeenCalled();
  });

  it("POST rejects participantId in the body", async () => {
    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({
          submissionId,
          operationId,
          expectedRevision: 0,
          answers,
          participantId: 999,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(saveAnswerSubmission).not.toHaveBeenCalled();
  });

  it("POST rejects invalid answers", async () => {
    const invalidAnswers = answers.map((answer, index) =>
      index === 0 ? { ...answer, selectedIndex: 4 } : answer,
    );
    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({
          submissionId,
          operationId,
          expectedRevision: 0,
          answers: invalidAnswers,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(saveAnswerSubmission).not.toHaveBeenCalled();
  });

  it("POST passes the authenticated participant to the repository and returns its result", async () => {
    const result = {
      submissionId,
      revision: 1,
      assessmentTarget: { submissionId, revision: 1 },
    };
    vi.mocked(saveAnswerSubmission).mockResolvedValueOnce(result);

    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ submissionId, revision: 1 });
    expect(saveAnswerSubmission).toHaveBeenCalledWith({
      submissionId,
      operationId,
      expectedRevision: 0,
      answers,
      participantId: 42,
    });
    expect(afterRef.callback).not.toBeNull();
    await afterRef.callback?.();
    expect(processDueAssessments).toHaveBeenCalledWith(false, { submissionId, revision: 1 });
  });

  it("does not trigger assessment for an idempotent operation replay", async () => {
    vi.mocked(saveAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 1,
      assessmentTarget: null,
    });
    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    expect(afterRef.callback).toBeNull();
  });

  it("keeps the assessment pending when the JEV key is missing", async () => {
    delete process.env.TYPESAFE_API_KEY;
    vi.mocked(saveAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 1,
      assessmentTarget: { submissionId, revision: 1 },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    await afterRef.callback?.();
    expect(processDueAssessments).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("answer_assessment_skipped", {
      reason: "missing_api_key",
    });
    warn.mockRestore();
  });

  it("keeps the successful response and logs only a fixed reason when after registration fails", async () => {
    vi.mocked(saveAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 1,
      assessmentTarget: { submissionId, revision: 1 },
    });
    vi.mocked(after).mockImplementationOnce(() => {
      throw new Error("sensitive registration detail");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ submissionId, revision: 1 });
    expect(errorLog).toHaveBeenCalledWith("answer_assessment_failed", {
      reason: "schedule_failed",
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it("keeps the successful response and logs only a fixed reason when the after worker fails", async () => {
    vi.mocked(saveAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 1,
      assessmentTarget: { submissionId, revision: 1 },
    });
    vi.mocked(processDueAssessments).mockRejectedValueOnce(new Error("sensitive worker detail"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ submissionId, revision: 1 });
    await afterRef.callback?.();
    expect(errorLog).toHaveBeenCalledWith("answer_assessment_failed", {
      reason: "worker_failed",
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });
});
