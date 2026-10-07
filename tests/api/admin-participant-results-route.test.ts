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
import { makePresentationOperationError } from "@/lib/presentation/operation-diagnostics";

const envKeys = ["ADMIN_PRESENTATION_PIN", "ADMIN_PRESENTATION_SESSION_SECRET"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function request(
  options: {
    cookie?: string;
    origin?: string;
    body?: unknown;
    vercelId?: string;
  } = {},
) {
  return new Request("http://localhost/api/admin/participant-results", {
    method: "POST",
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      Host: "localhost",
      "Content-Type": "application/json",
      ...(options.vercelId ? { "x-vercel-id": options.vercelId } : {}),
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
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const conflict = await POST(
        request({
          cookie,
          origin: "http://localhost",
          body: { visible: true },
          vercelId: "hnd1::conflict-request-id",
        }),
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({ error: "Presentation is locked" });
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        event: "admin_participant_results_conflict",
        vercelRequestId: "hnd1::conflict-request-id",
        reason: "other_conflict",
      });
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["Presentation session is unavailable", "session_unavailable"],
    ["Results are not ready", "results_not_ready"],
    ["Free-response assessments must finish before presentation starts", "free_response_pending"],
  ])("logs a safe fixed reason for %s", async (message, reason) => {
    const cookie = authenticate();
    const Conflict = (await import("@/lib/db/repository/presentation-repository"))
      .PresentationConflictError;
    vi.mocked(setParticipantResultsVisible).mockRejectedValueOnce(new Conflict(message));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(
        request({
          cookie,
          origin: "http://localhost",
          body: { visible: true },
          vercelId: "hnd1::known-conflict-id",
        }),
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: message });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        event: "admin_participant_results_conflict",
        vercelRequestId: "hnd1::known-conflict-id",
        reason,
      });
      expect(String(log.mock.calls[0]?.[0])).not.toContain(message);
    } finally {
      log.mockRestore();
    }
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

  it("returns the generic failure and logs only safe structured diagnostics", async () => {
    const cookie = authenticate();
    const error = makePresentationOperationError("source_questions_read", {
      code: "SQLITE_BUSY_SNAPSHOT",
      message: "private row and secret details",
    });
    vi.mocked(setParticipantResultsVisible).mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(
        new Request("http://localhost/api/admin/participant-results", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: "http://localhost",
            Host: "localhost",
            "Content-Type": "application/json",
            "x-vercel-id": "hnd1::safe-request-id",
          },
          body: JSON.stringify({ visible: true }),
        }),
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Admin presentation is unavailable",
      });
      expect(log).toHaveBeenCalledTimes(1);
      const logged = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(logged)).toEqual({
        event: "admin_participant_results_failed",
        vercelRequestId: "hnd1::safe-request-id",
        phase: "source_questions_read",
        errorKind: "database",
        databaseCode: "SQLITE_BUSY_SNAPSHOT",
        clientErrorClass: null,
        clientCode: null,
      });
      expect(logged).not.toContain("private row");
    } finally {
      log.mockRestore();
    }
  });

  it("uses a generated correlation ID when x-vercel-id is missing or malformed", async () => {
    const cookie = authenticate();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const vercelId of [undefined, "malformed id"]) {
        vi.mocked(setParticipantResultsVisible).mockRejectedValueOnce(new Error("private detail"));
        const outgoingRequest = vercelId
          ? new Request("http://localhost/api/admin/participant-results", {
              method: "POST",
              headers: {
                Cookie: cookie,
                Origin: "http://localhost",
                Host: "localhost",
                "Content-Type": "application/json",
                "x-vercel-id": vercelId,
              },
              body: JSON.stringify({ visible: true }),
            })
          : request({ cookie, origin: "http://localhost", body: { visible: true } });
        await POST(outgoingRequest);
        const logged = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          vercelRequestId: string;
        };
        expect(logged.vercelRequestId).toMatch(/^generated:[0-9a-f-]{36}$/);
      }
      expect(String(log.mock.calls[0]?.[0])).not.toContain("private detail");
    } finally {
      log.mockRestore();
    }
  });
});
