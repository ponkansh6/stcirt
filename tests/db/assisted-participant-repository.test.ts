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
  AssistedParticipantError,
  createAssistedParticipant,
  getAssistedParticipant,
  getAssistedTargetId,
} from "@/lib/db/repository/assisted-participant-repository";

async function addParticipant(name: string) {
  const [row] = await dbRef
    .db!.insert(schema.examParticipants)
    .values({ displayName: name, normalizedName: name.normalize("NFC") })
    .returning({ id: schema.examParticipants.id });
  return row!.id;
}

async function completeParticipant(participantId: number, suffix: string) {
  await dbRef.db!.insert(schema.examAnswerSubmissions).values({
    id: `submission-${suffix}`,
    participantId,
    questionIds: [1, 2, 3, 4, 5],
    revision: 1,
  });
}

function findSqliteConstraintError(error: unknown): unknown {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string" && /unique|constraint/i.test(candidate.message)) {
      return current;
    }
    current = candidate.cause;
  }
  return error;
}

async function runSqliteUniqueConflict(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    // Drizzle wraps libsql's constraint error. Pass the actual SQLite error
    // through so the repository's constraint classifier sees its message.
    throw findSqliteConstraintError(error);
  }
}

async function commitWinnerThenCauseSqliteUniqueConflict(
  winnerOwnerId: number,
  winnerName: string,
  retryOwnerId: number,
  retryName: string,
  conflict: "owner-link" | "participant-name",
) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let calls = 0;
  let intercept = true;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    calls += 1;
    if (!intercept || calls !== 1) return originalTransaction(callback, config);
    intercept = false;
    return (async () => {
      const winner = await createAssistedParticipant(winnerOwnerId, winnerName);
      // Keep the winning row committed, then make the intercepted retry write
      // hit SQLite's real unique constraint outside a transaction. This feeds
      // the constraint error to createAssistedParticipant's recovery path
      // without aborting the winner's transaction or masking the error.
      if (conflict === "owner-link") {
        await runSqliteUniqueConflict(() =>
          database
            .insert(schema.assistedParticipants)
            .values({ ownerParticipantId: winnerOwnerId, targetParticipantId: winner.id })
            .run(),
        );
        return;
      }
      const [row] = await database
        .select()
        .from(schema.examParticipants)
        .where(eq(schema.examParticipants.id, winner.id));
      if (!row) throw new Error("Expected the winning participant to exist");
      await runSqliteUniqueConflict(() =>
        database
          .insert(schema.examParticipants)
          .values({ displayName: row.displayName, normalizedName: row.normalizedName })
          .run(),
      );
    })();
  });
  try {
    return await createAssistedParticipant(retryOwnerId, retryName);
  } finally {
    transactionSpy.mockRestore();
  }
}

