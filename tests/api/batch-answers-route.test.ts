import { beforeEach, describe, expect, it, vi } from "vitest";
import { after } from "next/server";
import { GET, POST } from "@/app/api/answers/batch/route";

const afterRef = vi.hoisted(() => ({ callback: null as null | (() => Promise<void>) }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    NextResponse: actual.NextResponse,
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
vi.mock("@/lib/participants/answer-scope", () => ({
  resolveAnswerScope: vi.fn(async (ownerId: number, scope: string | null) => {
    if (scope === null) return { participantId: ownerId };
    if (scope !== "assisted") return { error: "Invalid answer scope", status: 400 };
    return { participantId: 99 };
  }),
}));

import {
  BatchSubmissionError,
  getAnswerSubmission,
  processDueAssessments,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";

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

  it("GET resolves the assisted submission through the owner session", async () => {
    const submission = {
      submissionId,
      revision: 2,
      answers: answers.map((answer) => ({
        ...answer,
        answerKind: "selected" as const,
        freeText: null,
      })),
    };
    vi.mocked(getAnswerSubmission).mockResolvedValueOnce(submission);
    const response = await GET(
      new Request(
        `http://localhost/api/answers/batch?submissionId=${submissionId}&scope=assisted`,
        { headers: { Cookie: headers.Cookie } },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(submission);
    expect(getAnswerSubmission).toHaveBeenCalledWith(submissionId, 99);
  });

  it("GET rejects unknown and unlinked answer scopes before loading a submission", async () => {
    const invalid = await GET(
      new Request(`http://localhost/api/answers/batch?submissionId=${submissionId}&scope=other`, {
        headers: { Cookie: headers.Cookie },
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid answer scope" });

    vi.mocked(resolveAnswerScope).mockResolvedValueOnce({
      error: "Assisted participant not found",
      status: 404,
    });
    const unlinked = await GET(
      new Request(
        `http://localhost/api/answers/batch?submissionId=${submissionId}&scope=assisted`,
        { headers: { Cookie: headers.Cookie } },
      ),
    );
    expect(unlinked.status).toBe(404);
    await expect(unlinked.json()).resolves.toEqual({ error: "Assisted participant not found" });
    expect(getAnswerSubmission).not.toHaveBeenCalled();
  });

  it("GET returns 404 when the submission is absent", async () => {
    vi.mocked(getAnswerSubmission).mockResolvedValueOnce(null);

    const response = await GET(
      new Request(`http://localhost/api/answers/batch?submissionId=${submissionId}`, {
        headers: { Cookie: headers.Cookie },
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Submission not found" });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(getAnswerSubmission).toHaveBeenCalledWith(submissionId, 42);
  });

  it("GET rejects a deleted participant before looking up the submission", async () => {
    vi.mocked(findParticipantById).mockResolvedValueOnce(null);

    const response = await GET(
      new Request(`http://localhost/api/answers/batch?submissionId=${submissionId}`, {
        headers: { Cookie: headers.Cookie },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Participant session required" });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(findParticipantById).toHaveBeenCalledWith(42);
    expect(getAnswerSubmission).not.toHaveBeenCalled();
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

  it("POST stores an assisted answer under the linked participant, not the owner", async () => {
    vi.mocked(saveAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 1,
      assessmentTarget: null,
    });
    const response = await POST(
      new Request("http://localhost/api/answers/batch?scope=assisted", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    expect(saveAnswerSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ participantId: 99 }),
    );
  });

  it("POST rejects unknown and unlinked answer scopes before saving", async () => {
    const invalid = await POST(
      new Request("http://localhost/api/answers/batch?scope=other", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid answer scope" });

    vi.mocked(resolveAnswerScope).mockResolvedValueOnce({
      error: "Assisted participant not found",
      status: 404,
    });
    const unlinked = await POST(
      new Request("http://localhost/api/answers/batch?scope=assisted", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );
    expect(unlinked.status).toBe(404);
    await expect(unlinked.json()).resolves.toEqual({ error: "Assisted participant not found" });
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

  it("POST rejects malformed JSON without saving", async () => {
    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid parameters" });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(saveAnswerSubmission).not.toHaveBeenCalled();
    expect(afterRef.callback).toBeNull();
  });

  it.each([
    [400, "Invalid answer batch"],
    [404, "Submission not found"],
    [409, "Submission revision conflict"],
  ] as const)("POST maps BatchSubmissionError status %i", async (status, message) => {
    vi.mocked(saveAnswerSubmission).mockRejectedValueOnce(
      new BatchSubmissionError(message, status),
    );

    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers,
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(saveAnswerSubmission).toHaveBeenCalledWith({
      submissionId,
      operationId,
      expectedRevision: 0,
      answers,
      participantId: 42,
    });
    expect(afterRef.callback).toBeNull();
  });

  it("POST returns a generic 500 when the repository fails unexpectedly", async () => {
    vi.mocked(saveAnswerSubmission).mockRejectedValueOnce(new Error("sensitive repository detail"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(
        new Request("http://localhost/api/answers/batch", {
          method: "POST",
          headers,
          body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
        }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(errorLog).toHaveBeenCalledWith("Error in POST /api/answers/batch:", expect.any(Error));
      expect(afterRef.callback).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
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
