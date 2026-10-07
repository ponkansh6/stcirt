import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "@/app/api/admin/session/route";

const state = vi.hoisted(() => ({
  cookie: { set: vi.fn() },
  configured: true,
  authenticatedRequest: false,
  validPin: true,
  session: { value: "signed-admin-session", maxAge: 28_800 } as {
    value: string;
    maxAge: number;
  } | null,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => state.cookie),
}));

vi.mock("@/lib/presentation/admin-auth", () => ({
  ADMIN_PRESENTATION_COOKIE: "stcirt_admin_presentation",
  createAdminPresentationSession: vi.fn(() => state.session),
  isAdminPresentationAuthConfigured: vi.fn(() => state.configured),
  isAdminPresentationRequest: vi.fn(() => state.authenticatedRequest),
  verifyAdminPresentationPin: vi.fn((pin: unknown) => state.validPin && typeof pin === "string"),
}));

vi.mock("@/lib/participants/security", () => ({
  requestHasValidOrigin: vi.fn((request: Request) => {
    const origin = request.headers.get("origin");
    return origin === new URL(request.url).origin;
  }),
}));

function request(
  method: "GET" | "POST" | "DELETE",
  options: { origin?: string; body?: string; cookie?: string } = {},
) {
  return new Request("http://localhost/api/admin/session", {
    method,
    headers: {
      Host: "localhost",
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: options.body ?? JSON.stringify({ pin: "2468" }) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.cookie.set.mockReset();
  state.configured = true;
  state.authenticatedRequest = false;
  state.validPin = true;
  state.session = { value: "signed-admin-session", maxAge: 28_800 };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/admin/session route", () => {
  it("reports authentication only when admin auth is configured and the admin cookie is valid", async () => {
    state.authenticatedRequest = true;
    state.configured = false;
    const unavailable = await GET(request("GET", { cookie: "stcirt_admin_presentation=valid" }));
    expect(unavailable.status).toBe(200);
    await expect(unavailable.json()).resolves.toEqual({ authenticated: false });
    expect(unavailable.headers.get("cache-control")).toContain("no-store");

    state.configured = true;
    const authenticated = await GET(request("GET", { cookie: "stcirt_admin_presentation=valid" }));
    await expect(authenticated.json()).resolves.toEqual({ authenticated: true });

    state.authenticatedRequest = false;
    const participantOnly = await GET(
      request("GET", { cookie: "stcirt_participant_session=participant-token" }),
    );
    await expect(participantOnly.json()).resolves.toEqual({ authenticated: false });
  });

  it("rejects cross-origin login and fails closed when admin config is missing", async () => {
    const badOrigin = await POST(
      request("POST", {
        origin: "https://attacker.example",
        body: JSON.stringify({ pin: "2468" }),
      }),
    );
    expect(badOrigin.status).toBe(403);
    await expect(badOrigin.json()).resolves.toEqual({ error: "Invalid request origin" });

    state.configured = false;
    const unavailable = await POST(request("POST", { origin: "http://localhost" }));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "Admin sign-in is unavailable" });
    expect(state.cookie.set).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and an incorrect PIN", async () => {
    const malformed = await POST(request("POST", { origin: "http://localhost", body: "{" }));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "Invalid request" });

    state.validPin = false;
    const invalidPin = await POST(
      request("POST", { origin: "http://localhost", body: JSON.stringify({ pin: "wrong" }) }),
    );
    expect(invalidPin.status).toBe(401);
    await expect(invalidPin.json()).resolves.toEqual({ error: "Invalid PIN" });
    expect(state.cookie.set).not.toHaveBeenCalled();
  });

  it("rejects non-object JSON bodies and non-string PIN values", async () => {
    for (const body of ["null", JSON.stringify("2468"), JSON.stringify({ pin: 2468 })]) {
      const response = await POST(request("POST", { origin: "http://localhost", body }));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Invalid PIN" });
    }

    expect(state.cookie.set).not.toHaveBeenCalled();
  });

  it("issues a strict HttpOnly admin cookie after a valid PIN", async () => {
    const response = await POST(
      request("POST", { origin: "http://localhost", body: JSON.stringify({ pin: "2468" }) }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ authenticated: true });
    expect(state.cookie.set).toHaveBeenCalledWith(
      "stcirt_admin_presentation",
      "signed-admin-session",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 28_800,
      }),
    );
  });

  it("marks the admin cookie secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(request("POST", { origin: "http://localhost" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true });
    expect(state.cookie.set).toHaveBeenCalledWith(
      "stcirt_admin_presentation",
      "signed-admin-session",
      expect.objectContaining({ secure: true }),
    );

    state.cookie.set.mockClear();
    const logout = await DELETE(request("DELETE", { origin: "http://localhost" }));

    expect(logout.status).toBe(200);
    await expect(logout.json()).resolves.toEqual({ authenticated: false });
    expect(state.cookie.set).toHaveBeenCalledWith(
      "stcirt_admin_presentation",
      "",
      expect.objectContaining({ secure: true }),
    );
  });

  it("fails closed if session creation fails after PIN validation", async () => {
    state.session = null;
    const response = await POST(request("POST", { origin: "http://localhost" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Admin sign-in is unavailable" });
    expect(state.cookie.set).not.toHaveBeenCalled();
  });

  it("requires same-origin logout and clears the admin cookie", async () => {
    const denied = await DELETE(request("DELETE", { origin: "https://attacker.example" }));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "Invalid request origin" });
    expect(state.cookie.set).not.toHaveBeenCalled();

    const response = await DELETE(request("DELETE", { origin: "http://localhost" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(state.cookie.set).toHaveBeenCalledWith(
      "stcirt_admin_presentation",
      "",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
        expires: new Date(0),
      }),
    );
  });
});
