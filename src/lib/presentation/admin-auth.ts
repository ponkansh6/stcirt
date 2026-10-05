import { createHmac, timingSafeEqual } from "node:crypto";
import { requestHasValidOrigin } from "@/lib/participants/security";

export const ADMIN_PRESENTATION_COOKIE = "stcirt_admin_presentation";
const SESSION_SECONDS = 8 * 60 * 60;
const PURPOSE = "stcirt-admin-presentation-session-v1";
type AdminPayload = { role: "admin"; exp: number };

export function isAdminPresentationAuthConfigured() {
  const pin = process.env.ADMIN_PRESENTATION_PIN;
  const secret = process.env.ADMIN_PRESENTATION_SESSION_SECRET;
  return Boolean(pin && pin.length <= 128 && secret && Buffer.byteLength(secret) >= 32);
}

export function verifyAdminPresentationPin(pin: unknown) {
  const expected = process.env.ADMIN_PRESENTATION_PIN;
  if (typeof pin !== "string" || !expected || expected.length > 128) return false;
  const providedBytes = Buffer.from(pin, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
  );
}

function sessionKey() {
  const secret = process.env.ADMIN_PRESENTATION_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) return null;
  return createHmac("sha256", secret).update(PURPOSE).digest();
}

export function createAdminPresentationSession() {
  if (!isAdminPresentationAuthConfigured()) return null;
  const key = sessionKey();
  if (!key) return null;
  const payload: AdminPayload = {
    role: "admin",
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(encoded).digest("base64url");
  return { value: `${encoded}.${signature}`, maxAge: SESSION_SECONDS };
}

export function verifyAdminPresentationSession(token: string | undefined) {
  const key = sessionKey();
  if (!key || !token || token.length > 1024) return false;
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length) return false;
  const expected = createHmac("sha256", key).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AdminPayload;
    return (
      payload !== null &&
      typeof payload === "object" &&
      Object.keys(payload).length === 2 &&
      payload.role === "admin" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

export function isAdminPresentationRequest(request: Request) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_PRESENTATION_COOKIE}=`))
    ?.slice(ADMIN_PRESENTATION_COOKIE.length + 1);
  return verifyAdminPresentationSession(token);
}

export function isValidAdminMutation(request: Request) {
  return requestHasValidOrigin(request) && isAdminPresentationRequest(request);
}
