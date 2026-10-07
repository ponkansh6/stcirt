import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PRESENTATION_COOKIE,
  createAdminPresentationSession,
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
  isValidAdminMutation,
  verifyAdminPresentationPin,
  verifyAdminPresentationSession,
} from "@/lib/presentation/admin-auth";

const secret = "admin-session-secret-with-at-least-32-bytes";
const purpose = "stcirt-admin-presentation-session-v1";

function signedToken(payload: string) {
  const encoded = Buffer.from(payload).toString("base64url");
  const key = createHmac("sha256", secret).update(purpose).digest();
  const signature = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function request(cookie?: string, origin = "https://app.test") {
  return new Request("https://app.test/api/admin/presentation", {
    headers: {
      Host: "app.test",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...(origin ? { Origin: origin } : {}),
    },
  });
}

beforeEach(() => {
  vi.stubEnv("ADMIN_PRESENTATION_PIN", "2468");
  vi.stubEnv("ADMIN_PRESENTATION_SESSION_SECRET", secret);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("presentation admin auth", () => {
  it("requires a nonempty PIN of at most 128 characters and a 32-byte secret", () => {
    expect(isAdminPresentationAuthConfigured()).toBe(true);

    vi.stubEnv("ADMIN_PRESENTATION_PIN", "");
    expect(isAdminPresentationAuthConfigured()).toBe(false);
    vi.stubEnv("ADMIN_PRESENTATION_PIN", "p".repeat(129));
    expect(isAdminPresentationAuthConfigured()).toBe(false);
    vi.stubEnv("ADMIN_PRESENTATION_PIN", "p".repeat(128));
    expect(isAdminPresentationAuthConfigured()).toBe(true);

    vi.stubEnv("ADMIN_PRESENTATION_SESSION_SECRET", "s".repeat(31));
    expect(isAdminPresentationAuthConfigured()).toBe(false);
    vi.stubEnv("ADMIN_PRESENTATION_SESSION_SECRET", "s".repeat(32));
    expect(isAdminPresentationAuthConfigured()).toBe(true);
  });

  it("returns null if the session secret disappears between configuration and key derivation", () => {
    const envDescriptor = Object.getOwnPropertyDescriptor(process, "env");
    if (!envDescriptor || !("value" in envDescriptor)) {
      throw new Error("Expected process.env to be a replaceable data property");
    }
    const originalEnv = envDescriptor.value as NodeJS.ProcessEnv;
    let secretReads = 0;
    const envProxy = new Proxy(originalEnv, {
      get(target, property, receiver) {
        if (property === "ADMIN_PRESENTATION_SESSION_SECRET") {
          secretReads += 1;
          return secretReads === 1 ? secret : undefined;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      Object.defineProperty(process, "env", { ...envDescriptor, value: envProxy });
      expect(createAdminPresentationSession()).toBeNull();
      expect(secretReads).toBe(2);
    } finally {
      Object.defineProperty(process, "env", envDescriptor);
    }
  });

  it("verifies only string PINs matching the configured value", () => {
    expect(verifyAdminPresentationPin("2468")).toBe(true);
    expect(verifyAdminPresentationPin("246")).toBe(false);
    expect(verifyAdminPresentationPin("24680")).toBe(false);
    expect(verifyAdminPresentationPin(2468)).toBe(false);
    expect(verifyAdminPresentationPin(null)).toBe(false);

    vi.stubEnv("ADMIN_PRESENTATION_PIN", "p".repeat(129));
    expect(verifyAdminPresentationPin("p".repeat(129))).toBe(false);
    vi.stubEnv("ADMIN_PRESENTATION_PIN", "");
    expect(verifyAdminPresentationPin("2468")).toBe(false);
  });

  it("creates an admin session with an eight-hour expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));

    const session = createAdminPresentationSession();
    expect(session).not.toBeNull();
    expect(session?.maxAge).toBe(8 * 60 * 60);
    expect(verifyAdminPresentationSession(session?.value)).toBe(true);

    const payload = JSON.parse(
      Buffer.from(session!.value.split(".")[0], "base64url").toString("utf8"),
    ) as { role: string; exp: number };
    expect(payload).toEqual({ role: "admin", exp: Date.parse("2026-10-07T08:00:00.000Z") / 1000 });

    vi.setSystemTime(new Date("2026-10-07T08:00:00.000Z"));
    expect(verifyAdminPresentationSession(session?.value)).toBe(false);
  });

  it("fails closed for missing, malformed, invalid, or expired sessions", () => {
    expect(verifyAdminPresentationSession(undefined)).toBe(false);
    expect(verifyAdminPresentationSession("")).toBe(false);
    expect(verifyAdminPresentationSession("bad.token.extra")).toBe(false);
    expect(verifyAdminPresentationSession("bad.token")).toBe(false);
    expect(verifyAdminPresentationSession("x".repeat(1025))).toBe(false);

    const expired = signedToken(JSON.stringify({ role: "admin", exp: 1 }));
    expect(verifyAdminPresentationSession(expired)).toBe(false);
    const wrongRole = signedToken(JSON.stringify({ role: "participant", exp: 9_999_999_999 }));
    expect(verifyAdminPresentationSession(wrongRole)).toBe(false);
    expect(verifyAdminPresentationSession(signedToken("not-json"))).toBe(false);

    vi.stubEnv("ADMIN_PRESENTATION_SESSION_SECRET", "short");
    expect(verifyAdminPresentationSession(expired)).toBe(false);
    expect(createAdminPresentationSession()).toBeNull();
  });

  it("reads the admin cookie among other cookies and checks same-origin mutations", () => {
    const session = createAdminPresentationSession();
    const cookie = `${ADMIN_PRESENTATION_COOKIE}=${session!.value}`;
    expect(isAdminPresentationRequest(request(`other=value; ${cookie}`))).toBe(true);
    expect(isAdminPresentationRequest(request("stcirt_admin_presentation_extra=ignored"))).toBe(
      false,
    );
    expect(isAdminPresentationRequest(request())).toBe(false);

    expect(isValidAdminMutation(request(cookie))).toBe(true);
    expect(isValidAdminMutation(request(cookie, "https://attacker.test"))).toBe(false);
    expect(isValidAdminMutation(request(cookie, ""))).toBe(false);
    expect(isValidAdminMutation(request())).toBe(false);
  });
});
