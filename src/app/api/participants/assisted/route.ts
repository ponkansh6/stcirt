import { fail, ok, withErrorHandling } from "@/lib/api/response";
import {
  findParticipantById,
  normalizeParticipantName,
} from "@/lib/db/repository/participant-repository";
import {
  AssistedParticipantError,
  createAssistedParticipant,
  getAssistedParticipant,
} from "@/lib/db/repository/assisted-participant-repository";
import { db } from "@/lib/db";
import { assistedParticipants, examAnswerSubmissions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getParticipantCookie,
  isParticipantAuthConfigured,
  requestHasValidOrigin,
  verifyParticipantSession,
} from "@/lib/participants/security";
import {
  checkParticipantRateLimit,
  releaseParticipantAuthReservation,
} from "@/lib/participants/rate-limit";

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const GET = withErrorHandling(async function (request: Request) {
  if (!isParticipantAuthConfigured()) {
    return noStore(fail("Participant session required", 401));
  }
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    return noStore(fail("Participant session required", 401));
  }

  const [submission] = await db
    .select({ id: examAnswerSubmissions.id })
    .from(examAnswerSubmissions)
    .where(eq(examAnswerSubmissions.participantId, session.id))
    .limit(1);
  const [proxy] = await db
    .select({ id: assistedParticipants.ownerParticipantId })
    .from(assistedParticipants)
    .where(eq(assistedParticipants.targetParticipantId, session.id))
    .limit(1);
  const participant = await getAssistedParticipant(session.id);
  return noStore(
    ok({
      participant,
      hasSubmission: Boolean(participant && (await hasSubmission(participant.id))),
      eligible: !participant && !proxy && Boolean(submission),
    }),
  );
}, "GET /api/participants/assisted");

async function hasSubmission(participantId: number) {
  const [submission] = await db
    .select({ id: examAnswerSubmissions.id })
    .from(examAnswerSubmissions)
    .where(eq(examAnswerSubmissions.participantId, participantId))
    .limit(1);
  return Boolean(submission);
}

export const POST = withErrorHandling(async function (request: Request) {
  if (!requestHasValidOrigin(request)) return fail("Invalid request origin", 403);
  if (!isParticipantAuthConfigured()) return fail("Participant sign-in is unavailable", 503);
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id)))
    return fail("Participant session required", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request", 400);
  }
  const keys = Object.keys(body);
  const name = (body as { name?: unknown }).name;
  if (keys.length !== 1 || keys[0] !== "name" || typeof name !== "string" || name.length > 120) {
    return fail("名前を入力してください", 400);
  }
  const normalized = normalizeParticipantName(name);
  if (!normalized.displayName || normalized.displayName.length > 120) {
    return fail("名前を入力してください", 400);
  }

  const rate = await checkParticipantRateLimit(normalized.normalizedName);
  if (!rate.available) return fail("Participant sign-in is unavailable", 503);
  if (!rate.allowed) {
    return noStore(fail("試行回数が上限に達しました。時間をおいて再度お試しください", 429));
  }

  try {
    const participant = await createAssistedParticipant(session.id, name);
    if (!(await releaseParticipantAuthReservation(rate.reservation)))
      return fail("Participant sign-in is unavailable", 503);
    return noStore(ok({ participant, hasSubmission: await hasSubmission(participant.id) }));
  } catch (error) {
    if (!(await releaseParticipantAuthReservation(rate.reservation)))
      return fail("Participant sign-in is unavailable", 503);
    if (error instanceof AssistedParticipantError)
      return noStore(fail(error.message, error.status));
    throw error;
  }
}, "POST /api/participants/assisted");