describe("assisted-participant-repository", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
  });

  afterEach(() => {
    testDb.cleanup();
    dbRef.db = null;
  });

  it("links one normalized participant to a completed owner and makes identical retries idempotent", async () => {
    const ownerId = await addParticipant("本人");
    await completeParticipant(ownerId, "owner");

    const target = await createAssistedParticipant(ownerId, "  e\u0301lodie  ");
    const retry = await createAssistedParticipant(ownerId, "élodie");

    expect(retry).toEqual(target);
    expect(await getAssistedParticipant(ownerId)).toEqual(target);
    expect(await getAssistedTargetId(ownerId)).toBe(target.id);
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(1);
    await expect(dbRef.db!.select().from(schema.examAnswerSubmissions)).resolves.toHaveLength(1);
  });

  it("treats a same-name unique race as an idempotent retry after re-reading the link", async () => {
    const ownerId = await addParticipant("本人");
    await completeParticipant(ownerId, "owner");
    const retry = await commitWinnerThenCauseSqliteUniqueConflict(
      ownerId,
      "代理",
      ownerId,
      " 代理 ",
      "owner-link",
    );
    expect(retry.name).toBe("代理");
    expect(await getAssistedParticipant(ownerId)).toEqual(retry);
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(1);
    await expect(dbRef.db!.select().from(schema.examParticipants)).resolves.toHaveLength(2);
  });

  it("returns a conflict after a unique race links a different target to the owner", async () => {
    const ownerId = await addParticipant("本人");
    await completeParticipant(ownerId, "owner");
    await expect(
      commitWinnerThenCauseSqliteUniqueConflict(
        ownerId,
        "先に登録された代理",
        ownerId,
        "別の代理",
        "owner-link",
      ),
    ).rejects.toMatchObject({ name: "AssistedParticipantError", status: 409 });
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(1);
    await expect(dbRef.db!.select().from(schema.examParticipants)).resolves.toHaveLength(2);
  });

  it("returns a name conflict when another owner wins the target-name unique race", async () => {
    const firstOwnerId = await addParticipant("一人目");
    const secondOwnerId = await addParticipant("二人目");
    await completeParticipant(firstOwnerId, "first-owner");
    await completeParticipant(secondOwnerId, "second-owner");
    await expect(
      commitWinnerThenCauseSqliteUniqueConflict(
        firstOwnerId,
        "共有名",
        secondOwnerId,
        "共有名",
        "participant-name",
      ),
    ).rejects.toMatchObject({
      name: "AssistedParticipantError",
      status: 409,
      message: "この名前はすでに使用されています",
    });
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(1);
    await expect(dbRef.db!.select().from(schema.examParticipants)).resolves.toHaveLength(3);
  });

  it("rejects a second different target for the same owner", async () => {
    const ownerId = await addParticipant("本人");
    await completeParticipant(ownerId, "owner");
    await createAssistedParticipant(ownerId, "代理一人目");

    await expect(createAssistedParticipant(ownerId, "代理二人目")).rejects.toMatchObject({
      name: "AssistedParticipantError",
      status: 409,
    });
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(1);
  });

  it("requires owner completion, rejects owner names and existing participant names", async () => {
    const ownerId = await addParticipant("本人");
    await expect(createAssistedParticipant(ownerId, "代理")).rejects.toMatchObject({
      status: 409,
    });
    await completeParticipant(ownerId, "owner");

    await expect(createAssistedParticipant(ownerId, " 本人 ")).rejects.toMatchObject({
      status: 409,
    });
    await addParticipant("既存参加者");
    await expect(createAssistedParticipant(ownerId, "既存参加者")).rejects.toMatchObject({
      status: 409,
    });
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(0);
  });

  it("rejects invalid names and unknown owners before creating any relation", async () => {
    const ownerId = await addParticipant("本人");
    await completeParticipant(ownerId, "owner");

    await expect(createAssistedParticipant(ownerId, "   ")).rejects.toMatchObject({ status: 400 });
    await expect(createAssistedParticipant(ownerId, "a".repeat(121))).rejects.toMatchObject({
      status: 400,
    });
    await expect(createAssistedParticipant(-1, "代理")).rejects.toMatchObject({ status: 404 });
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(0);
  });

  it("propagates unexpected database failures instead of converting them to conflicts", async () => {
    const ownerId = await addParticipant("本人");
    await completeParticipant(ownerId, "owner");
    await testDb.client.execute(`
      CREATE TRIGGER fail_assisted_target_insert
      BEFORE INSERT ON exam_participants
      WHEN NEW.normalized_name = 'database failure'
      BEGIN
        SELECT RAISE(ABORT, 'unexpected database failure');
      END;
    `);

    try {
      const error = await createAssistedParticipant(ownerId, "database failure").then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AssistedParticipantError);
      const messages: string[] = [];
      let cause: unknown = error;
      while (cause instanceof Error) {
        messages.push(cause.message);
        cause = (cause as Error & { cause?: unknown }).cause;
      }
      expect(messages).toContain("unexpected database failure");
      await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(0);
    } finally {
      await testDb.client.execute("DROP TRIGGER IF EXISTS fail_assisted_target_insert");
    }
  });

  it("prevents an assisted participant from registering another person", async () => {
    const ownerId = await addParticipant("本人");
    await completeParticipant(ownerId, "owner");
    const target = await createAssistedParticipant(ownerId, "代理");
    await completeParticipant(target.id, "proxy");

    await expect(createAssistedParticipant(target.id, "さらに代理")).rejects.toBeInstanceOf(
      AssistedParticipantError,
    );
    expect(await getAssistedTargetId(target.id)).toBeNull();
    await expect(dbRef.db!.select().from(schema.assistedParticipants)).resolves.toHaveLength(1);
  });

  it("enforces one owner and one owner per target in the database", async () => {
    const owner = await addParticipant("owner");
    const secondOwner = await addParticipant("second owner");
    const target = await addParticipant("target");
    const secondTarget = await addParticipant("second target");
    await dbRef.db!.insert(schema.assistedParticipants).values({
      ownerParticipantId: owner,
      targetParticipantId: target,
    });

    await expect(
      dbRef.db!.insert(schema.assistedParticipants).values({
        ownerParticipantId: owner,
        targetParticipantId: secondTarget,
      }),
    ).rejects.toThrow();
    await expect(
      dbRef.db!.insert(schema.assistedParticipants).values({
        ownerParticipantId: secondOwner,
        targetParticipantId: target,
      }),
    ).rejects.toThrow();
  });
});
