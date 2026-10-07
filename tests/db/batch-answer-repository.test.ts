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
  BatchSubmissionError,
  getAnswerSubmission,
  getLatestAnswerSubmission,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";

async function commitWinnerThenRaiseAdapterUniqueConflict(
  winnerInput: Parameters<typeof saveAnswerSubmission>[0],
  retryInput: Parameters<typeof saveAnswerSubmission>[0],
) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let intercept = true;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    if (!intercept) return originalTransaction(callback, config);
    intercept = false;
    return (async () => {
      await saveAnswerSubmission(winnerInput);
      // Cause a real SQLite primary-key conflict in the file-backed libSQL
      // adapter after the competing transaction has committed.
      return originalTransaction(async (tx) => {
        const [winnerOperation] = await tx
          .select()
          .from(schema.examSubmissionOperations)
          .where(eq(schema.examSubmissionOperations.operationId, winnerInput.operationId));
        if (!winnerOperation) throw new Error("Expected the winning operation to exist");
        await tx.insert(schema.examSubmissionOperations).values(winnerOperation);
        throw new Error("Expected duplicate operation ID to fail");
      }, config);
    })();
  });
  try {
    return await saveAnswerSubmission(retryInput);
  } finally {
    transactionSpy.mockRestore();
  }
}

describe("saveAnswerSubmission", () => {
  let testDb: TestDb;
  let participantId: number;
  const submissionId = "00000000-0000-4000-8000-000000000001";
  const firstOperationId = "00000000-0000-4000-8000-000000000002";
  const secondOperationId = "00000000-0000-4000-8000-000000000003";
  const answers = Array.from({ length: 5 }, (_, index) => ({
    questionId: index + 1,
    selectedIndex: index % 4,
  }));

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.examSubmissionOperations);
    await testDb.db.delete(schema.examSubmissionAnswers);
    await testDb.db.delete(schema.examAnswerSubmissions);
    await testDb.db.delete(schema.examAnswerLogs);
    await testDb.db.delete(schema.examQuestions);
    const [participant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "参加者", displayName: "参加者" })
      .returning({ id: schema.examParticipants.id });
    participantId = participant!.id;
    await testDb.db.insert(schema.examQuestions).values(
      answers.map(({ questionId }) => ({
        id: questionId,
        key: `question-${questionId}`,
        question: `Question ${questionId}`,
        choices: ["A", "B", "C", "D"],
        correctIndex: 0,
      })),
    );
  });

  afterEach(() => testDb.cleanup());

  it("creates one five-answer submission and replays the same operation without duplicate writes", async () => {
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    await expect(saveAnswerSubmission(input)).resolves.toEqual({ submissionId, revision: 1 });
    await expect(saveAnswerSubmission(input)).resolves.toEqual({ submissionId, revision: 1 });

    expect(await testDb.db.select().from(schema.examSubmissionAnswers)).toHaveLength(5);
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(1);
    expect(await testDb.db.select().from(schema.examAnswerLogs)).toHaveLength(0);
    await expect(getAnswerSubmission(submissionId, participantId)).resolves.toMatchObject({
      submissionId,
      revision: 1,
      answers: answers.map((answer) => ({ ...answer, answerKind: "selected", freeText: null })),
    });
    await expect(getAnswerSubmission(submissionId, participantId + 1)).resolves.toBeNull();
  });

  it("selects the participant's latest submission with the documented stable ordering", async () => {
    const updatedAt = new Date("2026-10-01T00:00:00.000Z");
    await testDb.db.insert(schema.examAnswerSubmissions).values([
      {
        id: "00000000-0000-4000-8000-000000000010",
        participantId,
        questionIds: [1, 2, 3, 4, 5],
        revision: 1,
        createdAt: updatedAt,
        updatedAt,
      },
      {
        id: "00000000-0000-4000-8000-000000000011",
        participantId,
        questionIds: [1, 2, 3, 4, 5],
        revision: 2,
        createdAt: updatedAt,
        updatedAt,
      },
    ]);

    await expect(getLatestAnswerSubmission(participantId)).resolves.toMatchObject({
      submissionId: "00000000-0000-4000-8000-000000000011",
      revision: 2,
      answers: [],
    });
    await expect(getLatestAnswerSubmission(participantId + 1)).resolves.toBeNull();
  });

  it("revises the same five rows and rejects a payload mismatch or stale revision", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });
    const revisedAnswers = answers.map((answer) => ({
      ...answer,
      selectedIndex: (answer.selectedIndex + 1) % 4,
    }));
    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: secondOperationId,
        expectedRevision: 1,
        participantId,
        answers: revisedAnswers,
      }),
    ).resolves.toEqual({ submissionId, revision: 2 });

    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: secondOperationId,
        expectedRevision: 1,
        participantId,
        answers,
      }),
    ).rejects.toBeInstanceOf(BatchSubmissionError);
    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: "00000000-0000-4000-8000-000000000004",
        expectedRevision: 1,
        participantId,
        answers,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const stored = await testDb.db
      .select()
      .from(schema.examSubmissionAnswers)
      .orderBy(schema.examSubmissionAnswers.questionId);
    expect(stored).toHaveLength(5);
    expect(stored.map(({ selectedIndex }) => selectedIndex)).toEqual(
      revisedAnswers.map(({ selectedIndex }) => selectedIndex),
    );
    expect(await testDb.db.select().from(schema.examAnswerSubmissions)).toHaveLength(1);
    expect(await testDb.db.select().from(schema.examAnswerLogs)).toHaveLength(0);
  });

  it("recovers a same-operation retry after an adapter conflict as idempotent success", async () => {
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    await expect(commitWinnerThenRaiseAdapterUniqueConflict(input, input)).resolves.toEqual({
      submissionId,
      revision: 1,
    });
    expect(await testDb.db.select().from(schema.examSubmissionAnswers)).toHaveLength(5);
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(1);
  });

  it("rejects an initial same-submission race and preserves only the winner's complete set", async () => {
    const winnerAnswers = answers.map((answer) => ({ ...answer, selectedIndex: 1 }));
    const retryAnswers = answers.map((answer) => ({ ...answer, selectedIndex: 2 }));
    const winnerInput = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers: winnerAnswers,
    };
    const retryInput = {
      ...winnerInput,
      operationId: secondOperationId,
      answers: retryAnswers,
    };

    await expect(
      commitWinnerThenRaiseAdapterUniqueConflict(winnerInput, retryInput),
    ).rejects.toMatchObject({ status: 409 });

    const stored = await testDb.db
      .select()
      .from(schema.examSubmissionAnswers)
      .orderBy(schema.examSubmissionAnswers.questionId);
    expect(stored).toHaveLength(5);
    expect(stored.map(({ selectedIndex }) => selectedIndex)).toEqual(Array(5).fill(1));
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(1);
  });

  it("rejects a same-revision correction race and keeps only one complete answer set", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });
    const leftAnswers = answers.map((answer) => ({ ...answer, selectedIndex: 1 }));
    const rightAnswers = answers.map((answer) => ({ ...answer, selectedIndex: 2 }));
    const winnerInput = {
      submissionId,
      operationId: secondOperationId,
      expectedRevision: 1,
      participantId,
      answers: leftAnswers,
    };
    const retryInput = {
      ...winnerInput,
      operationId: "00000000-0000-4000-8000-000000000005",
      answers: rightAnswers,
    };

    await expect(
      commitWinnerThenRaiseAdapterUniqueConflict(winnerInput, retryInput),
    ).rejects.toMatchObject({ status: 409 });

    const stored = await testDb.db
      .select()
      .from(schema.examSubmissionAnswers)
      .orderBy(schema.examSubmissionAnswers.questionId);
    expect(stored).toHaveLength(5);
    const storedIndices = stored.map(({ selectedIndex }) => selectedIndex);
    expect(storedIndices).toEqual(Array(5).fill(1));
    await expect(getAnswerSubmission(submissionId, participantId)).resolves.toMatchObject({
      revision: 2,
    });
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(2);
  });
});
