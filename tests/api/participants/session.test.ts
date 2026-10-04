import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "@/app/api/participants/session/route";

const state = vi.hoisted(() => ({
  cookie: { set: vi.fn() },
  token: "signed-session",
  configured: true,
  session: {
    id: 7,
    value: "signed-session",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  },
  rate: {
    available: true,
    allowed: true,
    reservation: [{ fingerprint: "name", windowStartedAt: new Date() }],
  } as Record<string, unknown>,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => state.cookie),
}));

vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: vi.fn(async (id: number) => (id === 7 ? { id: 7, name: "山田" } : null)),
  getOrCreateParticipant: vi.fn(async (name: string) => ({ id: 7, name: name.trim() })),
  normalizeParticipantName: vi.fn((name: string) => {
    const displayName = name.trim();
    return { displayName, normalizedName: displayName.normalize("NFC") };
  }),
}));

vi.mock("@/lib/participants/security", () => ({
  createParticipantSession: vi.fn(() => (state.configured ? state.session : null)),
  getParticipantCookie: vi.fn(() => state.token),
  isParticipantAuthConfigured: vi.fn(() => state.configured),
  PARTICIPANT_COOKIE: "stcirt_participant_session",
  participantSessionLifetimeSeconds: vi.fn(() => (state.configured ? 3600 : null)),
  requestHasValidOrigin: vi.fn(
    (request: Request) => request.headers.get("origin") === new URL(request.url).origin,
  ),
  verifyEventPin: vi.fn((pin: string) => pin === "0427"),
  verifyParticipantSession: vi.fn((token?: string) =>
    token === "signed-session" ? { id: 7 } : null,
  ),
}));

vi.mock("@/lib/participants/rate-limit", () => ({
  checkParticipantRateLimit: vi.fn(async () => state.rate),
  commitParticipantAuthFailure: vi.fn(async () => true),
  releaseParticipantAuthReservation: vi.fn(async () => true),
}));

import {
  findParticipantById,
  getOrCreateParticipant,
} from "@/lib/db/repository/participant-repository";
import {
  checkParticipantRateLimit,
  commitParticipantAuthFailure,
  releaseParticipantAuthReservation,
} from "@/lib/participants/rate-limit";
import { verifyEventPin } from "@/lib/participants/security";

const request = (body?: unknown, origin = "http://localhost") =>
  new Request("http://localhost/api/participants/session", {
    method: "POST",
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.cookie.set.mockReset();
  state.token = "signed-session";
  state.configured = true;
  state.rate = {
    available: true,
    allowed: true,
    reservation: [{ fingerprint: "name", windowStartedAt: new Date() }],
  };
});

describe("participant session API", () => {
  it("creates or reuses a normalized participant and issues an HttpOnly session cookie", async () => {
    const response = await POST(request({ name: " 山田 ", pin: "0427" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ participant: { id: 7, name: "山田" } });
    expect(getOrCreateParticipant).toHaveBeenCalledWith(" 山田 ");
    expect(checkParticipantRateLimit).toHaveBeenCalledWith("山田");
    expect(releaseParticipantAuthReservation).toHaveBeenCalledOnce();
    expect(state.cookie.set).toHaveBeenCalledWith(
      "stcirt_participant_session",
      "signed-session",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 3600,
      }),
    );
    expect(JSON.stringify(body)).not.toContain("0427");
  });

  it("rejects requests without a matching Origin", async () => {
    const response = await POST(request({ name: "山田", pin: "0427" }, "https://attacker.example"));
    expect(response.status).toBe(403);
    expect(checkParticipantRateLimit).not.toHaveBeenCalled();
  });

  it("fails closed when event authentication settings are missing", async () => {
    state.configured = false;
    const response = await POST(request({ name: "山田", pin: "0427" }));
    expect(response.status).toBe(503);
    expect(getOrCreateParticipant).not.toHaveBeenCalled();
    expect(state.cookie.set).not.toHaveBeenCalled();
  });

  it("creates a session without requiring client IP headers", async () => {
    const response = await POST(request({ name: "山田", pin: "0427" }));

    expect(response.status).toBe(200);
    expect(checkParticipantRateLimit).toHaveBeenCalledWith("山田");
    expect(verifyEventPin).toHaveBeenCalledWith("0427");
  });

  it("records an invalid PIN attempt without returning secret data", async () => {
    const response = await POST(request({ name: "山田", pin: "9999" }));
    expect(response.status).toBe(401);
    expect(commitParticipantAuthFailure).toHaveBeenCalledOnce();
    expect(getOrCreateParticipant).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("9999");
  });

  it("rejects a limited attempt", async () => {
    state.rate = { available: true, allowed: false, retryAt: new Date("2030-01-01T00:00:00.000Z") };
    const response = await POST(request({ name: "山田", pin: "0427" }));
    expect(response.status).toBe(429);
    expect(verifyEventPin).not.toHaveBeenCalled();
    expect(getOrCreateParticipant).not.toHaveBeenCalled();
  });

  it("returns the participant for a valid signed cookie and null for an invalid one", async () => {
    const valid = await GET(new Request("http://localhost/api/participants/session"));
    expect(await valid.json()).toEqual({ participant: { id: 7, name: "山田" } });
    expect(findParticipantById).toHaveBeenCalledWith(7);

    state.token = "tampered";
    const invalid = await GET(new Request("http://localhost/api/participants/session"));
    expect(await invalid.json()).toEqual({ participant: null });
  });

  it("clears the participant cookie on logout and requires a matching Origin", async () => {
    const denied = await DELETE(request(undefined, "https://attacker.example"));
    expect(denied.status).toBe(403);
    expect(state.cookie.set).not.toHaveBeenCalled();

    const response = await DELETE(request());
    expect(response.status).toBe(200);
    expect(state.cookie.set).toHaveBeenCalledWith(
      "stcirt_participant_session",
      "",
      expect.objectContaining({
        path: "/",
        maxAge: 0,
        expires: new Date(0),
      }),
    );
  });
});
