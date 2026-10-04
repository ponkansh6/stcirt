import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, scryptSync, createHmac } from "node:crypto";
import {
  createParticipantSession,
  isParticipantAuthConfigured,
  verifyEventPin,
  verifyParticipantSession,
} from "@/lib/participants/security";

const envKeys = [
  "PARTICIPANT_SESSION_SECRET",
  "PARTICIPANT_EVENT_VERSION",
  "PARTICIPANT_SESSION_DAYS",
  "PARTICIPANT_PIN_HASH",
  "PARTICIPANT_PIN_PEPPER",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function configure(pin = "0427") {
  const salt = randomBytes(16);
  const pepper = "test-pepper-value-that-is-long-enough-32-bytes";
  const digest = scryptSync(`${pin}:${pepper}`, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  process.env.PARTICIPANT_SESSION_SECRET = "session-secret-value-that-is-at-least-32-bytes-long";
  process.env.PARTICIPANT_EVENT_VERSION = "event-1";
  process.env.PARTICIPANT_PIN_PEPPER = pepper;
  process.env.PARTICIPANT_PIN_HASH = `scrypt$${salt.toString("hex")}$${digest.toString("hex")}`;
  delete process.env.PARTICIPANT_SESSION_DAYS;
}

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("participant security", () => {
  it("verifies a salted KDF PIN as a four-character string, including a leading zero", () => {
    configure("0007");
    expect(verifyEventPin("0007")).toBe(true);
    expect(verifyEventPin("7")).toBe(false);
    expect(verifyEventPin("0008")).toBe(false);
    expect(verifyEventPin("０007")).toBe(false);
  });

  it("fails closed for missing or malformed PIN and session configuration", () => {
    configure();
    expect(isParticipantAuthConfigured()).toBe(true);

    delete process.env.PARTICIPANT_PIN_HASH;
    expect(isParticipantAuthConfigured()).toBe(false);
    expect(verifyEventPin("0427")).toBe(false);

    configure();
    process.env.PARTICIPANT_PIN_HASH = "not-a-valid-kdf-value";
    expect(isParticipantAuthConfigured()).toBe(false);
    expect(verifyEventPin("0427")).toBe(false);

    configure();
    delete process.env.PARTICIPANT_SESSION_SECRET;
    expect(createParticipantSession(1, 60)).toBeNull();
  });

  it("rejects tampered, expired, and event-version-mismatched signed sessions", () => {
    configure();
    const session = createParticipantSession(42, 60);
    expect(session).not.toBeNull();
    expect(verifyParticipantSession(session!.value)?.id).toBe(42);
    expect(verifyParticipantSession(`${session!.value}x`)).toBeNull();

    const secret = process.env.PARTICIPANT_SESSION_SECRET!;
    const signedPayload = (payload: object) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
      return `${encoded}.${signature}`;
    };
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifyParticipantSession(signedPayload({ id: 42, exp: now - 1, version: "event-1" })),
    ).toBeNull();
    expect(
      verifyParticipantSession(signedPayload({ id: 42, exp: now + 60, version: "event-0" })),
    ).toBeNull();

    process.env.PARTICIPANT_EVENT_VERSION = "event-2";
    expect(verifyParticipantSession(session!.value)).toBeNull();
  });
});
