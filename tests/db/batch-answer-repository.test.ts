import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
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
import { setParticipantResultsVisible } from "@/lib/db/repository/presentation-repository.mutations";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function seedCommittedWinner(input: Parameters<typeof saveAnswerSubmission>[0]) {
  const database = dbRef.db!;
  const canonicalAnswers = [...input.answers].sort(
    (left, right) => left.questionId - right.questionId,
  );
  const revision = input.expectedRevision + 1;
  const payload = JSON.stringify({
    submissionId: input.submissionId,
    expectedRevision: input.expectedRevision,
    answers: canonicalAnswers,
  });

  await database.transaction(async (tx) => {
    const [existingSubmission] = await tx
      .select({ id: schema.examAnswerSubmissions.id })
      .from(schema.examAnswerSubmissions)
      .where(eq(schema.examAnswerSubmissions.id, input.submissionId));
    if (existingSubmission) {
      await tx
        .update(schema.examAnswerSubmissions)
        .set({ revision, updatedAt: new Date() })
        .where(eq(schema.examAnswerSubmissions.id, input.submissionId));
      await tx
        .delete(schema.examSubmissionAnswers)
        .where(eq(schema.examSubmissionAnswers.submissionId, input.submissionId));
    } else {
      await tx.insert(schema.examAnswerSubmissions).values({
        id: input.submissionId,
        participantId: input.participantId,
        questionIds: canonicalAnswers.map((answer) => answer.questionId),
        questionVersions: {},
        revision,
      });
    }
    await tx.insert(schema.examSubmissionAnswers).values(
      canonicalAnswers.map((answer) => ({
        submissionId: input.submissionId,
        questionId: answer.questionId,
        selectedIndex: "selectedIndex" in answer ? answer.selectedIndex : null,
        freeText: "freeText" in answer ? answer.freeText.trim() : null,
        answerKind: "freeText" in answer ? "freeText" : "selected",
      })),
    );
    const freeResponse = canonicalAnswers.find((answer) => "freeText" in answer);
    if (freeResponse && "freeText" in freeResponse) {
      await tx.insert(schema.examAnswerAssessments).values({
        submissionId: input.submissionId,
        questionId: freeResponse.questionId,
        revision,
        answerText: freeResponse.freeText.trim(),
        questionVersion: null,
        state: "pending",
        rubricVersion: "unversioned",
        attempts: 0,
        nextAttemptAt: new Date(0),
      });
    }
    await tx.insert(schema.examSubmissionOperations).values({
      operationId: input.operationId,
      submissionId: input.submissionId,
      payload,
      revision,
    });
  });
}

async function commitWinnerThenRaiseAdapterUniqueConflict(
  winnerInput: Parameters<typeof saveAnswerSubmission>[0],
  retryInput: Parameters<typeof saveAnswerSubmission>[0],
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
      await seedCommittedWinner(winnerInput);
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

async function commitOperationBetweenPreflightAndWrite(
  winnerInput: Parameters<typeof saveAnswerSubmission>[0],
  retryInput: Parameters<typeof saveAnswerSubmission>[0],
) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let insertedWinner = false;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    if (insertedWinner) return originalTransaction(callback, config);
    return (async () => {
      // The outer preflight is an autocommit read. Commit a competing operation
      // after it completes but before the transaction's first write.
      insertedWinner = true;
      await seedCommittedWinner(winnerInput);
      return originalTransaction(callback, config);
    })();
  });
  try {
    return await saveAnswerSubmission(retryInput);
  } finally {
    transactionSpy.mockRestore();
  }
}

