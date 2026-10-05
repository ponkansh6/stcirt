import { createHmac, timingSafeEqual } from "node:crypto";

export const PARTICIPANT_COOKIE = "stcirt_participant_session";
const DEFAULT_SESSION_SECONDS = 30 * 24 * 60 * 60;

type SessionPayload = { id: number; exp: number };
const SESSION_KEY_PURPOSE = "stcirt-participant-session-v1";
const RATE_LIMIT_KEY_PURPOSE = "stcirt-participant-rate-limit-v1";

function sessionConfig() {
  const secret = process.env.PARTICIPANT_SESSION_SECRET;
  const pin = process.env.PARTICIPANT_PIN;
  if (
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    !pin ||
    !/^[0-9]{4}$/.test(pin) ||
    participantSessionLifetimeSeconds() === null
  ) {
    return null;
  }
  return { secret, pin };
}

export function isParticipantAuthConfigured() {
  return sessionConfig() !== null;
}

export function participantSessionLifetimeSeconds() {
  const raw = process.env.PARTICIPANT_SESSION_DAYS;
  if (raw === undefined) return DEFAULT_SESSION_SECONDS;
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return Number.isSafeInteger(days) && days >= 1 && days <= 90 ? days * 24 * 60 * 60 : null;
}

export function verifyEventPin(pin: string) {
  const configuredPin = process.env.PARTICIPANT_PIN;
  if (!configuredPin || !/^[0-9]{4}$/.test(configuredPin) || !/^[0-9]{4}$/.test(pin)) return false;
  return timingSafeEqual(Buffer.from(pin, "ascii"), Buffer.from(configuredPin, "ascii"));
}

function deriveKey(secret: string, purpose: string, pin?: string) {
  const input = pin === undefined ? purpose : `${purpose}\0${pin}`;
  return createHmac("sha256", secret).update(input).digest();
}

export function createParticipantSession(id: number, lifetimeSeconds: number) {
  const config = sessionConfig();
  if (!config || !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0) return null;
  const payload: SessionPayload = {
    id,
    exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", deriveKey(config.secret, SESSION_KEY_PURPOSE, config.pin))
    .update(encoded)
    .digest("base64url");
  return { value: `${encoded}.${signature}`, expiresAt: new Date(payload.exp * 1000) };
}

export function verifyParticipantSession(token: string | undefined) {
  const config = sessionConfig();
  if (!config || !token || token.length > 2048) return null;
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length) return null;
  const expected = createHmac("sha256", deriveKey(config.secret, SESSION_KEY_PURPOSE, config.pin))
    .update(encoded)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (
      !payload ||
      typeof payload !== "object" ||
      Object.keys(payload).length !== 2 ||
      !Object.hasOwn(payload, "id") ||
      !Object.hasOwn(payload, "exp") ||
      !Number.isSafeInteger(payload.id) ||
      payload.id <= 0 ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return { id: payload.id, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
}

export function getParticipantCookie(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== PARTICIPANT_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function requestHasValidOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsedOrigin = new URL(origin).origin;
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host");
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwardedProtocol || new URL(request.url).protocol.replace(":", "");
    return Boolean(host && parsedOrigin === `${protocol}://${host}`);
  } catch {
    return false;
  }
}

export function getRateLimitKey(value: string) {
  const config = sessionConfig();
  if (!config) return null;
  return createHmac("sha256", deriveKey(config.secret, RATE_LIMIT_KEY_PURPOSE))
    .update(value)
    .digest("hex");
}
