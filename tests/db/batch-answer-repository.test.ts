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

  async function expectInvalidSubmission(
    input: Parameters<typeof saveAnswerSubmission>[0],
    message: string,
  ) {
    const submissionsBefore = await testDb.db.select().from(schema.examAnswerSubmissions);
    const answersBefore = await testDb.db.select().from(schema.examSubmissionAnswers);

    await expect(saveAnswerSubmission(input)).rejects.toMatchObject({
      name: "BatchSubmissionError",
      status: 400,
      message,
    });
    expect(await testDb.db.select().from(schema.examAnswerSubmissions)).toEqual(submissionsBefore);
    expect(await testDb.db.select().from(schema.examSubmissionAnswers)).toEqual(answersBefore);
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(0);
  }

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

  it.each([
    {
      label: "answer count other than five",
      answers: answers.slice(0, 4),
      message: "Exactly five distinct answers are required",
    },
    {
      label: "duplicate question IDs",
      answers: [...answers.slice(0, 4), { questionId: 4, selectedIndex: 1 }],
      message: "Exactly five distinct answers are required",
    },
    {
      label: "question IDs outside the exam set",
      answers: [
        { questionId: 1, selectedIndex: 0 },
        { questionId: 2, selectedIndex: 1 },
        { questionId: 3, selectedIndex: 2 },
        { questionId: 4, selectedIndex: 3 },
        { questionId: 6, selectedIndex: 0 },
      ],
      message: "Answers must match the submission's five questions",
    },
    {
      label: "free text for a choice question",
      answers: [...answers.slice(0, 4), { questionId: 5, freeText: "not a choice" }],
      message: "Answer type does not match its question",
    },
    {
      label: "choice index below zero",
      answers: answers.map((answer, index) =>
        index === 0 ? { questionId: 1, selectedIndex: -1 } : answer,
      ),
      message: "Answer type does not match its question",
    },
    {
      label: "choice index past the available choices",
      answers: answers.map((answer, index) =>
        index === 0 ? { questionId: 1, selectedIndex: 4 } : answer,
      ),
      message: "Answer type does not match its question",
    },
  ])(
    "rejects $label without writing a partial submission",
    async ({ answers: invalidAnswers, message }) => {
      await expectInvalidSubmission(
        {
          submissionId,
          operationId: firstOperationId,
          expectedRevision: 0,
          participantId,
          answers: invalidAnswers,
        },
        message,
      );
    },
  );

  it.each([
    ["blank after trimming", "  \n  "],
    ["longer than 1000 characters after trimming", ` ${"x".repeat(1001)} `],
  ])(
    "rejects free text that is %s without writing a partial submission",
    async (_label, freeText) => {
      await testDb.db
        .update(schema.examQuestions)
        .set({ key: "it-literacy-005" })
        .where(eq(schema.examQuestions.id, 5));
      await expectInvalidSubmission(
        {
          submissionId,
          operationId: firstOperationId,
          expectedRevision: 0,
          participantId,
          answers: [...answers.slice(0, 4), { questionId: 5, freeText }],
        },
        "Answer type does not match its question",
      );
    },
  );

  it("rejects choice answers for a free-text question without writing a partial submission", async () => {
    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "it-literacy-005" })
      .where(eq(schema.examQuestions.id, 5));
    await expectInvalidSubmission(
      {
        submissionId,
        operationId: firstOperationId,
        expectedRevision: 0,
        participantId,
        answers,
      },
      "Answer type does not match its question",
    );
  });

  it("rejects a missing question referenced by an existing submission without changing it", async () => {
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId,
      questionIds: [1, 2, 3, 4, 5],
      revision: 1,
    });
    await testDb.db.delete(schema.examQuestions).where(eq(schema.examQuestions.id, 5));

    await expectInvalidSubmission(
      {
        submissionId,
        operationId: firstOperationId,
        expectedRevision: 1,
        participantId,
        answers,
      },
      "Answer type does not match its question",
    );
  });

  it("rejects answer IDs that do not match an existing submission's question order", async () => {
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId,
      questionIds: [2, 1, 3, 4, 5],
      revision: 1,
    });

    await expectInvalidSubmission(
      {
        submissionId,
        operationId: firstOperationId,
        expectedRevision: 1,
        participantId,
        answers,
      },
      "Answers must match the submission's five questions",
    );
  });

  it("creates one five-answer submission and replays the same operation without duplicate writes", async () => {
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    await expect(saveAnswerSubmission(input)).resolves.toEqual({
      submissionId,
      revision: 1,
      assessmentTarget: null,
    });
    await expect(saveAnswerSubmission(input)).resolves.toEqual({
      submissionId,
      revision: 1,
      assessmentTarget: null,
    });

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
    ).resolves.toEqual({ submissionId, revision: 2, assessmentTarget: null });

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
      assessmentTarget: null,
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
