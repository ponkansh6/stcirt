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

import { getExamQuestions, getQuestionById } from "@/lib/db/repository/question-repository";

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

  it("returns the first five questions in order with only public exam fields", async () => {
    for (let id = 1; id <= 6; id += 1) {
      await testDb.db.insert(schema.examQuestions).values({
        id,
        key: id === 5 ? "it-literacy-005" : `test-${id}`,
        question: `Question ${id}`,
        choices: id === 5 ? [] : ["A", "B", "C", "D"],
        correctIndex: id === 5 ? 0 : 2,
        explanation: `Explanation ${id}`,
      });
    }

    const questions = await getExamQuestions();
    expect(questions.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
    expect(questions[4]).toEqual({
      id: 5,
      question: "Question 5",
      choices: [],
      answerType: "freeText",
    });
    expect(
      questions.every(
        (question) => Object.keys(question).sort().join(",") === "answerType,choices,id,question",
      ),
    ).toBe(true);
  });

  it("returns the complete row for answer lookup", async () => {
    const id = await insertQuestion("Answer lookup");
    const question = await getQuestionById(id);
    expect(question).toMatchObject({ id, question: "Answer lookup", correctIndex: 0 });
    expect(await getQuestionById(9999)).toBeNull();
  });
});
