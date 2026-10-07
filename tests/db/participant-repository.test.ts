import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  findParticipantById,
  getOrCreateParticipant,
  normalizeParticipantName,
} from "@/lib/db/repository/participant-repository";

describe("participant-repository", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.examParticipants);
  });

  afterEach(() => {
    testDb.cleanup();
    dbRef.db = null;
  });

  it("trims names and uses NFC while preserving case and internal whitespace", () => {
    expect(normalizeParticipantName("  e\u0301lodie  ")).toEqual({
      displayName: "e\u0301lodie",
      normalizedName: "élodie",
    });
    expect(normalizeParticipantName("A  B").normalizedName).toBe("A  B");
    expect(normalizeParticipantName(" A B ").normalizedName).toBe("A B");
    expect(normalizeParticipantName("Alice").normalizedName).not.toBe(
      normalizeParticipantName("alice").normalizedName,
    );
    expect(normalizeParticipantName("Ａlice").normalizedName).not.toBe("Alice");
  });

  it("reuses the same participant for names equal after trim and NFC normalization", async () => {
    const first = await getOrCreateParticipant("  e\u0301lodie  ");
    const second = await getOrCreateParticipant("élodie");

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    const rows = await dbRef.db!.select().from(schema.examParticipants);
    expect(rows).toHaveLength(1);
    expect(rows[0].normalizedName).toBe("élodie");
    expect(rows[0].displayName).toBe("e\u0301lodie");
  });

  it("finds a participant by id and returns null for a missing id", async () => {
    const participant = await getOrCreateParticipant("Alice");

    expect(participant).not.toBeNull();
    await expect(findParticipantById(participant!.id)).resolves.toEqual({
      id: participant!.id,
      name: "Alice",
    });
    await expect(findParticipantById(-1)).resolves.toBeNull();
    expect(await dbRef.db!.select().from(schema.examParticipants)).toHaveLength(1);
  });

  it("returns null for blank and whitespace-only names without inserting rows", async () => {
    const existing = await getOrCreateParticipant("Existing participant");

    await expect(getOrCreateParticipant("")).resolves.toBeNull();
    await expect(getOrCreateParticipant("   \t\n  ")).resolves.toBeNull();

    const rows = await dbRef.db!.select().from(schema.examParticipants);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: existing!.id,
      displayName: "Existing participant",
      normalizedName: "Existing participant",
    });
  });

  it("returns null when an inserted participant disappears before lookup", async () => {
    await testDb.client.execute(`
      CREATE TRIGGER delete_inserted_participant
      AFTER INSERT ON exam_participants
      BEGIN
        DELETE FROM exam_participants WHERE id = NEW.id;
      END;
    `);

    try {
      await expect(getOrCreateParticipant("Transient participant")).resolves.toBeNull();
      expect(await testDb.db.select().from(schema.examParticipants)).toHaveLength(0);
    } finally {
      await testDb.client.execute("DROP TRIGGER IF EXISTS delete_inserted_participant");
    }
  });

  it("does not merge case variants or names with different internal whitespace", async () => {
    const names = await Promise.all([
      getOrCreateParticipant("Alice"),
      getOrCreateParticipant("alice"),
      getOrCreateParticipant("A  B"),
      getOrCreateParticipant("A B"),
    ]);

    expect(new Set(names.map((participant) => participant?.id)).size).toBe(4);
  });

  it("creates only one participant when identical names are registered concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateParticipant("  山田 太郎  ")),
    );

    expect(new Set(results.map((participant) => participant?.id)).size).toBe(1);
    expect(await dbRef.db!.select().from(schema.examParticipants)).toHaveLength(1);
  });
});
