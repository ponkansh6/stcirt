import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistedParticipants, assistedResultShares, participantRateLimits } from "@/lib/db/schema";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";
import {
  getRateLimitKey,
  signParticipantShareToken,
  verifyParticipantShareToken,
} from "./security";

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NO_STORE = { "Cache-Control": "private, no-store" };
const ownerShareIssueLocks = new Map<number, Promise<void>>();

export function sharedResultHeaders(extra?: HeadersInit) {
  const headers = new Headers(NO_STORE);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

export function hashShareToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function isShareToken(value: string) {
  return verifyParticipantShareToken(value);
}

async function reserveRateLimit(fingerprint: string, limit: number) {
  const now = new Date();
  const started = new Date(now.getTime() - 15 * 60 * 1000);
  try {
    return await db.transaction(async (tx) => {
      await tx
        .delete(participantRateLimits)
        .where(
          lt(participantRateLimits.windowStartedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        );
      const [row] = await tx
        .select({ attempts: participantRateLimits.attempts })
        .from(participantRateLimits)
        .where(eq(participantRateLimits.fingerprint, fingerprint))
        .limit(1);
      if (row && row.attempts >= limit) {
        const [time] = await tx
          .select({ started: participantRateLimits.windowStartedAt })
          .from(participantRateLimits)
          .where(
            and(
              eq(participantRateLimits.fingerprint, fingerprint),
              lte(participantRateLimits.windowStartedAt, started),
            ),
          )
          .limit(1);
        if (!time) return false;
      }
      await tx
        .insert(participantRateLimits)
        .values({ fingerprint, attempts: 1, windowStartedAt: now })
        .onConflictDoUpdate({
          target: participantRateLimits.fingerprint,
          set: {
            attempts: sql`case when ${participantRateLimits.windowStartedAt} <= ${Math.floor(started.getTime() / 1000)} then 1 else ${participantRateLimits.attempts} + 1 end`,
            windowStartedAt: sql`case when ${participantRateLimits.windowStartedAt} <= ${Math.floor(started.getTime() / 1000)} then ${Math.floor(now.getTime() / 1000)} else ${participantRateLimits.windowStartedAt} end`,
          },
        });
      const [fresh] = await tx
        .select({ attempts: participantRateLimits.attempts })
        .from(participantRateLimits)
        .where(eq(participantRateLimits.fingerprint, fingerprint))
        .limit(1);
      return Boolean(fresh && fresh.attempts <= limit);
    });
  } catch {
    return false;
  }
}

export async function checkOwnerShareManagementRateLimit(ownerId: number) {
  const key = getRateLimitKey(`shared-result-management\0owner:${ownerId}`);
  return Boolean(key && (await reserveRateLimit(key, 20)));
}

export async function checkOwnerShareStopRateLimit(ownerId: number) {
  const key = getRateLimitKey(`shared-result-stop\0owner:${ownerId}`);
  return Boolean(key && (await reserveRateLimit(key, 20)));
}

async function findActiveShareByHash(tokenHash: string) {
  return withShareDatabaseRetry(() => findActiveShareByHashOnce(tokenHash));
}

async function findActiveShareByHashOnce(tokenHash: string) {
  const [row] = await db
    .select({
      ownerId: assistedResultShares.ownerParticipantId,
      targetId: assistedResultShares.targetParticipantId,
      expiresAt: assistedResultShares.expiresAt,
    })
    .from(assistedResultShares)
    .where(eq(assistedResultShares.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  const [relation] = await db
    .select({ targetId: assistedParticipants.targetParticipantId })
    .from(assistedParticipants)
    .where(eq(assistedParticipants.ownerParticipantId, row.ownerId))
    .limit(1);
  if (!relation || relation.targetId !== row.targetId) {
    await db
      .delete(assistedResultShares)
      .where(eq(assistedResultShares.ownerParticipantId, row.ownerId));
    return null;
  }
  return { ...row, tokenHash };
}

async function findActiveShare(token: string) {
  if (!isShareToken(token)) return null;
  return findActiveShareByHash(hashShareToken(token));
}

export type RateLimitedSharedResult =
  | { state: "ok"; result: NonNullable<Awaited<ReturnType<typeof getParticipantResult>>> }
  | { state: "not_found" };

export async function readRateLimitedSharedParticipantResult(
  token: string,
): Promise<RateLimitedSharedResult> {
  if (!isShareToken(token)) return { state: "not_found" };
  const tokenHash = hashShareToken(token);
  const key = getRateLimitKey(`shared-result-public\0${tokenHash}`);
  if (!key || !(await reserveRateLimit(key, 60))) return { state: "not_found" };
  const row = await findActiveShareByHash(tokenHash);
  if (!row) return { state: "not_found" };
  return {
    state: "ok",
    result: await withShareDatabaseRetry(() => getParticipantResult(row.targetId)),
  };
}

export async function getOwnerShare(ownerId: number) {
  const [relation] = await db
    .select({ targetId: assistedParticipants.targetParticipantId })
    .from(assistedParticipants)
    .where(eq(assistedParticipants.ownerParticipantId, ownerId))
    .limit(1);
  if (!relation) {
    await db
      .delete(assistedResultShares)
      .where(eq(assistedResultShares.ownerParticipantId, ownerId));
    return { targetId: null, share: null };
  }
  const [share] = await db
    .select({
      targetId: assistedResultShares.targetParticipantId,
      issuedAt: assistedResultShares.issuedAt,
      expiresAt: assistedResultShares.expiresAt,
    })
    .from(assistedResultShares)
    .where(eq(assistedResultShares.ownerParticipantId, ownerId))
    .limit(1);
  if (share && share.targetId !== relation.targetId) {
    await db
      .delete(assistedResultShares)
      .where(eq(assistedResultShares.ownerParticipantId, ownerId));
    return { targetId: relation.targetId, share: null };
  }
  return { targetId: relation.targetId, share: share ?? null };
}

export async function issueAssistedResultShare(ownerId: number) {
  // Serialize the read and write phases so a sibling issue cannot hold a read snapshot
  // that blocks this owner's allocation commit on SQLite's rollback journal.
  return withOwnerShareIssueLock(ownerId, () => issueAssistedResultShareLocked(ownerId));
}

async function issueAssistedResultShareLocked(ownerId: number) {
  const { targetId } = await withShareDatabaseRetry(() => getOwnerShare(ownerId));
  if (targetId === null) return { error: "NO_ASSISTED_TARGET" as const };
  const result = await withShareDatabaseRetry(() => getParticipantResult(targetId));
  if (result.state !== "visible") return { error: "SHARE_NOT_PUBLISHED" as const };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = signParticipantShareToken(randomBytes(32).toString("base64url"));
    if (!token) throw new Error("Share token signing is unavailable");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHARE_TTL_MS);
    try {
      await withShareDatabaseRetry(() =>
        db.transaction(async (tx) => {
          await tx
            .delete(assistedResultShares)
            .where(
              and(
                eq(assistedResultShares.targetParticipantId, targetId),
                ne(assistedResultShares.ownerParticipantId, ownerId),
              ),
            );
          await tx
            .insert(assistedResultShares)
            .values({
              ownerParticipantId: ownerId,
              targetParticipantId: targetId,
              tokenHash: hashShareToken(token),
              issuedAt: now,
              expiresAt,
            })
            .onConflictDoUpdate({
              target: assistedResultShares.ownerParticipantId,
              set: {
                targetParticipantId: targetId,
                tokenHash: hashShareToken(token),
                issuedAt: now,
                expiresAt,
              },
            });
        }),
      );
      return { token, issuedAt: now, expiresAt };
    } catch (error) {
      // Lock contention is retried by withShareDatabaseRetry; this loop handles unique conflicts.
      if (isUniqueConstraintConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("Share token allocation failed");
}

async function withOwnerShareIssueLock<T>(ownerId: number, run: () => Promise<T>): Promise<T> {
  const previous = ownerShareIssueLocks.get(ownerId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  ownerShareIssueLocks.set(ownerId, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (ownerShareIssueLocks.get(ownerId) === current) ownerShareIssueLocks.delete(ownerId);
  }
}

function isUniqueConstraintConflict(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return /unique|constraint|duplicate/i.test(value);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const candidate = value as { code?: unknown; message?: unknown; cause?: unknown };
  const fields = [candidate.code, candidate.message];
  if (
    fields.some((field) => typeof field === "string" && /unique|constraint|duplicate/i.test(field))
  )
    return true;
  return isUniqueConstraintConflict(candidate.cause, seen);
}

async function withShareDatabaseRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxAttempts = 6;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSqliteLockContention(error) || attempt >= maxAttempts - 1) throw error;
      const capMs = 25 * 2 ** attempt;
      const delayMs = Math.floor(capMs / 2 + Math.random() * (capMs / 2));
      await delay(delayMs);
    }
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isSqliteLockContention(error: unknown) {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as {
      code?: unknown;
      extendedCode?: unknown;
      cause?: unknown;
      originalError?: unknown;
      original?: unknown;
      error?: unknown;
    };
    if (
      [value.code, value.extendedCode].some(
        (code) => typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(code),
      )
    )
      return true;
    pending.push(value.cause, value.originalError, value.original, value.error);
  }
  return false;
}

export async function revokeAssistedResultShare(ownerId: number) {
  await db.delete(assistedResultShares).where(eq(assistedResultShares.ownerParticipantId, ownerId));
}

export async function readSharedParticipantResult(token: string) {
  const row = await findActiveShare(token);
  return row ? withShareDatabaseRetry(() => getParticipantResult(row.targetId)) : null;
}
