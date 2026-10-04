import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
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

import { getNextQuestion, getQuestionById } from "@/lib/db/repository/question-repository";

async function insertQuestion(question: string) {
  const [count] = await dbRef
    .db!.select({ value: sql<number>`count(*)` })
    .from(schema.examQuestions);
  const id = Number(count?.value ?? 0) + 1;
  const [row] = await dbRef
    .db!.insert(schema.examQuestions)
    .values({
      id,
      key: `test-${id}`,
      question,
      choices: ["A", "B", "C", "D"],
      correctIndex: 0,
    })
    .returning({ id: schema.examQuestions.id });
  return row!.id;
}

describe("question-repository", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    await testDb.db.delete(schema.examAnswerLogs);
    await testDb.db.delete(schema.examQuestions);
    dbRef.db = testDb.db;
  });

  afterEach(() => testDb.cleanup());

  it("returns null when there are no questions or the cursor is exhausted", async () => {
    expect(await getNextQuestion()).toBeNull();
    const id = await insertQuestion("Only question");
    expect(await getNextQuestion(id)).toBeNull();
  });

  it("returns existing questions in insertion order using the id cursor", async () => {
    const firstId = await insertQuestion("First question");
    const secondId = await insertQuestion("Second question");

    expect(await getNextQuestion()).toEqual({
      id: firstId,
      question: "First question",
      choices: ["A", "B", "C", "D"],
    });
    expect(await getNextQuestion(firstId)).toEqual({
      id: secondId,
      question: "Second question",
      choices: ["A", "B", "C", "D"],
    });
  });

  it("returns the complete row for answer lookup", async () => {
    const id = await insertQuestion("Answer lookup");
    const question = await getQuestionById(id);
    expect(question).toMatchObject({ id, question: "Answer lookup", correctIndex: 0 });
    expect(await getQuestionById(9999)).toBeNull();
  });
});
