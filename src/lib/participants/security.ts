import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

export const PARTICIPANT_COOKIE = "stcirt_participant_session";
const DEFAULT_SESSION_SECONDS = 30 * 24 * 60 * 60;

type SessionPayload = { id: number; exp: number; version: string };

function sessionConfig() {
  const secret = process.env.PARTICIPANT_SESSION_SECRET;
  const version = process.env.PARTICIPANT_EVENT_VERSION;
  if (
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    !version ||
    version.length > 128 ||
    participantSessionLifetimeSeconds() === null
  ) {
    return null;
  }
  return { secret, version };
}

export function isParticipantAuthConfigured() {
  return sessionConfig() !== null && getPinConfiguration() !== null;
}

export function participantSessionLifetimeSeconds() {
  const raw = process.env.PARTICIPANT_SESSION_DAYS;
  if (raw === undefined) return DEFAULT_SESSION_SECONDS;
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return Number.isSafeInteger(days) && days >= 1 && days <= 90 ? days * 24 * 60 * 60 : null;
}

function getPinConfiguration() {
  const encoded = process.env.PARTICIPANT_PIN_HASH;
  const pepper = process.env.PARTICIPANT_PIN_PEPPER;
  const match = encoded?.match(/^scrypt\$([a-f\d]{32,128})\$([a-f\d]{64})$/i);
  if (!match || !pepper || Buffer.byteLength(pepper) < 32) return null;
  return { salt: Buffer.from(match[1], "hex"), digest: Buffer.from(match[2], "hex"), pepper };
}

export function verifyEventPin(pin: string) {
  const config = getPinConfiguration();
  if (!config || !/^\d{4}$/.test(pin)) return false;
  const candidate = scryptSync(`${pin}:${config.pepper}`, config.salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(candidate, config.digest);
}

export function createParticipantSession(id: number, lifetimeSeconds: number) {
  const config = sessionConfig();
  if (!config || lifetimeSeconds === null) return null;
  const payload: SessionPayload = {
    id,
    exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
    version: config.version,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", config.secret).update(encoded).digest("base64url");
  return { value: `${encoded}.${signature}`, expiresAt: new Date(payload.exp * 1000) };
}

export function verifyParticipantSession(token: string | undefined) {
  const config = sessionConfig();
  if (!config || !token || token.length > 2048) return null;
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length) return null;
  const expected = createHmac("sha256", config.secret).update(encoded).digest();
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
      !Number.isSafeInteger(payload.id) ||
      payload.id <= 0 ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000) ||
      payload.version !== config.version
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
  return config ? createHmac("sha256", config.secret).update(value).digest("hex") : null;
}
