import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getSharedResult } from "@/app/api/shared-results/[token]/route";
import {
  DELETE as stopShare,
  GET as getShareState,
  POST as issueShare,
} from "@/app/api/participants/results/share/route";
import {
  checkOwnerShareManagementRateLimit,
  checkOwnerShareStopRateLimit,
  getOwnerShare,
  issueAssistedResultShare,
  readRateLimitedSharedParticipantResult,
  revokeAssistedResultShare,
} from "@/lib/participants/assisted-result-sharing";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { isParticipantAuthConfigured, verifyParticipantSession } from "@/lib/participants/security";

vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: vi.fn(async () => ({ id: 42, name: "owner" })),
}));
vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: vi.fn(() => "valid-session"),
  isParticipantAuthConfigured: vi.fn(() => true),
  requestHasValidOrigin: vi.fn(
    (request: Request) => request.headers.get("origin") === "http://localhost",
  ),
  verifyParticipantSession: vi.fn(() => ({ id: 42, expiresAt: new Date() })),
}));
vi.mock("@/lib/participants/assisted-result-sharing", () => ({
  checkOwnerShareManagementRateLimit: vi.fn(async () => true),
  checkOwnerShareStopRateLimit: vi.fn(async () => true),
  getOwnerShare: vi.fn(),
  issueAssistedResultShare: vi.fn(),
  readRateLimitedSharedParticipantResult: vi.fn(),
  revokeAssistedResultShare: vi.fn(),
  sharedResultHeaders: (extra?: HeadersInit) => {
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  },
}));

beforeEach(() => vi.clearAllMocks());

const validToken = `v1.${"a".repeat(43)}.${"b".repeat(43)}`;

function assertResponse(response: Response | undefined): asserts response is Response {
  if (!response) throw new Error("expected a response");
}

