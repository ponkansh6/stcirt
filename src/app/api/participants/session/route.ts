import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  findParticipantById,
  getOrCreateParticipant,
  normalizeParticipantName,
} from "@/lib/db/repository/participant-repository";
import {
  createParticipantSession,
  getParticipantCookie,
  isParticipantAuthConfigured,
  PARTICIPANT_COOKIE,
  participantSessionLifetimeSeconds,
  requestHasValidOrigin,
  verifyEventPin,
  verifyParticipantSession,
} from "@/lib/participants/security";
import {
  checkParticipantRateLimit,
  commitParticipantAuthFailure,
  releaseParticipantAuthReservation,
} from "@/lib/participants/rate-limit";

export const runtime = "nodejs";

function unavailable() {
  const message = "Participant sign-in is unavailable";
  return NextResponse.json({ error: message, message }, { status: 503 });
}

function errorResponse(message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, message, ...extra }, { status });
}

export async function POST(request: Request) {
  if (!requestHasValidOrigin(request)) {
    return errorResponse("Invalid request origin", 403);
  }
  if (!isParticipantAuthConfigured()) return unavailable();

  const lifetime = participantSessionLifetimeSeconds();
  if (lifetime === null) return unavailable();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request", 400);
  }
  if (!body || typeof body !== "object") {
    return errorResponse("Invalid request", 400);
  }
  const name = (body as { name?: unknown }).name;
  const pin = (body as { pin?: unknown }).pin;
  if (typeof name !== "string" || name.length > 120) {
    return errorResponse("名前を入力してください", 400);
  }
  const normalized = normalizeParticipantName(name);
  if (!normalized.displayName || normalized.displayName.length > 120) {
    return errorResponse("名前を入力してください", 400);
  }
  if (typeof pin !== "string") {
    return errorResponse("名前またはPINを確認してください", 401);
  }

  const rate = await checkParticipantRateLimit(normalized.normalizedName);
  if (!rate.available) return unavailable();
  if (!rate.allowed) {
    return errorResponse("試行回数が上限に達しました。時間をおいて再度お試しください", 429, {
      retryAt: rate.retryAt.toISOString(),
    });
  }

  if (!verifyEventPin(pin)) {
    if (!(await commitParticipantAuthFailure(rate.reservation))) return unavailable();
    return errorResponse("名前またはPINを確認してください", 401);
  }

  // Successful PIN verification must not consume a failed-authentication slot.
  // If release fails, fail closed and do not issue a session cookie.
  if (!(await releaseParticipantAuthReservation(rate.reservation))) return unavailable();

  const participant = await getOrCreateParticipant(name);
  if (!participant) return errorResponse("名前を入力してください", 400);
  const session = createParticipantSession(participant.id, lifetime);
  if (!session) return unavailable();

  const cookieStore = await cookies();
  cookieStore.set(PARTICIPANT_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
    maxAge: lifetime,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.json({ participant, expiresAt: session.expiresAt.toISOString() });
}

export async function GET(request: Request) {
  if (!isParticipantAuthConfigured()) return NextResponse.json({ participant: null });
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session) return NextResponse.json({ participant: null });
  const participant = await findParticipantById(session.id);
  return NextResponse.json({ participant });
}

export async function DELETE(request: Request) {
  if (!requestHasValidOrigin(request)) {
    return errorResponse("Invalid request origin", 403);
  }
  const cookieStore = await cookies();
  cookieStore.set(PARTICIPANT_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.json({ ok: true });
}
