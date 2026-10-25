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
vi.mock("@/lib/participants/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/participants/security")>();
  return { ...actual, getRateLimitKey: (value: string) => `test:${value.replaceAll("\0", ":")}` };
});
import {
  checkOwnerShareManagementRateLimit,
  checkOwnerShareStopRateLimit,
  getOwnerShare,
  hashShareToken,
  issueAssistedResultShare,
  readRateLimitedSharedParticipantResult,
  readSharedParticipantResult,
  revokeAssistedResultShare,
} from "@/lib/participants/assisted-result-sharing";
import { signParticipantShareToken } from "@/lib/participants/security";

const originalAuthEnv = {
  pin: process.env.PARTICIPANT_PIN,
  secret: process.env.PARTICIPANT_SESSION_SECRET,
  sessionDays: process.env.PARTICIPANT_SESSION_DAYS,
};

function injectTransactionFailure(testDb: TestDb, failureOnCall: number, error: unknown) {
  const originalTransaction = testDb.client.transaction.bind(testDb.client);
  const transactionSpy = vi.spyOn(testDb.client, "transaction");
  let transactionCalls = 0;
  transactionSpy.mockImplementation((...args) => {
    transactionCalls += 1;
    if (transactionCalls === failureOnCall) return Promise.reject(error);
    return originalTransaction(...args);
  });
  return {
    spy: transactionSpy,
    get calls() {
      return transactionCalls;
    },
  };
}

