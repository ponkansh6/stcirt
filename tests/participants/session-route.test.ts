import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ participant: null as { id: number; name: string } | null }));

vi.mock("@/lib/db/repository/participant-repository", () => ({
  findParticipantById: vi.fn(async () => state.participant),
  getOrCreateParticipant: vi.fn(),
  normalizeParticipantName: vi.fn(),
}));
vi.mock("@/lib/participants/security", () => ({
  createParticipantSession: vi.fn(),
  getParticipantCookie: vi.fn(() => "valid-cookie"),
  isParticipantAuthConfigured: vi.fn(() => true),
  PARTICIPANT_COOKIE: "stcirt_participant_session",
  participantSessionLifetimeSeconds: vi.fn(() => 3600),
  requestHasValidOrigin: vi.fn(() => true),
  verifyEventPin: vi.fn(),
  verifyParticipantSession: vi.fn(() => ({ id: 99, expiresAt: new Date() })),
}));
vi.mock("@/lib/participants/rate-limit", () => ({
  checkParticipantRateLimit: vi.fn(),
  commitParticipantAuthFailure: vi.fn(),
  releaseParticipantAuthReservation: vi.fn(),
}));

import { GET } from "@/app/api/participants/session/route";
import { findParticipantById } from "@/lib/db/repository/participant-repository";

describe("participant session lookup", () => {
  beforeEach(() => {
    state.participant = null;
    vi.clearAllMocks();
  });

  it("does not authenticate a signed cookie whose participant no longer exists", async () => {
    const response = await GET(
      new Request("http://localhost/api/participants/session", {
        headers: { cookie: "stcirt_participant_session=valid-cookie" },
      }),
    );

    expect(findParticipantById).toHaveBeenCalledWith(99);
    expect(await response.json()).toEqual({ participant: null });
  });
});
