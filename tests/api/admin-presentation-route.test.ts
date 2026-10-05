import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/admin/presentation/route";
import {
  createAdminPresentationSession,
  ADMIN_PRESENTATION_COOKIE,
} from "@/lib/presentation/admin-auth";

vi.mock("@/lib/db/repository/presentation-repository", () => ({
  getAdminPresentation: vi.fn(),
  operatePresentation: vi.fn(),
  PresentationConflictError: class PresentationConflictError extends Error {
    readonly status = 409;
  },
}));

import {
  getAdminPresentation,
  operatePresentation,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";

const envKeys = ["ADMIN_PRESENTATION_PIN", "ADMIN_PRESENTATION_SESSION_SECRET"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const operationId = "550e8400-e29b-41d4-a716-446655440001";
const adminPayload = {
  state: "question",
  version: 1,
  questionIndex: 0,
  questionCount: 1,
  projectionHidden: false,
  presentationMode: "full",
  questions: [],
  entries: [],
} satisfies Awaited<ReturnType<typeof getAdminPresentation>>;

function authenticate() {
  const session = createAdminPresentationSession();
  if (!session) throw new Error("Test admin session was not created");
  return `${ADMIN_PRESENTATION_COOKIE}=${session.value}`;
}

function request(
  method: "GET" | "POST",
  options: { cookie?: string; origin?: string; body?: unknown } = {},
) {
  return new Request("http://localhost/api/admin/presentation", {
    method,
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      Host: "localhost",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_PRESENTATION_PIN = "admin-pin";
  process.env.ADMIN_PRESENTATION_SESSION_SECRET =
    "admin-test-session-secret-with-at-least-32-bytes";
  vi.mocked(getAdminPresentation).mockResolvedValue(adminPayload);
  vi.mocked(operatePresentation).mockResolvedValue(adminPayload);
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("/api/admin/presentation route", () => {
  it("fails closed for missing config and rejects participant-only cookies", async () => {
    delete process.env.ADMIN_PRESENTATION_PIN;
    const unavailable = await GET(request("GET"));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toContain("no-store");

    process.env.ADMIN_PRESENTATION_PIN = "admin-pin";
    const unauthorized = await GET(
      request("GET", { cookie: "stcirt_participant_session=participant-token" }),
    );
    expect(unauthorized.status).toBe(401);
    expect(getAdminPresentation).not.toHaveBeenCalled();
  });

  it("returns the complete admin payload without caching after admin authentication", async () => {
    const response = await GET(request("GET", { cookie: authenticate() }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual(adminPayload);
    expect(getAdminPresentation).toHaveBeenCalledOnce();
  });

  it("requires same-origin mutations and validates setMode payloads", async () => {
    const cookie = authenticate();
    const badOrigin = await POST(
      request("POST", {
        cookie,
        origin: "https://attacker.example",
        body: { operationId, action: "setMode", mode: "short" },
      }),
    );
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get("cache-control")).toContain("no-store");

    const invalidMode = await POST(
      request("POST", {
        cookie,
        origin: "http://localhost",
        body: { operationId, action: "setMode", mode: "fast" },
      }),
    );
    expect(invalidMode.status).toBe(400);
    expect(operatePresentation).not.toHaveBeenCalled();

    const valid = await POST(
      request("POST", {
        cookie,
        origin: "http://localhost",
        body: { operationId, action: "setMode", mode: "short" },
      }),
    );
    expect(valid.status).toBe(200);
    expect(operatePresentation).toHaveBeenCalledWith(operationId, "setMode", "short");
  });

  it("returns state conflicts as 409", async () => {
    vi.mocked(operatePresentation).mockRejectedValueOnce(
      new PresentationConflictError("Presentation is already at its first state"),
    );
    const response = await POST(
      request("POST", {
        cookie: authenticate(),
        origin: "http://localhost",
        body: { operationId, action: "previous" },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Presentation is already at its first state",
    });
  });
});
