import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";
import { jstDayStart } from "@/lib/date";

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

import { recordAnswer, getStats } from "@/lib/db/repository/answer-repository";

async function insertQuestion() {
  const [q] = await dbRef
    .db!.insert(schema.examQuestions)
    .values({
      id: 1,
      key: "test-1",
      question: "Q?",
      choices: ["A", "B", "C", "D"],
      correctIndex: 0,
      explanation: null,
    })
    .returning({ id: schema.examQuestions.id });
  return q!.id;
}

describe("answer-repository", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    await testDb.db.delete(schema.examAnswerLogs);
    await testDb.db.delete(schema.examQuestions);
    dbRef.db = testDb.db;
  });

  afterEach(() => {
    testDb.cleanup();
  });

  describe("recordAnswer", () => {
    it("preserves anonymous answer logs with a null participant ID", async () => {
      const questionId = await insertQuestion();
      await recordAnswer({ questionId, selectedIndex: 0, isCorrect: true });

      const rows = await dbRef.db!.select().from(schema.examAnswerLogs);
      expect(rows).toHaveLength(1);
      expect(rows[0].questionId).toBe(questionId);
      expect(rows[0].isCorrect).toBe(1);
      expect(rows[0].selectedIndex).toBe(0);
      expect(rows[0].participantId).toBeNull();
    });

    it("stores the participant ID for a new participant answer", async () => {
      const questionId = await insertQuestion();
      const [participant] = await dbRef
        .db!.insert(schema.examParticipants)
        .values({ normalizedName: "山田", displayName: "山田" })
        .returning({ id: schema.examParticipants.id });

      await recordAnswer({
        questionId,
        selectedIndex: 0,
        isCorrect: true,
        participantId: participant!.id,
      });

      const rows = await dbRef.db!.select().from(schema.examAnswerLogs);
      expect(rows).toHaveLength(1);
      expect(rows[0].participantId).toBe(participant!.id);
    });
  });

  describe("getStats", () => {
    it("returns zero stats when no data", async () => {
      const stats = await getStats();
      expect(stats).toEqual({ totalQuestions: 0, todayAnswers: 0, todayAccuracy: 0 });
    });

    it("counts total questions and today's answers, crossing the JST day boundary", async () => {
      const questionId = await insertQuestion();
      const dayStart = jstDayStart();

      // Today (JST): 2 correct + 1 incorrect = 3 answers.
      await dbRef.db!.insert(schema.examAnswerLogs).values([
        { questionId, selectedIndex: 0, isCorrect: 1, answeredAt: new Date() },
        { questionId, selectedIndex: 0, isCorrect: 1, answeredAt: new Date() },
        { questionId, selectedIndex: 1, isCorrect: 0, answeredAt: new Date() },
      ]);

      // Before today's JST day start (2 days ago): must NOT be counted.
      await dbRef.db!.insert(schema.examAnswerLogs).values({
        questionId,
        selectedIndex: 0,
        isCorrect: 1,
        answeredAt: new Date(dayStart.getTime() - 2 * 24 * 60 * 60 * 1000),
      });

      const stats = await getStats();
      expect(stats.totalQuestions).toBe(1);
      expect(stats.todayAnswers).toBe(3);
      expect(stats.todayAccuracy).toBeCloseTo(2 / 3);
    });

    it("returns accuracy 0 when there are no today answers", async () => {
      const questionId = await insertQuestion();
      const dayStart = jstDayStart();
      await dbRef.db!.insert(schema.examAnswerLogs).values({
        questionId,
        selectedIndex: 0,
        isCorrect: 1,
        answeredAt: new Date(dayStart.getTime() - 24 * 60 * 60 * 1000),
      });

      const stats = await getStats();
      expect(stats.totalQuestions).toBe(1);
      expect(stats.todayAnswers).toBe(0);
      expect(stats.todayAccuracy).toBe(0);
    });
  });
});
