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

const envKeys = [
  "PARTICIPANT_SESSION_SECRET",
  "PARTICIPANT_EVENT_VERSION",
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
    process.env.PARTICIPANT_SESSION_SECRET = "session-secret-value-that-is-at-least-32-bytes-long";
    process.env.PARTICIPANT_EVENT_VERSION = "event-1";
    delete process.env.PARTICIPANT_SESSION_DAYS;
    process.env.PARTICIPANT_RATE_LIMIT_NAME = "5";
  });

  afterEach(() => {
    testDb.cleanup();
    dbRef.db = null;
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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
