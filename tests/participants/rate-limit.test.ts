import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";

const dbRef = vi.hoisted(() => ({ db: null as TestDb["db"] | null }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    get db() {
      if (!dbRef.db) throw new Error("test db not initialized");
      return dbRef.db;
    },
  };
});

import {
  checkParticipantRateLimit,
  commitParticipantAuthFailure,
  releaseParticipantAuthReservation,
} from "@/lib/participants/rate-limit";
import { getRateLimitKey } from "@/lib/participants/security";

const envKeys = [
  "PARTICIPANT_PIN",
  "PARTICIPANT_SESSION_SECRET",
  "PARTICIPANT_SESSION_DAYS",
  "PARTICIPANT_RATE_LIMIT_NAME",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

describe("participant shared rate limit", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.participantRateLimits);
    process.env.PARTICIPANT_PIN = "0427";
    process.env.PARTICIPANT_SESSION_SECRET = "session-secret-value-that-is-at-least-32-bytes-long";
    delete process.env.PARTICIPANT_SESSION_DAYS;
    process.env.PARTICIPANT_RATE_LIMIT_NAME = "5";
  });

  afterEach(() => {
    try {
      testDb.cleanup();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      dbRef.db = null;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reserves one normalized-name counter and releases it after successful authentication", async () => {
    const reservation = await checkParticipantRateLimit("山田");
    expect(reservation).toMatchObject({ available: true, allowed: true });
    expect(await dbRef.db!.select().from(schema.participantRateLimits)).toHaveLength(1);

    if (!reservation.available || !reservation.allowed)
      throw new Error("expected an allowed reservation");
    expect(await releaseParticipantAuthReservation(reservation.reservation)).toBe(true);
    expect(await dbRef.db!.select().from(schema.participantRateLimits)).toHaveLength(0);

    const retry = await checkParticipantRateLimit("山田");
    expect(retry).toMatchObject({ available: true, allowed: true });
  });

  it("uses the default limit when the configured limit is unset", async () => {
    delete process.env.PARTICIPANT_RATE_LIMIT_NAME;

    for (let attempt = 0; attempt < 5; attempt++) {
      const reservation = await checkParticipantRateLimit("default-limit");
      expect(reservation.available && reservation.allowed).toBe(true);
      if (!reservation.available || !reservation.allowed)
        throw new Error("expected an allowed reservation");
      expect(await commitParticipantAuthFailure(reservation.reservation)).toBe(true);
    }

    const limited = await checkParticipantRateLimit("default-limit");
    expect(limited.available && !limited.allowed).toBe(true);
  });

  it.each(["many", "0", "9007199254740992", "1.5"])(
    "fails closed for invalid configured limits (%s)",
    async (limit) => {
      process.env.PARTICIPANT_RATE_LIMIT_NAME = limit;

      await expect(checkParticipantRateLimit("invalid-limit")).resolves.toEqual({
        available: false,
      });
      expect(await dbRef.db!.select().from(schema.participantRateLimits)).toHaveLength(0);
    },
  );

  it("fails closed when participant key configuration is invalid", async () => {
    process.env.PARTICIPANT_SESSION_SECRET = "too-short";

    await expect(checkParticipantRateLimit("invalid-key-config")).resolves.toEqual({
      available: false,
    });
  });

  it("fails closed when the reservation row disappears after the upsert", async () => {
    await testDb.client.execute(`
      CREATE TRIGGER remove_rate_limit_reservation
      AFTER INSERT ON participant_rate_limits
      BEGIN
        DELETE FROM participant_rate_limits WHERE fingerprint = NEW.fingerprint;
      END;
    `);

    await expect(checkParticipantRateLimit("missing-reservation")).resolves.toEqual({
      available: false,
    });
  });

  it("rejects empty and multi-entry failed-attempt reservations", async () => {
    const reservation = await checkParticipantRateLimit("invalid-reservation-length");
    if (!reservation.available || !reservation.allowed)
      throw new Error("expected an allowed reservation");

    await expect(commitParticipantAuthFailure([])).resolves.toBe(false);
    await expect(
      commitParticipantAuthFailure([...reservation.reservation, ...reservation.reservation]),
    ).resolves.toBe(false);
  });

  it("keeps failed reservations counted and enforces the five-attempt normalized-name limit", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reservation = await checkParticipantRateLimit("山田");
      expect(reservation).toMatchObject({ available: true, allowed: true });
      if (!reservation.available || !reservation.allowed)
        throw new Error("expected an allowed reservation");
      expect(await commitParticipantAuthFailure(reservation.reservation)).toBe(true);
    }

    const limited = await checkParticipantRateLimit("山田");
    expect(limited.available && !limited.allowed).toBe(true);
    const counted = await dbRef.db!.select().from(schema.participantRateLimits);
    expect(counted).toHaveLength(1);
    expect(counted.every((row) => row.attempts === 5)).toBe(true);

    const [persistedWindow] = counted;
    await dbRef
      .db!.update(schema.participantRateLimits)
      .set({
        windowStartedAt: new Date(Date.now() - 16 * 60 * 1000),
      })
      .where(eq(schema.participantRateLimits.fingerprint, persistedWindow.fingerprint));
    const afterWindow = await checkParticipantRateLimit("山田");
    expect(afterWindow).toMatchObject({ available: true, allowed: true });
  });

  it("expires the counter at the exact 15-minute window boundary", async () => {
    const now = new Date("2026-10-07T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const reservation = await checkParticipantRateLimit("境界");
    if (!reservation.available || !reservation.allowed)
      throw new Error("expected an allowed reservation");
    await commitParticipantAuthFailure(reservation.reservation);
    const [persisted] = await dbRef.db!.select().from(schema.participantRateLimits);
    await dbRef
      .db!.update(schema.participantRateLimits)
      .set({ windowStartedAt: new Date(now.getTime() - 15 * 60 * 1000) })
      .where(eq(schema.participantRateLimits.fingerprint, persisted.fingerprint));

    const afterBoundary = await checkParticipantRateLimit("境界");

    expect(afterBoundary.available && afterBoundary.allowed).toBe(true);
    const [reset] = await dbRef.db!.select().from(schema.participantRateLimits);
    expect(reset.attempts).toBe(1);
    expect(reset.windowStartedAt.getTime()).toBe(now.getTime());
  });

  it("cleans up counters older than 24 hours after recording a failed attempt", async () => {
    const now = new Date();
    await dbRef.db!.insert(schema.participantRateLimits).values({
      fingerprint: "old-fingerprint",
      attempts: 2,
      windowStartedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 - 60 * 1000),
    });
    const reservation = await checkParticipantRateLimit("cleanup");
    if (!reservation.available || !reservation.allowed)
      throw new Error("expected an allowed reservation");

    expect(await commitParticipantAuthFailure(reservation.reservation)).toBe(true);
    const rows = await dbRef.db!.select().from(schema.participantRateLimits);
    expect(rows.map((row) => row.fingerprint)).not.toContain("old-fingerprint");
    expect(rows).toHaveLength(1);
  });

  it("fails closed when the reservation database transaction fails", async () => {
    vi.spyOn(dbRef.db!, "transaction").mockRejectedValue(new Error("database unavailable"));

    await expect(checkParticipantRateLimit("database-error")).resolves.toEqual({
      available: false,
    });
  });

  it("returns false when failure cleanup or reservation release cannot reach the database", async () => {
    const reservation = await checkParticipantRateLimit("cleanup-error");
    if (!reservation.available || !reservation.allowed)
      throw new Error("expected an allowed reservation");

    vi.spyOn(dbRef.db!, "transaction").mockRejectedValue(new Error("database unavailable"));

    await expect(commitParticipantAuthFailure(reservation.reservation)).resolves.toBe(false);
    await expect(releaseParticipantAuthReservation(reservation.reservation)).resolves.toBe(false);
  });

  it("shares the same normalized-name limit across request sources", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reservation = await checkParticipantRateLimit("山田");
      expect(reservation).toMatchObject({ available: true, allowed: true });
      if (!reservation.available || !reservation.allowed)
        throw new Error("expected an allowed reservation");
      await commitParticipantAuthFailure(reservation.reservation);
    }

    // Source IP is not part of the limiter input, so every request shares this counter.
    const fromAnotherSource = await checkParticipantRateLimit("山田");
    expect(fromAnotherSource.available && !fromAnotherSource.allowed).toBe(true);
  });

  it("keeps the rate-limit key and persisted counter stable when the PIN rotates", async () => {
    const firstKey = getRateLimitKey("name\0山田");
    const first = await checkParticipantRateLimit("山田");
    expect(first.available && first.allowed).toBe(true);
    process.env.PARTICIPANT_PIN = "0428";
    expect(getRateLimitKey("name\0山田")).toBe(firstKey);
    const second = await checkParticipantRateLimit("山田");
    expect(second.available && second.allowed).toBe(true);
    const rows = await dbRef.db!.select().from(schema.participantRateLimits);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(2);
  });

  it("does not grant more concurrent reservations than the configured cap", async () => {
    process.env.PARTICIPANT_RATE_LIMIT_NAME = "2";

    const results = await Promise.all(
      Array.from({ length: 8 }, () => checkParticipantRateLimit("同時")),
    );
    const granted = results.filter((result) => result.available && result.allowed);
    expect(granted.length).toBeGreaterThan(0);
    expect(granted.length).toBeLessThanOrEqual(2);

    const counts = await dbRef.db!.select().from(schema.participantRateLimits);
    expect(counts.every((row) => row.attempts <= 2)).toBe(true);
  });
});
