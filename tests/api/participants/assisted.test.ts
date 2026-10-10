import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/participants/assisted/route";

const state = vi.hoisted(() => ({
  configured: true,
  session: { id: 7 } as { id: number } | null,
  participant: { id: 7, name: "本人" } as { id: number; name: string } | null,
  linked: null as { id: number; name: string } | null,
  hasSubmission: false,
  rate: { available: true, allowed: true, reservation: [] as unknown[] },
  dbRows: [] as Array<Array<{ id: string }>>,
  dbSelectIndex: 0,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => {
      const rows = state.dbRows[state.dbSelectIndex++] ?? [];
      return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
    }),
  },
}));
vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: vi.fn(async () => state.participant),
  normalizeParticipantName: vi.fn((name: string) => {
    const displayName = name.trim();
    return { displayName, normalizedName: displayName.normalize("NFC") };
  }),
}));
vi.mock("@/lib/db/repository/assisted-participant-repository", () => ({
  AssistedParticipantError: class AssistedParticipantError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  createAssistedParticipant: vi.fn(async (_ownerId: number, name: string) => ({
    id: 18,
    name: name.trim(),
  })),
  getAssistedParticipant: vi.fn(async () => state.linked),
}));
vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: vi.fn(() => "signed-session"),
  isParticipantAuthConfigured: vi.fn(() => state.configured),
  requestHasValidOrigin: vi.fn(
    (request: Request) => request.headers.get("origin") === new URL(request.url).origin,
  ),
  verifyParticipantSession: vi.fn(() => state.session),
}));
vi.mock("@/lib/participants/rate-limit", () => ({
  checkParticipantRateLimit: vi.fn(async () => state.rate),
  releaseParticipantAuthReservation: vi.fn(async () => true),
}));

import {
  AssistedParticipantError,
  createAssistedParticipant,
  getAssistedParticipant,
} from "@/lib/db/repository/assisted-participant-repository";
import {
  checkParticipantRateLimit,
  releaseParticipantAuthReservation,
} from "@/lib/participants/rate-limit";

const getRequest = () =>
  new Request("http://localhost/api/participants/assisted", {
    headers: { Cookie: "stcirt_participant_session=signed-session" },
  });