describe("assisted result share persistence", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    process.env.PARTICIPANT_PIN = "0427";
    process.env.PARTICIPANT_SESSION_SECRET = "test-share-secret-with-at-least-32-bytes-long";
    delete process.env.PARTICIPANT_SESSION_DAYS;
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.insert(schema.examParticipants).values([
      { id: 42, normalizedName: "owner", displayName: "Owner" },
      { id: 99, normalizedName: "target", displayName: "Assisted target" },
      { id: 100, normalizedName: "replacement", displayName: "Replacement target" },
    ]);
    await testDb.db.insert(schema.assistedParticipants).values({
      ownerParticipantId: 42,
      targetParticipantId: 99,
    });
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "opening",
      version: 1,
      questionIndex: 0,
      questionCount: 1,
      snapshotRevision: 1,
      projectionHidden: false,
      presentationMode: "full",
    });
    await testDb.db.insert(schema.presentationQuestions).values({
      sessionId: 1,
      position: 0,
      sourceQuestionId: 7,
      question: "Snapshot question",
      choices: ["A", "B"],
      correctIndex: 0,
      explanation: null,
    });
    await testDb.db.insert(schema.presentationEntries).values({
      sessionId: 1,
      participantId: 99,
      displayName: "Assisted target",
      score: 1,
      rank: 1,
      answers: [
        {
          questionId: 7,
          answerKind: "selected",
          selectedIndex: 0,
          freeText: null,
          rawScore: 1,
          normalizedScore: null,
        },
      ],
    });
    await testDb.db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: true,
      everPublished: true,
    });
  });

  afterEach(async () => {
    dbRef.db = null;
    await testDb.cleanup();
    if (originalAuthEnv.pin === undefined) delete process.env.PARTICIPANT_PIN;
    else process.env.PARTICIPANT_PIN = originalAuthEnv.pin;
    if (originalAuthEnv.secret === undefined) delete process.env.PARTICIPANT_SESSION_SECRET;
    else process.env.PARTICIPANT_SESSION_SECRET = originalAuthEnv.secret;
    if (originalAuthEnv.sessionDays === undefined) delete process.env.PARTICIPANT_SESSION_DAYS;
    else process.env.PARTICIPANT_SESSION_DAYS = originalAuthEnv.sessionDays;
  });

  it("stores only a token hash and reads the current visible participant projection", async () => {
    const issued = await issueAssistedResultShare(42);
    expect("error" in issued).toBe(false);
    if ("error" in issued) return;
    expect(issued.token).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt.getTime() - issued.issuedAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);

    const [stored] = await testDb.db.select().from(schema.assistedResultShares);
    expect(stored.tokenHash).toBe(hashShareToken(issued.token));
    expect(stored.tokenHash).not.toBe(issued.token);
    await expect(readSharedParticipantResult(issued.token)).resolves.toMatchObject({
      state: "visible",
      questions: [{ question: "Snapshot question", answer: { value: "A" } }],
    });
  });

  it("rejects expiry and changed owner-target relationships", async () => {
    const issued = await issueAssistedResultShare(42);
    if ("error" in issued) throw new Error("expected share issue to succeed");
    await testDb.db
      .update(schema.assistedResultShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.assistedResultShares.ownerParticipantId, 42));
    await expect(readSharedParticipantResult(issued.token)).resolves.toBeNull();

    await testDb.db
      .update(schema.assistedResultShares)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.assistedResultShares.ownerParticipantId, 42));
    await testDb.db
      .update(schema.assistedParticipants)
      .set({ targetParticipantId: 100 })
      .where(eq(schema.assistedParticipants.ownerParticipantId, 42));
    await expect(readSharedParticipantResult(issued.token)).resolves.toBeNull();
    await expect(testDb.db.select().from(schema.assistedResultShares)).resolves.toHaveLength(0);
  });

  it("cleans up a share when an owner no longer has its target relationship", async () => {
    const issued = await issueAssistedResultShare(42);
    if ("error" in issued) throw new Error("expected share issue to succeed");
    await testDb.db
      .update(schema.assistedParticipants)
      .set({ targetParticipantId: 100 })
      .where(eq(schema.assistedParticipants.ownerParticipantId, 42));

    await expect(getOwnerShare(42)).resolves.toEqual({ targetId: 100, share: null });
    await expect(testDb.db.select().from(schema.assistedResultShares)).resolves.toHaveLength(0);
  });

  it("does not issue a share while results are private", async () => {
    await testDb.db
      .update(schema.participantResultSettings)
      .set({ visible: false })
      .where(eq(schema.participantResultSettings.id, 1));
    await expect(issueAssistedResultShare(42)).resolves.toEqual({ error: "SHARE_NOT_PUBLISHED" });
    await expect(testDb.db.select().from(schema.assistedResultShares)).resolves.toHaveLength(0);
  });

  it("does not issue a share when the owner has no assisted target", async () => {
    await testDb.db
      .delete(schema.assistedParticipants)
      .where(eq(schema.assistedParticipants.ownerParticipantId, 42));
    await expect(issueAssistedResultShare(42)).resolves.toEqual({ error: "NO_ASSISTED_TARGET" });
  });

  it("fails closed when the share signing configuration is unavailable", async () => {
    delete process.env.PARTICIPANT_SESSION_SECRET;
    await expect(issueAssistedResultShare(42)).rejects.toThrow(
      "Share token signing is unavailable",
    );
  });

  it("invalidates an old token on reissue and makes stop idempotent", async () => {
    const first = await issueAssistedResultShare(42);
    if ("error" in first) throw new Error("expected first share issue to succeed");
    const second = await issueAssistedResultShare(42);
    if ("error" in second) throw new Error("expected second share issue to succeed");
    await expect(readSharedParticipantResult(first.token)).resolves.toBeNull();
    await expect(readSharedParticipantResult(second.token)).resolves.toMatchObject({
      state: "visible",
    });

    await revokeAssistedResultShare(42);
    await revokeAssistedResultShare(42);
    await expect(readSharedParticipantResult(second.token)).resolves.toBeNull();
    await expect(testDb.db.select().from(schema.assistedResultShares)).resolves.toHaveLength(0);
  });

  it("returns only waiting while hidden", async () => {
    const issued = await issueAssistedResultShare(42);
    if ("error" in issued) throw new Error("expected share issue to succeed");
    await testDb.db
      .update(schema.participantResultSettings)
      .set({ visible: false })
      .where(eq(schema.participantResultSettings.id, 1));
    await expect(readSharedParticipantResult(issued.token)).resolves.toEqual({ state: "waiting" });

    await expect(readRateLimitedSharedParticipantResult(issued.token)).resolves.toEqual({
      state: "ok",
      result: { state: "waiting" },
    });
    const [counter] = await testDb.db.select().from(schema.participantRateLimits);
    expect(counter.fingerprint).toBe(`test:shared-result-public:${hashShareToken(issued.token)}`);
  });

  it("isolates public limits per share and keeps management counters separate", async () => {
    await testDb.db.insert(schema.examParticipants).values([
      { id: 101, normalizedName: "owner-b", displayName: "Owner B" },
      { id: 102, normalizedName: "target-b", displayName: "Target B" },
    ]);
    await testDb.db.insert(schema.assistedParticipants).values({
      ownerParticipantId: 101,
      targetParticipantId: 102,
    });
    await testDb.db.insert(schema.presentationEntries).values({
      sessionId: 1,
      participantId: 102,
      displayName: "Target B",
      score: 1,
      rank: 1,
      answers: [
        {
          questionId: 7,
          answerKind: "selected",
          selectedIndex: 0,
          freeText: null,
          rawScore: 1,
          normalizedScore: null,
        },
      ],
    });
    const shareA = await issueAssistedResultShare(42);
    const shareB = await issueAssistedResultShare(101);
    if ("error" in shareA || "error" in shareB) throw new Error("expected shares to issue");
    await testDb.db.insert(schema.participantRateLimits).values({
      fingerprint: `test:shared-result-public:${hashShareToken(shareA.token)}`,
      attempts: 60,
      windowStartedAt: new Date(),
    });

    await expect(readRateLimitedSharedParticipantResult(shareA.token)).resolves.toEqual({
      state: "not_found",
    });
    await expect(readRateLimitedSharedParticipantResult(shareB.token)).resolves.toMatchObject({
      state: "ok",
      result: { state: "visible" },
    });
    await expect(checkOwnerShareManagementRateLimit(42)).resolves.toBe(true);
    const counters = await testDb.db.select().from(schema.participantRateLimits);
    expect(counters.map(({ fingerprint }) => fingerprint)).toContain(
      `test:shared-result-management:owner:42`,
    );
    expect(counters).toHaveLength(3);
  });

  it("does not create a rate-limit row for malformed or unknown tokens", async () => {
    await expect(readRateLimitedSharedParticipantResult("bad-token")).resolves.toEqual({
      state: "not_found",
    });
    await expect(readRateLimitedSharedParticipantResult("a".repeat(43))).resolves.toEqual({
      state: "not_found",
    });
    await expect(testDb.db.select().from(schema.participantRateLimits)).resolves.toHaveLength(0);
    await expect(readSharedParticipantResult("bad-token")).resolves.toBeNull();
  });

  it("fails closed when the rate-limit transaction is unavailable", async () => {
    const transaction = injectTransactionFailure(testDb, 1, new Error("database unavailable"));
    try {
      await expect(checkOwnerShareManagementRateLimit(42)).resolves.toBe(false);
      expect(transaction.calls).toBe(1);
    } finally {
      transaction.spy.mockRestore();
    }
  });

  it("blocks management requests when their recent rate-limit window is exhausted", async () => {
    await testDb.db.insert(schema.participantRateLimits).values({
      fingerprint: "test:shared-result-management:owner:42",
      attempts: 20,
      windowStartedAt: new Date(),
    });

    await expect(checkOwnerShareManagementRateLimit(42)).resolves.toBe(false);
    const [counter] = await testDb.db
      .select()
      .from(schema.participantRateLimits)
      .where(
        eq(schema.participantRateLimits.fingerprint, "test:shared-result-management:owner:42"),
      );
    expect(counter.attempts).toBe(20);
  });

  it("resets an exhausted management counter after its rate-limit window expires", async () => {
    await testDb.db.insert(schema.participantRateLimits).values({
      fingerprint: "test:shared-result-management:owner:42",
      attempts: 20,
      windowStartedAt: new Date(Date.now() - 16 * 60 * 1000),
    });

    await expect(checkOwnerShareManagementRateLimit(42)).resolves.toBe(true);
    const [counter] = await testDb.db
      .select()
      .from(schema.participantRateLimits)
      .where(
        eq(schema.participantRateLimits.fingerprint, "test:shared-result-management:owner:42"),
      );
    expect(counter.attempts).toBe(1);
    expect(counter.windowStartedAt.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
  });

  it("rejects a bad MAC before DB reads and leaves signed unknown tokens unmetered", async () => {
    const invalidToken = `v1.${Buffer.alloc(32, 3).toString("base64url")}.${Buffer.alloc(32, 4).toString("base64url")}`;
    const selectSpy = vi.spyOn(testDb.db, "select");
    await expect(readRateLimitedSharedParticipantResult(invalidToken)).resolves.toEqual({
      state: "not_found",
    });
    expect(selectSpy).not.toHaveBeenCalled();
    selectSpy.mockRestore();

    const validUnknownToken = signParticipantShareToken(Buffer.alloc(32, 5).toString("base64url"));
    if (!validUnknownToken) throw new Error("expected share token signing to succeed");
    await expect(readRateLimitedSharedParticipantResult(validUnknownToken)).resolves.toEqual({
      state: "not_found",
    });
    const counters = await testDb.db.select().from(schema.participantRateLimits);
    expect(counters).toHaveLength(1);
    expect(counters[0].fingerprint).toBe(
      `test:shared-result-public:${hashShareToken(validUnknownToken)}`,
    );
  });

  it("meters expired and revoked signed tokens before DB lookup and suppresses retries", async () => {
    const expired = await issueAssistedResultShare(42);
    if ("error" in expired) throw new Error("expected share issue to succeed");
    await testDb.db
      .update(schema.assistedResultShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.assistedResultShares.ownerParticipantId, 42));
    await expect(readRateLimitedSharedParticipantResult(expired.token)).resolves.toEqual({
      state: "not_found",
    });
    const expiredFingerprint = `test:shared-result-public:${hashShareToken(expired.token)}`;
    await testDb.db
      .update(schema.participantRateLimits)
      .set({ attempts: 60 })
      .where(eq(schema.participantRateLimits.fingerprint, expiredFingerprint));
    await expect(readRateLimitedSharedParticipantResult(expired.token)).resolves.toEqual({
      state: "not_found",
    });
    const [expiredCounter] = await testDb.db
      .select()
      .from(schema.participantRateLimits)
      .where(eq(schema.participantRateLimits.fingerprint, expiredFingerprint));
    expect(expiredCounter.attempts).toBe(60);

    const revoked = await issueAssistedResultShare(42);
    if ("error" in revoked) throw new Error("expected replacement share to issue");
    await revokeAssistedResultShare(42);
    await expect(readRateLimitedSharedParticipantResult(revoked.token)).resolves.toEqual({
      state: "not_found",
    });
    const [revokedCounter] = await testDb.db
      .select()
      .from(schema.participantRateLimits)
      .where(
        eq(
          schema.participantRateLimits.fingerprint,
          `test:shared-result-public:${hashShareToken(revoked.token)}`,
        ),
      );
    expect(revokedCounter.attempts).toBe(1);
  });

  it("retries a reported unique conflict during token allocation", async () => {
    const transaction = injectTransactionFailure(
      testDb,
      2,
      new Error("allocation transaction failed", {
        cause: "UNIQUE constraint failed",
      }),
    );
    try {
      const issued = await issueAssistedResultShare(42);
      if ("error" in issued) throw new Error("expected retry to issue a share");
      expect(transaction.calls).toBe(3);
      await expect(readSharedParticipantResult(issued.token)).resolves.toMatchObject({
        state: "visible",
      });
    } finally {
      transaction.spy.mockRestore();
    }
  });

  it("recognizes a unique conflict reported through an error code", async () => {
    const transaction = injectTransactionFailure(
      testDb,
      2,
      new Error("allocation transaction failed", {
        cause: { code: "SQLITE_CONSTRAINT", message: "unique constraint failed" },
      }),
    );
    try {
      const issued = await issueAssistedResultShare(42);
      if ("error" in issued) throw new Error("expected retry to issue a share");
      expect(transaction.calls).toBe(3);
      await expect(readSharedParticipantResult(issued.token)).resolves.toMatchObject({
        state: "visible",
      });
    } finally {
      transaction.spy.mockRestore();
    }
  });

  it("propagates non-unique allocation failures without retrying", async () => {
    const transaction = injectTransactionFailure(testDb, 2, new Error("allocation unavailable"));
    try {
      await expect(issueAssistedResultShare(42)).rejects.toThrow("allocation unavailable");
      expect(transaction.calls).toBe(2);
    } finally {
      transaction.spy.mockRestore();
    }
  });

  it("retries a busy public result read without reserving its rate limit twice", async () => {
    const issued = await issueAssistedResultShare(42);
    if ("error" in issued) throw new Error("expected share issue to succeed");

    const transaction = injectTransactionFailure(testDb, 2, {
      code: "SQLITE_BUSY",
      rawCode: 5,
      message: "database is locked",
    });

    try {
      await expect(readRateLimitedSharedParticipantResult(issued.token)).resolves.toMatchObject({
        state: "ok",
        result: { state: "visible" },
      });
      expect(transaction.calls).toBe(3);
      const [counter] = await testDb.db
        .select()
        .from(schema.participantRateLimits)
        .where(
          eq(
            schema.participantRateLimits.fingerprint,
            `test:shared-result-public:${hashShareToken(issued.token)}`,
          ),
        );
      expect(counter.attempts).toBe(1);
    } finally {
      transaction.spy.mockRestore();
    }
  });

  it("does not retry non-busy public result read failures", async () => {
    const issued = await issueAssistedResultShare(42);
    if ("error" in issued) throw new Error("expected share issue to succeed");
    const error = { code: "SQLITE_ERROR", message: "unexpected read failure" };

    const transaction = injectTransactionFailure(testDb, 2, error);

    try {
      await expect(readRateLimitedSharedParticipantResult(issued.token)).rejects.toBe(error);
      expect(transaction.calls).toBe(2);
      const [counter] = await testDb.db
        .select()
        .from(schema.participantRateLimits)
        .where(
          eq(
            schema.participantRateLimits.fingerprint,
            `test:shared-result-public:${hashShareToken(issued.token)}`,
          ),
        );
      expect(counter.attempts).toBe(1);
    } finally {
      transaction.spy.mockRestore();
    }
  });

  it("retries SQLite busy errors while reading an unmetered shared result", async () => {
    const issued = await issueAssistedResultShare(42);
    if ("error" in issued) throw new Error("expected share issue to succeed");
    const transaction = injectTransactionFailure(testDb, 1, {
      code: "SQLITE_BUSY",
      rawCode: 5,
      message: "database is locked",
    });

    try {
      await expect(readSharedParticipantResult(issued.token)).resolves.toMatchObject({
        state: "visible",
      });
      expect(transaction.calls).toBe(2);
    } finally {
      transaction.spy.mockRestore();
    }
  });

  it("uses a separate stop limit so exhausted management requests cannot block revocation", async () => {
    for (let index = 0; index < 20; index += 1) {
      expect(await checkOwnerShareManagementRateLimit(42)).toBe(true);
    }
    await expect(checkOwnerShareManagementRateLimit(42)).resolves.toBe(false);
    await expect(checkOwnerShareStopRateLimit(42)).resolves.toBe(true);
    const counters = await testDb.db.select().from(schema.participantRateLimits);
    expect(counters.map(({ fingerprint }) => fingerprint)).toEqual(
      expect.arrayContaining([
        "test:shared-result-management:owner:42",
        "test:shared-result-stop:owner:42",
      ]),
    );
  });

  it("supports simultaneous reissue requests with one active owner share", async () => {
    const issued = await Promise.all([issueAssistedResultShare(42), issueAssistedResultShare(42)]);
    expect(issued.every((value) => !("error" in value))).toBe(true);
    const [active] = await testDb.db.select().from(schema.assistedResultShares);
    expect(active).toBeDefined();
    const activeToken = issued.find(
      (value) => !("error" in value) && hashShareToken(value.token) === active.tokenHash,
    );
    expect(activeToken && !("error" in activeToken)).toBe(true);
  });
});