describe("shared result routes", () => {
  it("returns an indistinguishable no-store 404 for an invalid public token", async () => {
    vi.mocked(readRateLimitedSharedParticipantResult).mockResolvedValueOnce({ state: "not_found" });
    const response = await getSharedResult(
      new Request("http://localhost/api/shared-results/not-a-token"),
      { params: Promise.resolve({ token: "not-a-token" }) },
    );
    assertResponse(response);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    await expect(response.json()).resolves.toEqual({ error: "NOT_FOUND" });
  });

  it("returns only the normal result contract for a valid share", async () => {
    vi.mocked(readRateLimitedSharedParticipantResult).mockResolvedValueOnce({
      state: "ok",
      result: {
        state: "visible",
        rank: 1,
        isAggregationTarget: true,
        participantCount: 1,
        score: 1,
        maxScore: 1,
        questions: [{ position: 0, question: "Question", answer: { kind: "unanswered" } }],
      },
    });
    const response = await getSharedResult(
      new Request(`http://localhost/api/shared-results/${validToken}`, {
        headers: { Cookie: "stcirt_participant_session=irrelevant" },
      }),
      { params: Promise.resolve({ token: validToken }) },
    );
    assertResponse(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ state: "visible", rank: 1 });
    expect(readRateLimitedSharedParticipantResult).toHaveBeenCalledWith(validToken);
  });

  it("returns a no-store 503 when the public result service is unavailable", async () => {
    vi.mocked(readRateLimitedSharedParticipantResult).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const response = await getSharedResult(
      new Request(`http://localhost/api/shared-results/${validToken}`),
      { params: Promise.resolve({ token: validToken }) },
    );
    assertResponse(response);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "RESULT_UNAVAILABLE" });
  });

  it("returns share status without exposing a token", async () => {
    vi.mocked(getOwnerShare).mockResolvedValueOnce({
      targetId: 77,
      share: {
        targetId: 77,
        issuedAt: new Date("2026-10-01T00:00:00Z"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const response = await getShareState(
      new Request("http://localhost/api/participants/results/share", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(response);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.clone().json())).not.toContain("token");
    await expect(response.json()).resolves.toMatchObject({ exists: true, expired: false });
  });

  it("returns only the relative share path on issue and stops idempotently", async () => {
    vi.mocked(issueAssistedResultShare).mockResolvedValueOnce({
      token: validToken,
      issuedAt: new Date("2026-10-01T00:00:00Z"),
      expiresAt: new Date("2026-10-31T00:00:00Z"),
    });
    const request = () =>
      new Request("http://localhost/api/participants/results/share", {
        method: "POST",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      });
    const response = await issueShare(request());
    assertResponse(response);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      path: `/shared-results/${validToken}`,
    });

    const stopped = await stopShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "DELETE",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(stopped);
    expect(stopped.status).toBe(200);
    expect(revokeAssistedResultShare).toHaveBeenCalledWith(42);
    expect(checkOwnerShareManagementRateLimit).toHaveBeenCalledWith(42);
    expect(checkOwnerShareStopRateLimit).toHaveBeenCalledWith(42);
  });

  it("fails closed when owner authentication is unavailable or no longer valid", async () => {
    vi.mocked(isParticipantAuthConfigured).mockReturnValueOnce(false);
    const unavailable = await getShareState(
      new Request("http://localhost/api/participants/results/share"),
    );
    assertResponse(unavailable);
    expect(unavailable.status).toBe(401);

    vi.mocked(verifyParticipantSession).mockReturnValueOnce(null);
    const invalidSession = await getShareState(
      new Request("http://localhost/api/participants/results/share"),
    );
    assertResponse(invalidSession);
    expect(invalidSession.status).toBe(401);

    vi.mocked(findParticipantById).mockResolvedValueOnce(null);
    const deletedOwner = await getShareState(
      new Request("http://localhost/api/participants/results/share"),
    );
    assertResponse(deletedOwner);
    expect(deletedOwner.status).toBe(401);

    vi.mocked(isParticipantAuthConfigured).mockReturnValueOnce(false);
    const issueUnauthorized = await issueShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "POST",
        headers: { Origin: "http://localhost" },
      }),
    );
    assertResponse(issueUnauthorized);
    expect(issueUnauthorized.status).toBe(401);

    vi.mocked(isParticipantAuthConfigured).mockReturnValueOnce(false);
    const stopUnauthorized = await stopShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "DELETE",
        headers: { Origin: "http://localhost" },
      }),
    );
    assertResponse(stopUnauthorized);
    expect(stopUnauthorized.status).toBe(401);
  });

  it("enforces management rate limits and handles missing or expired share state", async () => {
    vi.mocked(checkOwnerShareManagementRateLimit).mockResolvedValueOnce(false);
    const limitedState = await getShareState(
      new Request("http://localhost/api/participants/results/share", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(limitedState);
    expect(limitedState.status).toBe(429);

    vi.mocked(getOwnerShare).mockResolvedValueOnce({ targetId: null, share: null });
    const missing = await getShareState(
      new Request("http://localhost/api/participants/results/share", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(missing);
    expect(missing.status).toBe(404);

    vi.mocked(getOwnerShare).mockResolvedValueOnce({
      targetId: 77,
      share: {
        targetId: 77,
        issuedAt: new Date("2026-09-01T00:00:00Z"),
        expiresAt: new Date("2026-09-02T00:00:00Z"),
      },
    });
    const expired = await getShareState(
      new Request("http://localhost/api/participants/results/share", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(expired);
    await expect(expired.json()).resolves.toMatchObject({ exists: true, expired: true });

    vi.mocked(getOwnerShare).mockResolvedValueOnce({ targetId: 77, share: null });
    const absent = await getShareState(
      new Request("http://localhost/api/participants/results/share", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(absent);
    await expect(absent.json()).resolves.toEqual({
      exists: false,
      issuedAt: null,
      expiresAt: null,
      expired: false,
    });

    vi.mocked(getOwnerShare).mockRejectedValueOnce(new Error("database unavailable"));
    const unavailable = await getShareState(
      new Request("http://localhost/api/participants/results/share", {
        headers: { Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(unavailable);
    expect(unavailable.status).toBe(503);
  });

  it("handles origin, rate limit, domain, and availability failures for issue", async () => {
    const noOrigin = await issueShare(
      new Request("http://localhost/api/participants/results/share", { method: "POST" }),
    );
    assertResponse(noOrigin);
    expect(noOrigin.status).toBe(403);

    vi.mocked(checkOwnerShareManagementRateLimit).mockResolvedValueOnce(false);
    const limited = await issueShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "POST",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(limited);
    expect(limited.status).toBe(429);

    vi.mocked(issueAssistedResultShare).mockResolvedValueOnce({ error: "NO_ASSISTED_TARGET" });
    const missing = await issueShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "POST",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(missing);
    expect(missing.status).toBe(404);

    vi.mocked(issueAssistedResultShare).mockResolvedValueOnce({ error: "SHARE_NOT_PUBLISHED" });
    const unpublished = await issueShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "POST",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(unpublished);
    expect(unpublished.status).toBe(409);

    vi.mocked(issueAssistedResultShare).mockRejectedValueOnce(new Error("database unavailable"));
    const unavailable = await issueShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "POST",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(unavailable);
    expect(unavailable.status).toBe(503);
  });

  it("returns no-store errors for stop origin, rate limit, and persistence failures", async () => {
    const noOrigin = await stopShare(
      new Request("http://localhost/api/participants/results/share", { method: "DELETE" }),
    );
    assertResponse(noOrigin);
    expect(noOrigin.status).toBe(403);

    vi.mocked(checkOwnerShareStopRateLimit).mockResolvedValueOnce(false);
    const limited = await stopShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "DELETE",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(limited);
    expect(limited.status).toBe(429);

    vi.mocked(revokeAssistedResultShare).mockRejectedValueOnce(new Error("database unavailable"));
    const unavailable = await stopShare(
      new Request("http://localhost/api/participants/results/share", {
        method: "DELETE",
        headers: { Origin: "http://localhost", Cookie: "stcirt_participant_session=valid-session" },
      }),
    );
    assertResponse(unavailable);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
