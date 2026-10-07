import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  createParticipantSession,
  getParticipantCookie,
  getRateLimitKey,
  isParticipantAuthConfigured,
  participantSessionLifetimeSeconds,
  requestHasValidOrigin,
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
  it("accepts only session day values from 1 through 90", () => {
    configure();
    expect(participantSessionLifetimeSeconds()).toBe(30 * 24 * 60 * 60);

    process.env.PARTICIPANT_SESSION_DAYS = "1";
    expect(participantSessionLifetimeSeconds()).toBe(24 * 60 * 60);
    process.env.PARTICIPANT_SESSION_DAYS = "90";
    expect(participantSessionLifetimeSeconds()).toBe(90 * 24 * 60 * 60);

    for (const invalid of ["", "0", "91", "1.5", "-1", " 1", "9007199254740992"]) {
      process.env.PARTICIPANT_SESSION_DAYS = invalid;
      expect(participantSessionLifetimeSeconds()).toBeNull();
      expect(isParticipantAuthConfigured()).toBe(false);
    }
  });

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
    expect(verifyParticipantSession(`${session!.value}.extra`)).toBeNull();

    const key = createHmac("sha256", process.env.PARTICIPANT_SESSION_SECRET!)
      .update("stcirt-participant-session-v1\0" + process.env.PARTICIPANT_PIN)
      .digest();
    const signedPayload = (payload: object | string) => {
      const json = typeof payload === "string" ? payload : JSON.stringify(payload);
      const encoded = Buffer.from(json).toString("base64url");
      const signature = createHmac("sha256", key).update(encoded).digest("base64url");
      return `${encoded}.${signature}`;
    };
    const now = Math.floor(Date.now() / 1000);
    expect(verifyParticipantSession(signedPayload({ id: 42, exp: now - 1 }))).toBeNull();
    expect(verifyParticipantSession(signedPayload({ id: 42, exp: now }))).toBeNull();
    expect(
      verifyParticipantSession(signedPayload({ id: 42, exp: now + 60, version: "event-1" })),
    ).toBeNull();
    for (const payload of [
      "{invalid-json",
      "null",
      JSON.stringify({ exp: now + 60 }),
      JSON.stringify({ id: 42 }),
      JSON.stringify({ id: 0, exp: now + 60 }),
      JSON.stringify({ id: 1.5, exp: now + 60 }),
      JSON.stringify({ id: 42, exp: "not-a-timestamp" }),
    ]) {
      expect(verifyParticipantSession(signedPayload(payload))).toBeNull();
    }

    const validPayload = JSON.stringify({ id: 42, exp: now + 60 });
    const exactBoundaryJson = validPayload + " ".repeat(1503 - Buffer.byteLength(validPayload));
    const boundaryToken = signedPayload(exactBoundaryJson);
    expect(boundaryToken).toHaveLength(2048);
    expect(verifyParticipantSession(boundaryToken)?.id).toBe(42);
    expect(verifyParticipantSession(`${boundaryToken}x`)).toBeNull();

    process.env.PARTICIPANT_PIN = "0428";
    expect(verifyParticipantSession(session!.value)).toBeNull();
    process.env.PARTICIPANT_PIN = "0427";
    process.env.PARTICIPANT_SESSION_SECRET = "different-session-secret-value-that-is-32bytes";
    expect(verifyParticipantSession(session!.value)).toBeNull();
  });

  it("fails closed when decoding a signed session signature throws", () => {
    configure();
    const session = createParticipantSession(42, 60);
    expect(session).not.toBeNull();

    const encodedSignature = session!.value.split(".")[1];
    const originalFrom = Buffer.from;
    const fromSpy = vi.spyOn(Buffer, "from").mockImplementation((...args) => {
      // Buffer.from's overload makes Vitest expose a one-entry call tuple here,
      // while the implementation may receive the two-argument string overload.
      const callArgs = args as unknown as readonly unknown[];
      if (
        callArgs.length === 2 &&
        typeof callArgs[0] === "string" &&
        callArgs[0] === encodedSignature &&
        callArgs[1] === "base64url"
      ) {
        throw new Error("decode failed");
      }
      return Reflect.apply(originalFrom, Buffer, args);
    });
    try {
      expect(verifyParticipantSession(session!.value)).toBeNull();
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("extracts only the participant cookie value", () => {
    expect(getParticipantCookie(new Request("https://app.example/"))).toBeUndefined();
    expect(
      getParticipantCookie(
        new Request("https://app.example/", {
          headers: {
            cookie: "other=x; malformed; stcirt_participant_session = token-value ; next=y",
          },
        }),
      ),
    ).toBe("token-value");
    expect(
      getParticipantCookie(
        new Request("https://app.example/", { headers: { cookie: "stcirt_participant_session=" } }),
      ),
    ).toBe("");
    expect(
      getParticipantCookie(
        new Request("https://app.example/", {
          headers: { cookie: "stcirt_participant_sessions=wrong" },
        }),
      ),
    ).toBeUndefined();
  });

  it("checks Origin against direct and forwarded request hosts", () => {
    expect(requestHasValidOrigin(new Request("https://app.example/path"))).toBe(false);
    expect(
      requestHasValidOrigin(
        new Request("https://app.example/path", {
          headers: { origin: "https://app.example", host: "app.example" },
        }),
      ),
    ).toBe(true);
    expect(
      requestHasValidOrigin(
        new Request("https://internal.example/path", {
          headers: { origin: "https://public.example", host: "internal.example" },
        }),
      ),
    ).toBe(false);
    expect(
      requestHasValidOrigin(
        new Request("https://internal.example/path", {
          headers: {
            origin: "https://public.example/path",
            "x-forwarded-host": " public.example, proxy.example",
          },
        }),
      ),
    ).toBe(true);
    expect(
      requestHasValidOrigin(
        new Request("http://internal.example/path", {
          headers: {
            origin: "https://public.example",
            host: "ignored.example",
            "x-forwarded-host": "public.example, proxy.example",
            "x-forwarded-proto": " https, http",
          },
        }),
      ),
    ).toBe(true);
    expect(
      requestHasValidOrigin(
        new Request("https://app.example/path", {
          headers: { origin: "not-an-origin", host: "app.example" },
        }),
      ),
    ).toBe(false);
  });

  it("derives a stable rate-limit key only with valid auth configuration", () => {
    configure();
    const key = getRateLimitKey("client-1");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(getRateLimitKey("client-1")).toBe(key);
    expect(getRateLimitKey("client-2")).not.toBe(key);
    delete process.env.PARTICIPANT_SESSION_SECRET;
    expect(getRateLimitKey("client-1")).toBeNull();
  });
});
