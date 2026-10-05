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
  getAdminPresentation,
  getPublicPresentation,
  operatePresentation,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";

async function commitWinnerThenRaiseAdapterUniqueConflict(operationId: string) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let intercept = true;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    if (!intercept) return originalTransaction(callback, config);
    intercept = false;
    return (async () => {
      await operatePresentation(operationId, "advance");
      return originalTransaction(async (tx) => {
        const [winnerOperation] = await tx
          .select()
          .from(schema.presentationOperations)
          .where(eq(schema.presentationOperations.operationId, operationId));
        if (!winnerOperation) throw new Error("Expected the winning operation to exist");
        await tx.insert(schema.presentationOperations).values(winnerOperation);
        throw new Error("Expected duplicate operation ID to fail");
      }, config);
    })();
  });
  try {
    return await operatePresentation(operationId, "advance");
  } finally {
    transactionSpy.mockRestore();
  }
}

describe("presentation repository", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    // Migrations seed the normal seven-question set; these specs use an exact
    // two-question fixture so stage indexes and question counts stay local.
    await testDb.db.delete(schema.presentationOperations);
    await testDb.db.delete(schema.presentationQuestions);
    await testDb.db.delete(schema.presentationEntries);
    await testDb.db.delete(schema.presentationSessions);
    await testDb.db.delete(schema.examSubmissionOperations);
    await testDb.db.delete(schema.examSubmissionAnswers);
    await testDb.db.delete(schema.examAnswerSubmissions);
    await testDb.db.delete(schema.examAnswerLogs);
    await testDb.db.delete(schema.examParticipants);
    await testDb.db.delete(schema.examQuestions);
  });

  afterEach(() => testDb.cleanup());

  async function addQuestions() {
    await testDb.db.insert(schema.examQuestions).values([
      {
        id: 22,
        key: "presentation-q22",
        question: "Question 22",
        choices: ["Correct 22", "Wrong 22"],
        correctIndex: 0,
        explanation: "Explanation 22",
      },
      {
        id: 11,
        key: "presentation-q11",
        question: "Question 11",
        choices: ["Correct 11", "Wrong 11"],
        correctIndex: 0,
        explanation: "Explanation 11",
      },
    ]);
  }

  async function addParticipant(name: string) {
    const [participant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: name, displayName: name })
      .returning({ id: schema.examParticipants.id });
    return participant!.id;
  }

  async function addSubmission(
    participantId: number,
    selectedIndices: number[],
    revision = 1,
    suffix = "latest",
  ) {
    const id = `submission-${participantId}-${suffix}`;
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id,
      participantId,
      questionIds: [11, 22],
      revision,
    });
    await testDb.db.insert(schema.examSubmissionAnswers).values(
      [11, 22].map((questionId, index) => ({
        submissionId: id,
        questionId,
        selectedIndex: selectedIndices[index]!,
      })),
    );
  }

  async function addRankFixture() {
    await addQuestions();
    const first = await addParticipant("First");
    const tied = await addParticipant("Tied");
    const third = await addParticipant("Third");
    const unanswered = await addParticipant("Unanswered");
    await addSubmission(first, [0, 0]);
    await addSubmission(tied, [0, 0]);
    await addSubmission(third, [0, 1]);
    return { first, tied, third, unanswered };
  }

  async function op(action: "start" | "advance" | "previous" | "hide" | "show", id: string) {
    return operatePresentation(`operation-${id}`, action);
  }

  it("snapshots questions in ID order and freezes every participant score and standard tie rank", async () => {
    const participants = await addRankFixture();

    const started = await op("start", "start");
    expect(started.questions.map(({ id }) => id)).toEqual([11, 22]);
    expect(started.entries).toEqual([
      { displayName: "First", score: 2, rank: 1 },
      { displayName: "Tied", score: 2, rank: 1 },
      { displayName: "Third", score: 1, rank: 3 },
      { displayName: "Unanswered", score: 0, rank: 4 },
    ]);

    await testDb.db
      .update(schema.examQuestions)
      .set({ question: "Edited after start", explanation: "Changed explanation" })
      .where(eq(schema.examQuestions.id, 11));
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ selectedIndex: 1 })
      .where(
        eq(schema.examSubmissionAnswers.submissionId, `submission-${participants.first}-latest`),
      );
    await testDb.db
      .update(schema.examParticipants)
      .set({ displayName: "Changed name" })
      .where(eq(schema.examParticipants.id, participants.first));

    const restored = await getAdminPresentation();
    expect(restored.questions[0]).toMatchObject({
      id: 11,
      question: "Question 11",
      explanation: "Explanation 11",
    });
    expect(restored.entries[0]).toEqual({ displayName: "First", score: 2, rank: 1 });
  });

  it("keeps correct answers private on question stages and exposes only announced winners", async () => {
    await addRankFixture();
    await op("start", "start");

    const question = await getPublicPresentation();
    expect(question).toEqual({
      state: "question",
      question: {
        id: 11,
        ordinal: 1,
        total: 2,
        question: "Question 11",
        choices: ["Correct 11", "Wrong 11"],
      },
    });
    expect(JSON.stringify(question)).not.toContain("correctAnswer");
    expect(JSON.stringify(question)).not.toContain("Explanation");

    await op("advance", "a1");
    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "answer",
      question: { correctAnswer: "Correct 11", correctIndex: 0, explanation: "Explanation 11" },
    });
    await op("advance", "a2");
    await op("advance", "a3");
    await op("advance", "a4");

    await expect(getPublicPresentation()).resolves.toEqual({ state: "podium_preview" });
    await op("advance", "a5");
    await expect(getPublicPresentation()).resolves.toEqual({
      state: "third",
      winners: [{ displayName: "Third", score: 1, rank: 3 }],
    });
  });

  it("persists short mode before start and omits explanation only in answer projection", async () => {
    await addQuestions();
    await expect(getAdminPresentation()).resolves.toMatchObject({ presentationMode: "full" });
    const short = await operatePresentation("mode-short", "setMode", "short");
    expect(short).toMatchObject({ state: "not_started", presentationMode: "short" });
    await operatePresentation("start-short", "start");

    const question = await getPublicPresentation();
    expect(question).toMatchObject({ state: "question" });
    expect(JSON.stringify(question)).not.toContain("correctAnswer");
    await operatePresentation("answer-short", "advance");
    const answer = await getPublicPresentation();
    expect(answer).toMatchObject({
      state: "answer",
      question: {
        choices: ["Correct 11", "Wrong 11"],
        correctAnswer: "Correct 11",
        correctIndex: 0,
      },
    });
    expect(answer).not.toHaveProperty("question.explanation");

    await operatePresentation("mode-full", "setMode", "full");
    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "answer",
      question: { explanation: "Explanation 11" },
    });
    await expect(operatePresentation("mode-short", "setMode", "full")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("keeps the standby projection empty and restores the saved stage on show", async () => {
    await addQuestions();
    const hidden = await operatePresentation("hide-before-start", "hide");
    expect(hidden).toMatchObject({ state: "not_started", projectionHidden: true });
    await expect(getPublicPresentation()).resolves.toEqual({ state: "standby" });

    await operatePresentation("start-hidden", "start");
    await expect(getPublicPresentation()).resolves.toEqual({ state: "standby" });
    await operatePresentation("show-after-start", "show");
    await expect(getPublicPresentation()).resolves.toMatchObject({ state: "question" });
  });

  it("moves backward across skipped podium ranks and returns from finished to the last existing rank", async () => {
    await addQuestions();
    const first = await addParticipant("Winner");
    const second = await addParticipant("Runner up");
    await addSubmission(first, [0, 0]);
    await addSubmission(second, [0, 1]);
    await op("start", "start");
    for (let index = 0; index < 4; index += 1) await op("advance", `advance-${index}`);
    await expect(getAdminPresentation()).resolves.toMatchObject({ state: "podium_preview" });
    await op("advance", "advance-to-second");
    await expect(getAdminPresentation()).resolves.toMatchObject({ state: "second" });
    await op("advance", "advance-to-first");
    await op("advance", "advance-to-finished");
    await expect(getAdminPresentation()).resolves.toMatchObject({ state: "finished" });

    await op("previous", "back-to-last-rank");
    await expect(getAdminPresentation()).resolves.toMatchObject({ state: "first" });
    await op("previous", "back-to-runner-up");
    await expect(getAdminPresentation()).resolves.toMatchObject({ state: "second" });
    await op("previous", "back-to-preview");
    await expect(getAdminPresentation()).resolves.toMatchObject({ state: "podium_preview" });
  });

  it("rejects previous at the first state and makes action retries idempotent", async () => {
    await addQuestions();
    await expect(op("previous", "before-start")).rejects.toBeInstanceOf(PresentationConflictError);
    const started = await operatePresentation("stable-start", "start");
    const replayedStart = await operatePresentation("stable-start", "start");
    expect(replayedStart.version).toBe(started.version);
    expect(await testDb.db.select().from(schema.presentationQuestions)).toHaveLength(2);

    await expect(op("previous", "at-first-stage")).rejects.toMatchObject({ status: 409 });
    const advanced = await operatePresentation("stable-advance", "advance");
    const replayedAdvance = await operatePresentation("stable-advance", "advance");
    expect(replayedAdvance.version).toBe(advanced.version);
    expect(replayedAdvance.state).toBe("answer");
    await expect(operatePresentation("stable-advance", "previous")).rejects.toMatchObject({
      status: 409,
    });
    expect(await testDb.db.select().from(schema.presentationOperations)).toHaveLength(2);
  });

  it("recovers an operation retry after an adapter conflict without advancing twice", async () => {
    await addQuestions();
    await op("start", "start");

    const recovered = await commitWinnerThenRaiseAdapterUniqueConflict("adapter-retry");

    expect(recovered).toMatchObject({ state: "answer", questionIndex: 0, version: 2 });
    expect(await testDb.db.select().from(schema.presentationOperations)).toHaveLength(2);
  });
});
