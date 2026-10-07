import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/admin/participant-results/route";
import {
  createAdminPresentationSession,
  ADMIN_PRESENTATION_COOKIE,
} from "@/lib/presentation/admin-auth";

vi.mock("@/lib/db/repository/presentation-repository", () => ({
  setParticipantResultsVisible: vi.fn(),
  PresentationConflictError: class PresentationConflictError extends Error {},
}));

import { setParticipantResultsVisible } from "@/lib/db/repository/presentation-repository";

const envKeys = ["ADMIN_PRESENTATION_PIN", "ADMIN_PRESENTATION_SESSION_SECRET"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function request(options: { cookie?: string; origin?: string; body?: unknown } = {}) {
  return new Request("http://localhost/api/admin/participant-results", {
    method: "POST",
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      Host: "localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.body),
  });
}

function authenticate() {
  const session = createAdminPresentationSession();
  if (!session) throw new Error("Test admin session was not created");
  return `${ADMIN_PRESENTATION_COOKIE}=${session.value}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_PRESENTATION_PIN = "admin-pin";
  process.env.ADMIN_PRESENTATION_SESSION_SECRET =
    "admin-test-session-secret-with-at-least-32-bytes";
  vi.mocked(setParticipantResultsVisible).mockImplementation(async (visible) => ({ visible }));
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("POST /api/admin/participant-results", () => {
  it("requires admin authentication, same-origin mutation, and a boolean visibility value", async () => {
    expect((await POST(request({ body: { visible: true } }))).status).toBe(401);
    const cookie = authenticate();
    expect(
      (await POST(request({ cookie, origin: "https://attacker.example", body: { visible: true } })))
        .status,
    ).toBe(403);
    expect(
      (await POST(request({ cookie, origin: "http://localhost", body: { visible: "true" } })))
        .status,
    ).toBe(400);
    expect(setParticipantResultsVisible).not.toHaveBeenCalled();
  });

  it("publishes through the repository snapshot operation and maps conflicts to 409", async () => {
    const cookie = authenticate();
    const Conflict = (await import("@/lib/db/repository/presentation-repository"))
      .PresentationConflictError;
    const response = await POST(
      request({ cookie, origin: "http://localhost", body: { visible: true } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ visible: true });
    expect(setParticipantResultsVisible).toHaveBeenCalledWith(true);

    vi.mocked(setParticipantResultsVisible).mockRejectedValueOnce(
      new Conflict("Presentation is locked"),
    );
    const conflict = await POST(
      request({ cookie, origin: "http://localhost", body: { visible: true } }),
    );
    expect(conflict.status).toBe(409);
  });

  it("forwards hide and republish transitions to the repository", async () => {
    const cookie = authenticate();
    for (const visible of [false, true]) {
      const response = await POST(
        request({ cookie, origin: "http://localhost", body: { visible } }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ visible });
    }
    expect(setParticipantResultsVisible).toHaveBeenNthCalledWith(1, false);
    expect(setParticipantResultsVisible).toHaveBeenNthCalledWith(2, true);
  });
});