async function insertMismatchedOperationAfterPreflight(
  input: Parameters<typeof saveAnswerSubmission>[0],
  captured: {
    before?: {
      submissions: unknown[];
      answers: unknown[];
      assessments: unknown[];
      operations: unknown[];
    };
  },
) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let insertedConflict = false;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    if (insertedConflict) return originalTransaction(callback, config);
    insertedConflict = true;
    return (async () => {
      await originalTransaction(async (tx) => {
        await tx.insert(schema.examSubmissionOperations).values({
          operationId: input.operationId,
          submissionId: input.submissionId,
          payload: "different canonical payload",
          revision: input.expectedRevision + 1,
        });
      }, config);
      captured.before = {
        submissions: await database.select().from(schema.examAnswerSubmissions),
        answers: await database.select().from(schema.examSubmissionAnswers),
        assessments: await database.select().from(schema.examAnswerAssessments),
        operations: await database.select().from(schema.examSubmissionOperations),
      };
      return originalTransaction(callback, config);
    })();
  });
  try {
    return await saveAnswerSubmission(input);
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

  it("allows distinct submissions for the same participant", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });
    await saveAnswerSubmission({
      submissionId: "00000000-0000-4000-8000-000000000007",
      operationId: secondOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });

    expect(await testDb.db.select().from(schema.examAnswerSubmissions)).toHaveLength(2);
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(2);
  });

  it("coalesces parallel retries of the same initial operation", async () => {
    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "it-literacy-005" })
      .where(eq(schema.examQuestions.id, 5));
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers: [...answers.slice(0, 4), { questionId: 5, freeText: "初回回答" }],
    };
    const results = await Promise.all([saveAnswerSubmission(input), saveAnswerSubmission(input)]);

    expect(results).toEqual([
      { submissionId, revision: 1, assessmentTarget: { submissionId, revision: 1 } },
      { submissionId, revision: 1, assessmentTarget: null },
    ]);
    expect(await testDb.db.select().from(schema.examAnswerSubmissions)).toHaveLength(1);
    expect(await testDb.db.select().from(schema.examSubmissionAnswers)).toHaveLength(5);
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(1);
  });

  it("keeps a replacement in-flight save registered when an older payload settles", async () => {
    const firstTransactionStarted = deferred<void>();
    const secondTransactionStarted = deferred<void>();
    const releaseFirstTransaction = deferred<void>();
    const releaseSecondTransaction = deferred<void>();
    const database = dbRef.db!;
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    let transactionCount = 0;
    transactionSpy.mockImplementation((callback, config) => {
      transactionCount += 1;
      const currentTransaction = transactionCount;
      if (currentTransaction === 1) {
        firstTransactionStarted.resolve();
        return (async () => {
          await releaseFirstTransaction.promise;
          return originalTransaction(callback, config);
        })();
      }
      if (currentTransaction === 2) {
        secondTransactionStarted.resolve();
        return (async () => {
          await releaseSecondTransaction.promise;
          return originalTransaction(callback, config);
        })();
      }
      return originalTransaction(callback, config);
    });

    const firstInput = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    const replacementInput = {
      ...firstInput,
      answers: answers.map((answer) => ({
        ...answer,
        selectedIndex: (answer.selectedIndex + 1) % 4,
      })),
    };
    let firstSave: ReturnType<typeof saveAnswerSubmission> | undefined;
    let replacementSave: ReturnType<typeof saveAnswerSubmission> | undefined;
    let matchingRetry: ReturnType<typeof saveAnswerSubmission> | undefined;

    try {
      firstSave = saveAnswerSubmission(firstInput);
      await firstTransactionStarted.promise;
      replacementSave = saveAnswerSubmission(replacementInput);
      await secondTransactionStarted.promise;

      releaseFirstTransaction.resolve();
      await expect(firstSave).resolves.toMatchObject({ revision: 1 });

      matchingRetry = saveAnswerSubmission(replacementInput);
      expect(transactionCount).toBe(2);

      releaseSecondTransaction.resolve();
      await expect(replacementSave).rejects.toMatchObject({ status: 409 });
      await expect(matchingRetry).rejects.toMatchObject({ status: 409 });
      expect(transactionCount).toBe(2);
    } finally {
      releaseFirstTransaction.resolve();
      releaseSecondTransaction.resolve();
      await Promise.allSettled([firstSave, replacementSave, matchingRetry]);
      transactionSpy.mockRestore();
    }
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

  it("rejects a fresh operation for an existing submission when its expected revision is stale", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });

    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: secondOperationId,
        expectedRevision: 0,
        participantId,
        answers,
      }),
    ).rejects.toMatchObject({
      name: "BatchSubmissionError",
      status: 409,
      message: "Submission revision conflict",
    });

    expect(
      await testDb.db
        .select()
        .from(schema.examSubmissionOperations)
        .where(eq(schema.examSubmissionOperations.operationId, secondOperationId)),
    ).toHaveLength(0);
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(1);
  });

  it("rejects a revision advance committed after preflight and rolls back the new operation", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });

    const concurrentInput = {
      submissionId,
      operationId: "00000000-0000-4000-8000-000000000004",
      expectedRevision: 1,
      participantId,
      answers,
    };
    const retryInput = {
      ...concurrentInput,
      operationId: "00000000-0000-4000-8000-000000000005",
    };

    await expect(
      commitOperationBetweenPreflightAndWrite(concurrentInput, retryInput),
    ).rejects.toMatchObject({
      name: "BatchSubmissionError",
      status: 409,
      message: "Submission revision conflict",
    });

    await expect(
      testDb.db
        .select()
        .from(schema.examSubmissionOperations)
        .where(eq(schema.examSubmissionOperations.operationId, retryInput.operationId)),
    ).resolves.toHaveLength(0);
    await expect(
      testDb.db
        .select({ revision: schema.examAnswerSubmissions.revision })
        .from(schema.examAnswerSubmissions)
        .where(eq(schema.examAnswerSubmissions.id, submissionId)),
    ).resolves.toEqual([{ revision: 2 }]);
  });

  it("allows saves while results are visible and keeps matching replays idempotent", async () => {
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "not_started",
      version: 0,
      questionIndex: 0,
      questionCount: 5,
      snapshotRevision: 1,
      projectionHidden: false,
    });
    await setParticipantResultsVisible(true);

    // A first submission is permitted even while results are visible.
    await expect(saveAnswerSubmission(input)).resolves.toMatchObject({ revision: 1 });
    // If replay tried to acquire the presentation lock, it would recreate this row.
    await testDb.db.delete(schema.presentationSessions);
    // The UI disables correction, but the API accepts a stale/direct save.
    await expect(saveAnswerSubmission(input)).resolves.toMatchObject({ revision: 1 });
    expect(await testDb.db.select().from(schema.presentationSessions)).toHaveLength(0);
    await expect(
      saveAnswerSubmission({ ...input, operationId: secondOperationId, expectedRevision: 1 }),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(getAnswerSubmission(submissionId, participantId)).resolves.toMatchObject({
      resultsVisible: true,
      revision: 2,
    });
  });

  it("does not serialize answer updates with publication visibility", async () => {
    const [session] = await testDb.db
      .insert(schema.presentationSessions)
      .values({
        id: 1,
        state: "not_started",
        version: 0,
        questionIndex: 0,
        questionCount: 5,
        snapshotRevision: 1,
        projectionHidden: false,
      })
      .returning();
    expect(session).toBeDefined();

    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });
    await setParticipantResultsVisible(true);
    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: secondOperationId,
        expectedRevision: 1,
        participantId,
        answers,
      }),
    ).resolves.toMatchObject({ revision: 2 });

    await setParticipantResultsVisible(false);
    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: "00000000-0000-4000-8000-000000000006",
        expectedRevision: 2,
        participantId,
        answers,
      }),
    ).resolves.toMatchObject({ revision: 3 });
  });

  it("allows an existing submission revision after results are hidden", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });
    await testDb.db.insert(schema.participantResultSettings).values({ id: 1, visible: true });
    await testDb.db
      .update(schema.participantResultSettings)
      .set({ visible: false })
      .where(eq(schema.participantResultSettings.id, 1));

    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: secondOperationId,
        expectedRevision: 1,
        participantId,
        answers,
      }),
    ).resolves.toMatchObject({ revision: 2 });
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

  it("replays an operation committed after preflight when it is found under the lock", async () => {
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };

    await expect(commitOperationBetweenPreflightAndWrite(input, input)).resolves.toEqual({
      submissionId,
      revision: 1,
      assessmentTarget: null,
    });
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(1);
  });

  it("replays a matching operation committed after preflight for an existing submission", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });
    const retryInput = {
      submissionId,
      operationId: secondOperationId,
      expectedRevision: 1,
      participantId,
      answers,
    };

    await expect(commitOperationBetweenPreflightAndWrite(retryInput, retryInput)).resolves.toEqual({
      submissionId,
      revision: 2,
      assessmentTarget: null,
    });
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(2);
  });

  it("rejects a conflicting operation committed after preflight when found under the lock", async () => {
    const winnerInput = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    const conflictingInput = {
      ...winnerInput,
      answers: answers.map((answer) => ({
        ...answer,
        selectedIndex: (answer.selectedIndex + 1) % 4,
      })),
    };

    await expect(
      commitOperationBetweenPreflightAndWrite(winnerInput, conflictingInput),
    ).rejects.toMatchObject({ status: 409 });
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toHaveLength(1);
  });

  it("returns operation-used when an operation reservation conflicts but replay is absent", async () => {
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId,
      questionIds: [1, 2, 3, 4, 5],
      revision: 1,
    });
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 1,
      participantId,
      answers,
    };
    const database = dbRef.db!;
    const originalTransaction = database.transaction.bind(database);
    const transaction = vi.spyOn(database, "transaction");
    transaction.mockImplementation((callback, config) =>
      originalTransaction(async (tx) => {
        const wrappedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "insert") {
              return (table: unknown) => {
                if (table === schema.examSubmissionOperations) {
                  return {
                    values() {
                      return {
                        onConflictDoNothing() {
                          return { returning: async () => [] };
                        },
                      };
                    },
                  };
                }
                return Reflect.apply(Reflect.get(target, property, target), target, [table]);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return callback(wrappedTx);
      }, config),
    );
    try {
      await expect(saveAnswerSubmission(input)).rejects.toMatchObject({
        status: 409,
        message: "Operation ID was already used",
      });
    } finally {
      transaction.mockRestore();
    }
  });

  it("returns not found when an in-transaction operation replay has no visible owner", async () => {
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId,
      questionIds: [1, 2, 3, 4, 5],
      revision: 1,
    });
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 1,
      participantId,
      answers,
    };
    const database = dbRef.db!;
    const originalTransaction = database.transaction.bind(database);
    const transaction = vi.spyOn(database, "transaction");
    let injected = false;
    transaction.mockImplementation((callback, config) => {
      if (injected) return originalTransaction(callback, config);
      injected = true;
      return (async () => {
        await originalTransaction(async (tx) => {
          await tx.insert(schema.examSubmissionOperations).values({
            operationId: input.operationId,
            submissionId,
            payload: "concurrent payload",
            revision: 2,
          });
        }, config);
        return originalTransaction(async (tx) => {
          const wrapSelect = (builder: object, table?: unknown): object =>
            new Proxy(builder, {
              get(target, property) {
                const member = Reflect.get(target, property, target) as unknown;
                if (property === "from" && typeof member === "function") {
                  return (fromTable: unknown) =>
                    wrapSelect(Reflect.apply(member, target, [fromTable]) as object, fromTable);
                }
                if (property === "where" && typeof member === "function") {
                  return () =>
                    table === schema.examAnswerSubmissions
                      ? Promise.resolve([])
                      : Reflect.apply(member, target, []);
                }
                return typeof member === "function" ? member.bind(target) : member;
              },
            });
          const wrappedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === "insert") {
                return (table: unknown) => {
                  if (table === schema.examSubmissionOperations) {
                    return {
                      values() {
                        return {
                          onConflictDoNothing() {
                            return { returning: async () => [] };
                          },
                        };
                      },
                    };
                  }
                  return Reflect.apply(Reflect.get(target, property, target), target, [table]);
                };
              }
              if (property === "select") {
                return (...args: unknown[]) =>
                  wrapSelect(
                    Reflect.apply(Reflect.get(target, property, target), target, args) as object,
                  );
              }
              return Reflect.get(target, property, receiver);
            },
          });
          return callback(wrappedTx);
        }, config);
      })();
    });
    try {
      await expect(saveAnswerSubmission(input)).rejects.toMatchObject({
        status: 404,
        message: "Submission not found",
      });
    } finally {
      transaction.mockRestore();
    }
  });

  it("returns not found for an operation owned by another participant committed after preflight", async () => {
    const [otherParticipant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "別の参加者", displayName: "別の参加者" })
      .returning({ id: schema.examParticipants.id });
    const winnerInput = {
      submissionId: "00000000-0000-4000-8000-000000000006",
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId: otherParticipant!.id,
      answers,
    };
    const retryInput = {
      ...winnerInput,
      submissionId,
      participantId,
    };

    await expect(
      commitOperationBetweenPreflightAndWrite(winnerInput, retryInput),
    ).rejects.toMatchObject({ status: 404, message: "Submission not found" });
  });

  it("returns not found when a submission ID race reveals a foreign owner", async () => {
    const [otherParticipant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "submission-race-owner", displayName: "submission-race-owner" })
      .returning({ id: schema.examParticipants.id });
    const winnerInput = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId: otherParticipant!.id,
      answers,
    };
    const retryInput = {
      ...winnerInput,
      operationId: secondOperationId,
      participantId,
    };

    await expect(
      commitOperationBetweenPreflightAndWrite(winnerInput, retryInput),
    ).rejects.toMatchObject({ status: 404, message: "Submission not found" });
  });

  it("returns not found when a submission ID conflict has no visible owner", async () => {
    const input = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    const database = dbRef.db!;
    const originalTransaction = database.transaction.bind(database);
    const transaction = vi.spyOn(database, "transaction");
    transaction.mockImplementation((callback, config) =>
      originalTransaction(async (tx) => {
        const wrapSelect = (builder: object, table?: unknown): object =>
          new Proxy(builder, {
            get(target, property) {
              const member = Reflect.get(target, property, target) as unknown;
              if (property === "from" && typeof member === "function") {
                return (fromTable: unknown) =>
                  wrapSelect(Reflect.apply(member, target, [fromTable]) as object, fromTable);
              }
              if (property === "where" && typeof member === "function") {
                return () =>
                  table === schema.examSubmissionOperations ||
                  table === schema.examAnswerSubmissions
                    ? Promise.resolve([])
                    : Reflect.apply(member, target, []);
              }
              return typeof member === "function" ? member.bind(target) : member;
            },
          });
        const wrappedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "run") return async () => ({ rowsAffected: 0 });
            if (property === "select") {
              return (...args: unknown[]) =>
                wrapSelect(
                  Reflect.apply(Reflect.get(target, property, target), target, args) as object,
                );
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return callback(wrappedTx);
      }, config),
    );
    try {
      await expect(saveAnswerSubmission(input)).rejects.toMatchObject({
        status: 404,
        message: "Submission not found",
      });
    } finally {
      transaction.mockRestore();
    }
  });

  it("rejects a same-owner new-submission ID race and preserves only the winner's complete set", async () => {
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
      commitOperationBetweenPreflightAndWrite(winnerInput, retryInput),
    ).rejects.toMatchObject({ status: 409 });

    const stored = await testDb.db
      .select()
      .from(schema.examSubmissionAnswers)
      .orderBy(schema.examSubmissionAnswers.questionId);
    expect(stored).toHaveLength(5);
    expect(stored.map(({ selectedIndex }) => selectedIndex)).toEqual(Array(5).fill(1));
    expect(
      (
        await testDb.db
          .select({ operationId: schema.examSubmissionOperations.operationId })
          .from(schema.examSubmissionOperations)
      ).map(({ operationId }) => operationId),
    ).toEqual([firstOperationId]);
  });

  it("returns not found when unique-conflict recovery finds an operation owned by another participant", async () => {
    const [otherParticipant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "別の参加者", displayName: "別の参加者" })
      .returning({ id: schema.examParticipants.id });
    const winnerInput = {
      submissionId: "00000000-0000-4000-8000-000000000006",
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId: otherParticipant!.id,
      answers,
    };
    const retryInput = {
      ...winnerInput,
      submissionId,
      participantId,
    };

    await expect(
      commitWinnerThenRaiseAdapterUniqueConflict(winnerInput, retryInput),
    ).rejects.toMatchObject({ status: 404, message: "Submission not found" });
  });

  it("returns conflict when unique-conflict recovery finds a same-owner operation with a different payload", async () => {
    const winnerInput = {
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    };
    const retryInput = {
      ...winnerInput,
      answers: answers.map((answer) => ({
        ...answer,
        selectedIndex: (answer.selectedIndex + 1) % 4,
      })),
    };

    await expect(
      commitWinnerThenRaiseAdapterUniqueConflict(winnerInput, retryInput),
    ).rejects.toMatchObject({ status: 409, message: "Operation ID was already used" });
  });

  it("rejects a correction whose operation ID is claimed after preflight without changing saved state", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers,
    });
    const correctionInput = {
      submissionId,
      operationId: secondOperationId,
      expectedRevision: 1,
      participantId,
      answers: answers.map((answer) => ({
        ...answer,
        selectedIndex: (answer.selectedIndex + 1) % 4,
      })),
    };
    const captured: {
      before?: {
        submissions: unknown[];
        answers: unknown[];
        assessments: unknown[];
        operations: unknown[];
      };
    } = {};

    await expect(
      insertMismatchedOperationAfterPreflight(correctionInput, captured),
    ).rejects.toMatchObject({
      status: 409,
      message: "Operation ID was already used",
    });

    expect(captured.before).toBeDefined();
    expect(await testDb.db.select().from(schema.examAnswerSubmissions)).toEqual(
      captured.before!.submissions,
    );
    expect(await testDb.db.select().from(schema.examSubmissionAnswers)).toEqual(
      captured.before!.answers,
    );
    expect(await testDb.db.select().from(schema.examAnswerAssessments)).toEqual(
      captured.before!.assessments,
    );
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toEqual(
      captured.before!.operations,
    );
    expect(captured.before!.submissions[0]).toMatchObject({ revision: 1 });
  });

  it("rolls back correction reservation and answer changes when assessment persistence fails", async () => {
    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "it-literacy-005" })
      .where(eq(schema.examQuestions.id, 5));
    const initialAnswers = [...answers.slice(0, 4), { questionId: 5, freeText: "初回回答" }];
    await saveAnswerSubmission({
      submissionId,
      operationId: firstOperationId,
      expectedRevision: 0,
      participantId,
      answers: initialAnswers,
    });
    await testDb.db.run(sql`
      CREATE TRIGGER fail_assessment_update
      BEFORE UPDATE ON exam_answer_assessments
      BEGIN SELECT RAISE(ABORT, 'forced assessment write failure'); END
    `);
    const before = {
      submissions: await testDb.db.select().from(schema.examAnswerSubmissions),
      answers: await testDb.db.select().from(schema.examSubmissionAnswers),
      assessments: await testDb.db.select().from(schema.examAnswerAssessments),
      operations: await testDb.db.select().from(schema.examSubmissionOperations),
    };

    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId: secondOperationId,
        expectedRevision: 1,
        participantId,
        answers: [...answers.slice(0, 4), { questionId: 5, freeText: "修正回答" }],
      }),
    ).rejects.toThrow();

    expect(await testDb.db.select().from(schema.examAnswerSubmissions)).toEqual(before.submissions);
    expect(await testDb.db.select().from(schema.examSubmissionAnswers)).toEqual(before.answers);
    expect(await testDb.db.select().from(schema.examAnswerAssessments)).toEqual(before.assessments);
    expect(await testDb.db.select().from(schema.examSubmissionOperations)).toEqual(
      before.operations,
    );
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
