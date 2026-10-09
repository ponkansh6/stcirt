import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/admin/presentation/route";

vi.mock("@/lib/presentation/admin-auth", () => ({
  isAdminPresentationAuthConfigured: vi.fn(),
  isAdminPresentationRequest: vi.fn(),
  isValidAdminMutation: vi.fn(),
}));

vi.mock("@/lib/db/repository/presentation-repository", () => ({
  getAdminPresentation: vi.fn(),
  getAdminPresentationControls: vi.fn(),
  operatePresentationControls: vi.fn(),
  PresentationConflictError: class PresentationConflictError extends Error {
    readonly status = 409;
  },
}));

import {
  getAdminPresentation,
  getAdminPresentationControls,
  operatePresentationControls,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";
import {
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
  isValidAdminMutation,
} from "@/lib/presentation/admin-auth";

const operationId = "550e8400-e29b-41d4-a716-446655440001";
const adminPayload = {
  state: "question",
  version: 1,
  snapshotRevision: 1,
  questionIndex: 0,
  questionCount: 1,
  projectionHidden: false,
  participantResultsVisible: false,
  participantResultsReady: false,
  questions: [],
  entries: [],
} satisfies Awaited<ReturnType<typeof getAdminPresentation>>;
const controlsPayload = {
  state: "question",
  version: 1,
  snapshotRevision: 1,
  questionIndex: 0,
  questionCount: 1,
  projectionHidden: false,
} satisfies Awaited<ReturnType<typeof getAdminPresentationControls>>;

function request(
  method: "GET" | "POST",
  options: { origin?: string; body?: unknown; rawBody?: string } = {},
) {
  return new Request("http://localhost/api/admin/presentation", {
    method,
    headers: {
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      Host: "localhost",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: options.rawBody ?? JSON.stringify(options.body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAdminPresentationAuthConfigured).mockReturnValue(true);
  vi.mocked(isAdminPresentationRequest).mockReturnValue(true);
  vi.mocked(isValidAdminMutation).mockReturnValue(true);
  vi.mocked(getAdminPresentation).mockResolvedValue(adminPayload);
  vi.mocked(getAdminPresentationControls).mockResolvedValue({
    state: "question",
    version: 1,
    snapshotRevision: 1,
    questionIndex: 0,
    questionCount: 1,
    projectionHidden: false,
  });
  vi.mocked(operatePresentationControls).mockResolvedValue(controlsPayload);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/admin/presentation route", () => {
  it("fails closed for missing config and rejects unauthenticated requests", async () => {
    vi.mocked(isAdminPresentationAuthConfigured).mockReturnValueOnce(false);
    const unavailable = await GET(request("GET"));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store, private");

    vi.mocked(isAdminPresentationRequest).mockReturnValueOnce(false);
    const unauthorized = await GET(request("GET"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store, private");
    expect(getAdminPresentation).not.toHaveBeenCalled();
  });

  it("returns the admin payload without caching after authentication", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual(adminPayload);
    expect(getAdminPresentation).toHaveBeenCalledOnce();
  });

  it("returns compact controls when view=controls is requested", async () => {
    const response = await GET(
      new Request("http://localhost/api/admin/presentation?view=controls", {
        headers: { Host: "localhost" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      state: "question",
      version: 1,
      snapshotRevision: 1,
      questionIndex: 0,
      questionCount: 1,
      projectionHidden: false,
    });
    expect(getAdminPresentationControls).toHaveBeenCalledOnce();
    expect(getAdminPresentation).not.toHaveBeenCalled();
  });

  it("returns unavailable when loading presenter controls fails", async () => {
    vi.mocked(getAdminPresentationControls).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await GET(
      new Request("http://localhost/api/admin/presentation?view=controls", {
        headers: { Host: "localhost" },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("returns unavailable when loading the admin payload fails", async () => {
    vi.mocked(getAdminPresentation).mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(request("GET"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("returns unavailable and both authorization failures for mutations", async () => {
    vi.mocked(isAdminPresentationAuthConfigured).mockReturnValueOnce(false);
    const unavailable = await POST(request("POST", { body: {} }));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store, private");

    vi.mocked(isValidAdminMutation).mockReturnValueOnce(false);
    vi.mocked(isAdminPresentationRequest).mockReturnValueOnce(false);
    const unauthorized = await POST(request("POST", { body: {} }));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store, private");

    vi.mocked(isValidAdminMutation).mockReturnValueOnce(false);
    vi.mocked(isAdminPresentationRequest).mockReturnValueOnce(true);
    const invalidOrigin = await POST(request("POST", { body: {} }));
    expect(invalidOrigin.status).toBe(403);
    expect(invalidOrigin.headers.get("cache-control")).toBe("no-store, private");
    expect(operatePresentationControls).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid operation fields", async () => {
    const malformedJson = await POST(request("POST", { rawBody: "{" }));
    expect(malformedJson.status).toBe(400);

    const invalidBodies: unknown[] = [
      null,
      { action: "start" },
      { operationId: 42, action: "start" },
      { operationId: "not-a-uuid", action: "start" },
      { operationId, action: "aggregate", mode: "full" },
      { operationId, action: "start", expectedSnapshotRevision: -1 },
      { operationId, action: "start", expectedSnapshotRevision: 1.5 },
      { operationId, action: "start", expectedSnapshotRevision: "1" },
      { operationId, action: "setMode" },
      { operationId, action: "setMode", mode: "fast" },
      { operationId, action: "setMode", mode: "full" },
      { operationId, action: "setMode", mode: "short" },
      { operationId, action: "start", mode: "full" },
    ];
    for (const body of invalidBodies) {
      const response = await POST(request("POST", { body }));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
    }
    expect(operatePresentationControls).not.toHaveBeenCalled();
  });

  it.each(["aggregate", "start", "advance", "previous", "hide", "show", "reset"] as const)(
    "operates %s without a mode and returns compact controls",
    async (action) => {
      const response = await POST(request("POST", { body: { operationId, action } }));

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      await expect(response.json()).resolves.toEqual({
        state: controlsPayload.state,
        version: controlsPayload.version,
        snapshotRevision: controlsPayload.snapshotRevision,
        questionIndex: controlsPayload.questionIndex,
        questionCount: controlsPayload.questionCount,
        projectionHidden: controlsPayload.projectionHidden,
      });
      expect(operatePresentationControls).toHaveBeenCalledWith(operationId, action);
    },
  );

  it("forwards the expected snapshot revision for presenter actions", async () => {
    const response = await POST(
      request("POST", {
        body: { operationId, action: "advance", expectedSnapshotRevision: 3 },
      }),
    );

    expect(response.status).toBe(200);
    expect(operatePresentationControls).toHaveBeenCalledWith(operationId, "advance", 3);
  });

  it("returns state conflicts as 409", async () => {
    vi.mocked(operatePresentationControls).mockRejectedValueOnce(
      new PresentationConflictError("Presentation is already at its first state"),
    );
    const response = await POST(request("POST", { body: { operationId, action: "previous" } }));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toMatchObject({
      error: "Presentation is already at its first state",
    });
  });

  it("returns unavailable for unexpected operation errors", async () => {
    vi.mocked(operatePresentationControls).mockRejectedValueOnce(new Error("database unavailable"));
    const response = await POST(request("POST", { body: { operationId, action: "advance" } }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
});
