import { and, eq, gt, lt, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { participantRateLimits } from "@/lib/db/schema";
import { getRateLimitKey } from "./security";

const WINDOW_MS = 15 * 60 * 1000;
function getLimit(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function getAttemptKey(normalizedName: string) {
  return getRateLimitKey(`name\0${normalizedName}`);
}

export type ParticipantAuthReservation = readonly {
  fingerprint: string;
  windowStartedAt: Date;
}[];

export async function checkParticipantRateLimit(normalizedName: string) {
  const nameLimit = getLimit("PARTICIPANT_RATE_LIMIT_NAME", 5);
  const key = getAttemptKey(normalizedName);
  if (nameLimit === null || !key) return { available: false as const };
  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const rows = await tx
        .select({
          fingerprint: participantRateLimits.fingerprint,
          attempts: participantRateLimits.attempts,
          started: participantRateLimits.windowStartedAt,
        })
        .from(participantRateLimits)
        .where(eq(participantRateLimits.fingerprint, key));
      const row = rows[0];
      const count =
        !row || now.getTime() - row.started.getTime() >= WINDOW_MS
          ? { attempts: 0, started: now }
          : { attempts: row.attempts, started: row.started };
      const retryAt = count.attempts >= nameLimit ? count.started.getTime() + WINDOW_MS : 0;
      if (retryAt > now.getTime())
        return { available: true as const, allowed: false as const, retryAt: new Date(retryAt) };

      // Reserve the normalized-name counter before PIN verification so
      // concurrent requests share one limit. Success releases the reservation.
      // SQLite stores mode: "timestamp" values as integer epoch seconds. Use
      // numeric seconds in this raw UPSERT expression so its comparisons use
      // the same representation as the stored column.
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const expiredWindowStartSeconds = nowSeconds - WINDOW_MS / 1000;
      await tx
        .insert(participantRateLimits)
        .values({ fingerprint: key, attempts: 1, windowStartedAt: now })
        .onConflictDoUpdate({
          target: participantRateLimits.fingerprint,
          set: {
            attempts: sql`case when ${participantRateLimits.windowStartedAt} <= ${expiredWindowStartSeconds} then 1 else ${participantRateLimits.attempts} + 1 end`,
            windowStartedAt: sql`case when ${participantRateLimits.windowStartedAt} <= ${expiredWindowStartSeconds} then ${nowSeconds} else ${participantRateLimits.windowStartedAt} end`,
          },
        });
      const reservedRows = await tx
        .select({
          fingerprint: participantRateLimits.fingerprint,
          started: participantRateLimits.windowStartedAt,
        })
        .from(participantRateLimits)
        .where(eq(participantRateLimits.fingerprint, key));
      const reserved = reservedRows[0];
      if (!reserved) throw new Error("Rate limit reservation missing");
      const reservation = [{ fingerprint: key, windowStartedAt: reserved.started }];
      return { available: true as const, allowed: true as const, reservation };
    });
  } catch {
    // Fail closed if Turso cannot complete the shared reservation transaction.
    return { available: false as const };
  }
}

export async function commitParticipantAuthFailure(reservation: ParticipantAuthReservation) {
  if (reservation.length !== 1) return false;
  const now = new Date();
  const expiredBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    // The failed attempt is already counted by its committed reservation. Keep
    // that count and clean up old fingerprints in a write transaction.
    await db.transaction(async (tx) => {
      await tx
        .delete(participantRateLimits)
        .where(lt(participantRateLimits.windowStartedAt, expiredBefore));
    });
    return true;
  } catch {
    return false;
  }
}

export async function releaseParticipantAuthReservation(reservation: ParticipantAuthReservation) {
  try {
    await db.transaction(async (tx) => {
      for (const entry of reservation) {
        await tx
          .update(participantRateLimits)
          .set({ attempts: sql`${participantRateLimits.attempts} - 1` })
          .where(
            and(
              eq(participantRateLimits.fingerprint, entry.fingerprint),
              eq(participantRateLimits.windowStartedAt, entry.windowStartedAt),
              gt(participantRateLimits.attempts, 0),
            ),
          );
      }
      for (const entry of reservation) {
        await tx
          .delete(participantRateLimits)
          .where(
            and(
              eq(participantRateLimits.fingerprint, entry.fingerprint),
              eq(participantRateLimits.windowStartedAt, entry.windowStartedAt),
              lte(participantRateLimits.attempts, 0),
            ),
          );
      }
    });
    return true;
  } catch {
    return false;
  }
}
