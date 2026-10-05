import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  createParticipantSession,
  isParticipantAuthConfigured,
  verifyEventPin,
  verifyParticipantSession,
} from "@/lib/participants/security";

const envKeys = [
  "PARTICIPANT_PIN",
  "PARTICIPANT_SESSION_SECRET",
  "PARTICIPANT_SESSION_DAYS",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function configure(pin = "0427") {
  process.env.PARTICIPANT_PIN = pin;
  process.env.PARTICIPANT_SESSION_SECRET = "session-secret-value-that-is-at-least-32-bytes-long";
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
  it("verifies an ASCII four-digit PIN as a string, including a leading zero", () => {
    configure("0007");
    expect(verifyEventPin("0007")).toBe(true);
    expect(verifyEventPin("7")).toBe(false);
    expect(verifyEventPin("0008")).toBe(false);
    expect(verifyEventPin("０007")).toBe(false);
    expect(verifyEventPin("１２３４")).toBe(false);
  });

  it("fails closed for missing or malformed PIN and session configuration", () => {
    configure();
    expect(isParticipantAuthConfigured()).toBe(true);

    delete process.env.PARTICIPANT_PIN;
    expect(isParticipantAuthConfigured()).toBe(false);
    expect(verifyEventPin("0427")).toBe(false);

    configure();
    process.env.PARTICIPANT_PIN = "１２３４";
    expect(isParticipantAuthConfigured()).toBe(false);
    expect(verifyEventPin("0427")).toBe(false);

    configure();
    delete process.env.PARTICIPANT_SESSION_SECRET;
    expect(createParticipantSession(1, 60)).toBeNull();
  });

  it("rejects tampered, expired, and legacy payload sessions", () => {
    configure();
    const session = createParticipantSession(42, 60);
    expect(session).not.toBeNull();
    expect(verifyParticipantSession(session!.value)?.id).toBe(42);
    expect(verifyParticipantSession(`${session!.value}x`)).toBeNull();

    const key = createHmac("sha256", process.env.PARTICIPANT_SESSION_SECRET!)
      .update("stcirt-participant-session-v1\0" + process.env.PARTICIPANT_PIN)
      .digest();
    const signedPayload = (payload: object) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = createHmac("sha256", key).update(encoded).digest("base64url");
      return `${encoded}.${signature}`;
    };
    const now = Math.floor(Date.now() / 1000);
    expect(verifyParticipantSession(signedPayload({ id: 42, exp: now - 1 }))).toBeNull();
    expect(
      verifyParticipantSession(signedPayload({ id: 42, exp: now + 60, version: "event-1" })),
    ).toBeNull();

    process.env.PARTICIPANT_PIN = "0428";
    expect(verifyParticipantSession(session!.value)).toBeNull();
    process.env.PARTICIPANT_PIN = "0427";
    process.env.PARTICIPANT_SESSION_SECRET = "different-session-secret-value-that-is-32bytes";
    expect(verifyParticipantSession(session!.value)).toBeNull();
  });
});
