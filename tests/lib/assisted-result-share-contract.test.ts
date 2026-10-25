import { afterEach, describe, expect, it } from "vitest";
import {
  hashShareToken,
  isShareToken,
  sharedResultHeaders,
} from "@/lib/participants/assisted-result-sharing";
import { signParticipantShareToken } from "@/lib/participants/security";
import { isAssistedResultShareState } from "@/lib/assisted-result-share-contract";

const originalPin = process.env.PARTICIPANT_PIN;
const originalSecret = process.env.PARTICIPANT_SESSION_SECRET;
const originalSessionDays = process.env.PARTICIPANT_SESSION_DAYS;

afterEach(() => {
  if (originalPin === undefined) delete process.env.PARTICIPANT_PIN;
  else process.env.PARTICIPANT_PIN = originalPin;
  if (originalSecret === undefined) delete process.env.PARTICIPANT_SESSION_SECRET;
  else process.env.PARTICIPANT_SESSION_SECRET = originalSecret;
  if (originalSessionDays === undefined) delete process.env.PARTICIPANT_SESSION_DAYS;
  else process.env.PARTICIPANT_SESSION_DAYS = originalSessionDays;
});

describe("assisted result share contracts", () => {
  it("accepts only the 32-byte base64url token shape and stores its digest", () => {
    process.env.PARTICIPANT_PIN = "0427";
    process.env.PARTICIPANT_SESSION_SECRET = "contract-test-secret-with-at-least-32-bytes";
    delete process.env.PARTICIPANT_SESSION_DAYS;
    const token = signParticipantShareToken(Buffer.alloc(32, 1).toString("base64url"));
    if (!token) throw new Error("expected token signing to succeed");
    expect(isShareToken(token)).toBe(true);
    expect(isShareToken("bad-token")).toBe(false);
    expect(isShareToken(`${token}.`)).toBe(false);
    const hash = hashShareToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(token);
  });

  it("requires the complete share state contract", () => {
    expect(
      isAssistedResultShareState({
        exists: true,
        issuedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-10-31T00:00:00.000Z",
        expired: false,
      }),
    ).toBe(true);
    expect(isAssistedResultShareState({ exists: true })).toBe(false);
    expect(isAssistedResultShareState(null)).toBe(false);
    expect(isAssistedResultShareState([])).toBe(false);
    expect(isAssistedResultShareState({ ...stateFixture(), exists: "yes" })).toBe(false);
    expect(isAssistedResultShareState({ ...stateFixture(), issuedAt: 1 })).toBe(false);
    expect(isAssistedResultShareState({ ...stateFixture(), expiresAt: undefined })).toBe(false);
    expect(isAssistedResultShareState({ ...stateFixture(), expired: 0 })).toBe(false);
  });

  it("marks share responses private, uncacheable, and non-referring", () => {
    const headers = sharedResultHeaders({ "X-Robots-Tag": "noindex" });
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Robots-Tag")).toContain("noindex");
  });
});

function stateFixture() {
  return { exists: false, issuedAt: null, expiresAt: null, expired: false };
}