const postRequest = (body: unknown, origin = "http://localhost") =>
  new Request("http://localhost/api/participants/assisted", {
    method: "POST",
    headers: {
      Cookie: "stcirt_participant_session=signed-session",
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.configured = true;
  state.session = { id: 7 };
  state.participant = { id: 7, name: "本人" };
  state.linked = null;
  state.hasSubmission = false;
  state.rate = { available: true, allowed: true, reservation: [] };
  state.dbSelectIndex = 0;
  state.dbRows = [[], []];
});

describe("/api/participants/assisted", () => {
  it("returns whether the owner can add an assisted participant", async () => {
    state.dbRows = [[{ id: "owner-submission" }], []];
    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      participant: null,
      hasSubmission: false,
      eligible: true,
    });
  });

  it("requires an authenticated participant for status and registration", async () => {
    state.participant = null;
    expect((await GET(getRequest())).status).toBe(401);
    expect((await POST(postRequest({ name: "代理" }))).status).toBe(401);
    expect(createAssistedParticipant).not.toHaveBeenCalled();
  });

  it("fails closed when participant authentication is unavailable or expired", async () => {
    state.configured = false;
    expect((await GET(getRequest())).status).toBe(401);
    expect((await POST(postRequest({ name: "代理" }))).status).toBe(503);
    state.configured = true;
    state.session = null;
    expect((await GET(getRequest())).status).toBe(401);
    expect((await POST(postRequest({ name: "代理" }))).status).toBe(401);
    expect(createAssistedParticipant).not.toHaveBeenCalled();
  });

  it("accepts only a same-origin name-only registration and rate limits its normalized name", async () => {
    const badOrigin = await POST(postRequest({ name: "代理" }, "https://attacker.example"));
    expect(badOrigin.status).toBe(403);
    expect(checkParticipantRateLimit).not.toHaveBeenCalled();

    const invalidBody = await POST(postRequest({ name: "代理", pin: "0123" }));
    expect(invalidBody.status).toBe(400);
    expect((await POST(postRequest({ name: "   " }))).status).toBe(400);
    expect(createAssistedParticipant).not.toHaveBeenCalled();

    const response = await POST(postRequest({ name: "  代理  " }));
    expect(response.status).toBe(200);
    expect(createAssistedParticipant).toHaveBeenCalledWith(7, "  代理  ");
    expect(checkParticipantRateLimit).toHaveBeenCalledWith("代理");
    expect(releaseParticipantAuthReservation).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      participant: { id: 18, name: "代理" },
      hasSubmission: false,
    });
  });

  it("rejects malformed and non-object registration bodies and invalid name lengths", async () => {
    const malformed = await POST(
      new Request("http://localhost/api/participants/assisted", {
        method: "POST",
        headers: {
          Cookie: "stcirt_participant_session=signed-session",
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "Invalid request" });

    for (const body of [null, [], {}, { name: "x".repeat(121) }]) {
      const response = await POST(postRequest(body));
      expect(response.status).toBe(400);
    }
    expect(checkParticipantRateLimit).not.toHaveBeenCalled();
    expect(createAssistedParticipant).not.toHaveBeenCalled();
  });

  it("reports an already linked participant and completion state", async () => {
    state.linked = { id: 18, name: "代理" };
    state.dbRows = [[], [], [{ id: "target-submission" }]];
    vi.mocked(getAssistedParticipant).mockResolvedValueOnce(state.linked);
    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      participant: { id: 18, name: "代理" },
      hasSubmission: true,
      eligible: false,
    });
  });

  it("denies excessive attempts and returns repository conflicts as client errors", async () => {
    state.rate = { available: true, allowed: false, reservation: [] };
    const limited = await POST(postRequest({ name: "代理" }));
    expect(limited.status).toBe(429);
    expect(createAssistedParticipant).not.toHaveBeenCalled();

    state.rate = { available: true, allowed: true, reservation: [] };
    vi.mocked(createAssistedParticipant).mockRejectedValueOnce(
      new AssistedParticipantError("ほかの人の回答者はすでに登録されています", 409),
    );
    const conflict = await POST(postRequest({ name: "別の代理" }));
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(conflict.json()).resolves.toEqual({
      error: "ほかの人の回答者はすでに登録されています",
    });
    expect(releaseParticipantAuthReservation).toHaveBeenCalledOnce();
  });

  it("fails closed when rate limiting or reservation release is unavailable", async () => {
    state.rate = { available: false, allowed: false, reservation: [] };
    const rateUnavailable = await POST(postRequest({ name: "代理" }));
    expect(rateUnavailable.status).toBe(503);
    expect(releaseParticipantAuthReservation).not.toHaveBeenCalled();

    state.rate = { available: true, allowed: true, reservation: [] };
    vi.mocked(releaseParticipantAuthReservation).mockResolvedValueOnce(false);
    const releaseUnavailable = await POST(postRequest({ name: "代理" }));
    expect(releaseUnavailable.status).toBe(503);
    expect(createAssistedParticipant).toHaveBeenCalledWith(7, "代理");
  });

  it("releases the rate reservation and returns a generic error for unexpected repository failures", async () => {
    vi.mocked(createAssistedParticipant).mockRejectedValueOnce(
      new Error("sensitive database detail"),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(postRequest({ name: "代理" }));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
      expect(releaseParticipantAuthReservation).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledWith(
        "Error in POST /api/participants/assisted:",
        expect.any(Error),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("fails closed when an error response cannot release the authentication reservation", async () => {
    vi.mocked(createAssistedParticipant).mockRejectedValueOnce(
      new AssistedParticipantError("ほかの人の回答者はすでに登録されています", 409),
    );
    vi.mocked(releaseParticipantAuthReservation).mockResolvedValueOnce(false);

    const response = await POST(postRequest({ name: "代理" }));

    expect(response.status).toBe(503);
    expect(releaseParticipantAuthReservation).toHaveBeenCalledOnce();
  });
});
