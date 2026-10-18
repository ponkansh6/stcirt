import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/jev/retry/route";

vi.mock("@/lib/db/repository/answer-repository", () => ({ processDueAssessments: vi.fn() }));

import { processDueAssessments } from "@/lib/db/repository/answer-repository";

describe("POST /api/internal/jev/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JEV_RETRY_SECRET", "internal-test-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "Bearer wrong-secret"])(
    "rejects missing or invalid credentials",
    async (authorization) => {
      const response = await POST(
        new Request("http://localhost/api/internal/jev/retry", {
          method: "POST",
          headers: authorization ? { authorization } : {},
        }),
      );
      expect(response.status).toBe(401);
      expect(processDueAssessments).not.toHaveBeenCalled();
    },
  );

  it("fails closed when retry credentials are not configured", async () => {
    vi.stubEnv("JEV_RETRY_SECRET", "");
    const response = await POST(
      new Request("http://localhost/api/internal/jev/retry", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(processDueAssessments).not.toHaveBeenCalled();
  });

  it("returns aggregate counters only and forwards privileged failed-job retry intent", async () => {
    vi.mocked(processDueAssessments).mockResolvedValue({
      processed: 3,
      graded: 1,
      retried: 1,
      failed: 1,
    });
    const response = await POST(
      new Request("http://localhost/api/internal/jev/retry?retryFailed=1", {
        method: "POST",
        headers: { authorization: "Bearer internal-test-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      processed: 3,
      graded: 1,
      retried: 1,
      failed: 1,
    });
    expect(processDueAssessments).toHaveBeenCalledWith(true);
  });

  it("ignores caller-supplied answerText and asks the repository to process persisted jobs", async () => {
    vi.mocked(processDueAssessments).mockResolvedValue({
      processed: 0,
      graded: 0,
      retried: 0,
      failed: 0,
    });
    const response = await POST(
      new Request("http://localhost/api/internal/jev/retry", {
        method: "POST",
        headers: {
          authorization: "Bearer internal-test-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ answerText: "attacker-controlled replacement" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(processDueAssessments).toHaveBeenCalledWith(false);
    expect(processDueAssessments).toHaveBeenCalledTimes(1);
  });
});
