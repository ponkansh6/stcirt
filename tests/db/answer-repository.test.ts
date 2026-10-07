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

import {
  getAnswerSubmission,
  getLatestAnswerSubmission,
  getStats,
  recordAnswer,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";

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

async function insertFiveQuestions() {
  await dbRef.db!.insert(schema.examQuestions).values(
    Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      key: `test-${index + 1}`,
      question: `Q${index + 1}?`,
      choices: ["A", "B", "C", "D"],
      correctIndex: 0,
      explanation: null,
    })),
  );
  return Array.from({ length: 5 }, (_, index) => index + 1);
}

function selectedAnswers(questionIds: number[]) {
  return questionIds.map((questionId) => ({ questionId, selectedIndex: 0 }));
}

async function insertParticipant(normalizedName = "山田") {
  const [participant] = await dbRef
    .db!.insert(schema.examParticipants)
    .values({ normalizedName, displayName: normalizedName })
    .returning({ id: schema.examParticipants.id });
  return participant!.id;
}

async function insertSubmission(input: {
  id: string;
  participantId: number;
  questionIds: number[];
  revision?: number;
}) {
  await dbRef.db!.insert(schema.examAnswerSubmissions).values({
    id: input.id,
    participantId: input.participantId,
    questionIds: input.questionIds,
    revision: input.revision ?? 1,
  });
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

    it("persists an incorrect selected answer as incorrect", async () => {
      const questionId = await insertQuestion();
      await recordAnswer({ questionId, selectedIndex: 1, isCorrect: false });

      const rows = await dbRef.db!.select().from(schema.examAnswerLogs);
      expect(rows).toHaveLength(1);
      expect(rows[0].questionId).toBe(questionId);
      expect(rows[0].selectedIndex).toBe(1);
      expect(rows[0].isCorrect).toBe(0);
    });
  });

  describe("getLatestAnswerSubmission", () => {
    it("uses createdAt to break updatedAt and revision ties", async () => {
      const [participant] = await dbRef
        .db!.insert(schema.examParticipants)
        .values({ normalizedName: "山田", displayName: "山田" })
        .returning({ id: schema.examParticipants.id });
      const updatedAt = new Date("2026-01-02T00:00:00.000Z");

      await dbRef.db!.insert(schema.examAnswerSubmissions).values([
        {
          id: "z-older",
          participantId: participant!.id,
          questionIds: [],
          revision: 2,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt,
        },
        {
          id: "a-newer",
          participantId: participant!.id,
          questionIds: [],
          revision: 2,
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          updatedAt,
        },
      ]);

      await expect(getLatestAnswerSubmission(participant!.id)).resolves.toMatchObject({
        submissionId: "a-newer",
        revision: 2,
        answers: [],
      });
    });

    it("uses descending ID to break updatedAt, revision, and createdAt ties", async () => {
      const [participant] = await dbRef
        .db!.insert(schema.examParticipants)
        .values({ normalizedName: "佐藤", displayName: "佐藤" })
        .returning({ id: schema.examParticipants.id });
      const createdAt = new Date("2026-02-01T00:00:00.000Z");
      const updatedAt = new Date("2026-02-02T00:00:00.000Z");

      await dbRef.db!.insert(schema.examAnswerSubmissions).values([
        {
          id: "a-submission",
          participantId: participant!.id,
          questionIds: [],
          revision: 3,
          createdAt,
          updatedAt,
        },
        {
          id: "z-submission",
          participantId: participant!.id,
          questionIds: [],
          revision: 3,
          createdAt,
          updatedAt,
        },
      ]);

      await expect(getLatestAnswerSubmission(participant!.id)).resolves.toMatchObject({
        submissionId: "z-submission",
        revision: 3,
        answers: [],
      });
    });

    it("returns an empty answer list when the saved submission has no answer rows", async () => {
      const questionId = await insertQuestion();
      const participantId = await insertParticipant();
      await insertSubmission({ id: "empty-latest", participantId, questionIds: [questionId] });

      await expect(getLatestAnswerSubmission(participantId)).resolves.toMatchObject({
        submissionId: "empty-latest",
        answers: [],
      });
    });

    it("restores free-text answers without a selected choice", async () => {
      const questionId = await insertQuestion();
      const participantId = await insertParticipant();
      await insertSubmission({ id: "free-text-latest", participantId, questionIds: [questionId] });
      await dbRef.db!.insert(schema.examSubmissionAnswers).values({
        submissionId: "free-text-latest",
        questionId,
        selectedIndex: null,
        freeText: "  explanation  ",
        answerKind: "freeText",
      });

      await expect(getLatestAnswerSubmission(participantId)).resolves.toMatchObject({
        submissionId: "free-text-latest",
        answers: [
          { questionId, answerKind: "freeText", selectedIndex: null, freeText: "  explanation  " },
        ],
      });
    });

    it("restores selected answers with a null free-text value", async () => {
      const questionId = await insertQuestion();
      const participantId = await insertParticipant();
      await insertSubmission({ id: "selected-latest", participantId, questionIds: [questionId] });
      await dbRef.db!.insert(schema.examSubmissionAnswers).values({
        submissionId: "selected-latest",
        questionId,
        selectedIndex: 2,
        freeText: null,
        answerKind: "selected",
      });

      await expect(getLatestAnswerSubmission(participantId)).resolves.toMatchObject({
        submissionId: "selected-latest",
        answers: [{ questionId, answerKind: "selected", selectedIndex: 2, freeText: null }],
      });
    });
  });

  describe("getAnswerSubmission", () => {
    it("omits questions with no stored answer and restores free-text answers", async () => {
      const [questionId, missingQuestionId] = await dbRef
        .db!.insert(schema.examQuestions)
        .values([
          {
            id: 1,
            key: "test-1",
            question: "Q1?",
            choices: ["A", "B"],
            correctIndex: 0,
            explanation: null,
          },
          {
            id: 2,
            key: "test-2",
            question: "Q2?",
            choices: ["A", "B"],
            correctIndex: 0,
            explanation: null,
          },
        ])
        .returning({ id: schema.examQuestions.id });
      const participantId = await insertParticipant();
      await insertSubmission({
        id: "restored-submission",
        participantId,
        questionIds: [questionId!.id, missingQuestionId!.id],
      });
      await dbRef.db!.insert(schema.examSubmissionAnswers).values({
        submissionId: "restored-submission",
        questionId: questionId!.id,
        selectedIndex: null,
        freeText: "response",
        answerKind: "freeText",
      });

      await expect(
        getAnswerSubmission("restored-submission", participantId),
      ).resolves.toMatchObject({
        answers: [
          {
            questionId: questionId!.id,
            answerKind: "freeText",
            selectedIndex: null,
            freeText: "response",
          },
        ],
      });
    });

    it("does not restore a submission for another participant", async () => {
      const questionId = await insertQuestion();
      const ownerId = await insertParticipant("owner");
      const otherId = await insertParticipant("other");
      await insertSubmission({
        id: "owned-submission",
        participantId: ownerId,
        questionIds: [questionId],
      });

      await expect(getAnswerSubmission("owned-submission", otherId)).resolves.toBeNull();
    });

    it("restores selected answers with a null free-text value", async () => {
      const questionId = await insertQuestion();
      const participantId = await insertParticipant();
      await insertSubmission({
        id: "selected-submission",
        participantId,
        questionIds: [questionId],
      });
      await dbRef.db!.insert(schema.examSubmissionAnswers).values({
        submissionId: "selected-submission",
        questionId,
        selectedIndex: 1,
        freeText: null,
        answerKind: "selected",
      });

      await expect(
        getAnswerSubmission("selected-submission", participantId),
      ).resolves.toMatchObject({
        submissionId: "selected-submission",
        answers: [{ questionId, answerKind: "selected", selectedIndex: 1, freeText: null }],
      });
    });
  });

  describe("saveAnswerSubmission ownership checks", () => {
    it("rejects a submission owned by another participant", async () => {
      const questionIds = await insertFiveQuestions();
      const ownerId = await insertParticipant("existing-owner");
      const callerId = await insertParticipant("existing-caller");
      await insertSubmission({ id: "existing-owned", participantId: ownerId, questionIds });

      await expect(
        saveAnswerSubmission({
          submissionId: "existing-owned",
          operationId: "new-operation",
          expectedRevision: 1,
          participantId: callerId,
          answers: selectedAnswers(questionIds),
        }),
      ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 404 });
    });

    it("rejects an idempotent operation when its owner row is missing", async () => {
      const questionIds = await insertFiveQuestions();
      const participantId = await insertParticipant("missing-operation-owner");
      await insertSubmission({ id: "orphaned-operation-submission", participantId, questionIds });
      await dbRef.db!.insert(schema.examSubmissionOperations).values({
        operationId: "orphaned-operation",
        submissionId: "orphaned-operation-submission",
        payload: "{}",
        revision: 1,
      });

      // The schema cascades deletes from submissions to operations, so emulate
      // a stale read to cover the defensive missing-owner response.
      const database = dbRef.db!;
      const originalTransaction = database.transaction.bind(database);
      const transactionSpy = vi.spyOn(database, "transaction");
      transactionSpy.mockImplementation((callback, config) =>
        originalTransaction((tx) => {
          const wrappedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "select") return Reflect.get(target, property, receiver);
              return (...args: unknown[]) => {
                const select = Reflect.apply(
                  Reflect.get(target, property, target) as (...args: unknown[]) => object,
                  target,
                  args,
                );
                return new Proxy(select, {
                  get(selectTarget, selectProperty, selectReceiver) {
                    if (selectProperty !== "from")
                      return Reflect.get(selectTarget, selectProperty, selectReceiver);
                    return (table: unknown) => {
                      const query = Reflect.apply(
                        Reflect.get(selectTarget, selectProperty, selectTarget) as (
                          table: unknown,
                        ) => object,
                        selectTarget,
                        [table],
                      );
                      if (table !== schema.examAnswerSubmissions) return query;
                      return new Proxy(query, {
                        get(queryTarget, queryProperty, queryReceiver) {
                          if (queryProperty === "where") return async () => [];
                          return Reflect.get(queryTarget, queryProperty, queryReceiver);
                        },
                      });
                    };
                  },
                });
              };
            },
          });
          return callback(wrappedTx);
        }, config),
      );
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "orphaned-operation-submission",
            operationId: "orphaned-operation",
            expectedRevision: 0,
            participantId,
            answers: selectedAnswers(questionIds),
          }),
        ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 404 });
      } finally {
        transactionSpy.mockRestore();
      }
    });

    it("rejects a new submission when fewer than five exam questions exist", async () => {
      const questionId = await insertQuestion();
      const participantId = await insertParticipant("incomplete-exam");

      await expect(
        saveAnswerSubmission({
          submissionId: "incomplete-exam-submission",
          operationId: "incomplete-exam-operation",
          expectedRevision: 0,
          participantId,
          answers: [questionId, 2, 3, 4, 5].map((id) => ({ questionId: id, selectedIndex: 0 })),
        }),
      ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 400 });
      await expect(testDb.db.select().from(schema.examAnswerSubmissions)).resolves.toHaveLength(0);
      await expect(testDb.db.select().from(schema.examSubmissionOperations)).resolves.toHaveLength(
        0,
      );
    });
  });

  describe("saveAnswerSubmission conflict recovery", () => {
    function failNextTransactionWithBusy() {
      return vi
        .spyOn(dbRef.db!, "transaction")
        .mockRejectedValueOnce(
          Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" }),
        );
    }

    function failRevisionCompareAndSwap(latestExists: boolean) {
      const realTransaction = dbRef.db!.transaction.bind(dbRef.db);
      return vi.spyOn(dbRef.db!, "transaction").mockImplementation(((
        callback: (tx: unknown) => unknown,
      ) =>
        realTransaction(async (tx) => {
          let submissionReads = 0;
          const wrapSelect = (builder: object, table?: unknown, submissionRead?: number): object =>
            new Proxy(builder, {
              get(target, property) {
                const member = Reflect.get(target, property, target) as unknown;
                if (property === "from" && typeof member === "function") {
                  return (fromTable: unknown) => {
                    if (fromTable === schema.examAnswerSubmissions) submissionReads += 1;
                    return wrapSelect(
                      Reflect.apply(member, target, [fromTable]) as object,
                      fromTable,
                      fromTable === schema.examAnswerSubmissions ? submissionReads : undefined,
                    );
                  };
                }
                if (property === "where" && typeof member === "function") {
                  return (...args: unknown[]) => {
                    if (
                      table === schema.examAnswerSubmissions &&
                      submissionRead === 2 &&
                      !latestExists
                    ) {
                      return Promise.resolve([]);
                    }
                    return Reflect.apply(member, target, args);
                  };
                }
                return typeof member === "function" ? member.bind(target) : member;
              },
            });
          const wrappedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === "select") {
                return (...args: unknown[]) =>
                  wrapSelect(
                    Reflect.apply(Reflect.get(target, property, target), target, args) as object,
                  );
              }
              if (property === "update") {
                return (table: unknown) => {
                  if (table === schema.examAnswerSubmissions) {
                    return {
                      set() {
                        return this;
                      },
                      where() {
                        return this;
                      },
                      returning: async () => [],
                    };
                  }
                  return Reflect.apply(Reflect.get(target, property, target), target, [table]);
                };
              }
              return Reflect.get(target, property, receiver);
            },
          });
          return callback(wrappedTx);
        })) as never);
    }

    it("rethrows the adapter conflict when recovery finds no submission", async () => {
      const transaction = failNextTransactionWithBusy();
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "not-created",
            operationId: "missing-operation",
            expectedRevision: 0,
            participantId: 1,
            answers: [],
          }),
        ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      } finally {
        transaction.mockRestore();
      }
    });

    it("reports an owner mismatch when recovering an existing operation", async () => {
      const questionId = await insertQuestion();
      const ownerId = await insertParticipant("operation-owner");
      const otherId = await insertParticipant("operation-caller");
      await insertSubmission({
        id: "operation-submission",
        participantId: ownerId,
        questionIds: [questionId],
      });
      await dbRef.db!.insert(schema.examSubmissionOperations).values({
        operationId: "foreign-operation",
        submissionId: "operation-submission",
        payload: "{}",
        revision: 1,
      });
      const transaction = failNextTransactionWithBusy();
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "operation-submission",
            operationId: "foreign-operation",
            expectedRevision: 0,
            participantId: otherId,
            answers: [],
          }),
        ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 404 });
      } finally {
        transaction.mockRestore();
      }
    });

    it("reports an owner mismatch when recovering a submission without an operation", async () => {
      const questionId = await insertQuestion();
      const ownerId = await insertParticipant("submission-owner");
      const otherId = await insertParticipant("submission-caller");
      await insertSubmission({
        id: "foreign-submission",
        participantId: ownerId,
        questionIds: [questionId],
      });
      const transaction = failNextTransactionWithBusy();
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "foreign-submission",
            operationId: "new-operation",
            expectedRevision: 1,
            participantId: otherId,
            answers: [],
          }),
        ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 404 });
      } finally {
        transaction.mockRestore();
      }
    });

    it("reports a revision conflict when recovery sees a newer submission", async () => {
      const questionId = await insertQuestion();
      const participantId = await insertParticipant("revision-owner");
      await insertSubmission({
        id: "newer-submission",
        participantId,
        questionIds: [questionId],
        revision: 2,
      });
      const transaction = failNextTransactionWithBusy();
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "newer-submission",
            operationId: "stale-operation",
            expectedRevision: 1,
            participantId,
            answers: [],
          }),
        ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 409 });
      } finally {
        transaction.mockRestore();
      }
    });

    it("returns the committed result when recovery finds the same operation", async () => {
      const questionIds = await insertFiveQuestions();
      const participantId = await insertParticipant("committed-operation-owner");
      const input = {
        submissionId: "committed-operation-submission",
        operationId: "committed-operation",
        expectedRevision: 0,
        participantId,
        answers: selectedAnswers(questionIds),
      };
      const committed = await saveAnswerSubmission(input);
      const transaction = failNextTransactionWithBusy();
      try {
        await expect(saveAnswerSubmission(input)).resolves.toEqual({
          ...committed,
          assessmentTarget: null,
        });
      } finally {
        transaction.mockRestore();
      }
    });

    it("rejects a different payload when recovery finds the same operation ID", async () => {
      const questionIds = await insertFiveQuestions();
      const participantId = await insertParticipant("payload-owner");
      const input = {
        submissionId: "payload-submission",
        operationId: "reused-operation",
        expectedRevision: 0,
        participantId,
        answers: selectedAnswers(questionIds),
      };
      await saveAnswerSubmission(input);
      const transaction = failNextTransactionWithBusy();
      try {
        await expect(
          saveAnswerSubmission({
            ...input,
            answers: questionIds.map((questionId, index) => ({
              questionId,
              selectedIndex: index === 0 ? 1 : 0,
            })),
          }),
        ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 409 });
      } finally {
        transaction.mockRestore();
      }
    });

    it("rethrows the conflict when recovery finds the same revision", async () => {
      const questionIds = await insertFiveQuestions();
      const participantId = await insertParticipant("unchanged-revision-owner");
      await insertSubmission({
        id: "unchanged-revision-submission",
        participantId,
        questionIds,
      });
      const conflict = Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
      const transaction = vi.spyOn(dbRef.db!, "transaction").mockRejectedValueOnce(conflict);
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "unchanged-revision-submission",
            operationId: "unchanged-revision-operation",
            expectedRevision: 1,
            participantId,
            answers: selectedAnswers(questionIds),
          }),
        ).rejects.toBe(conflict);
      } finally {
        transaction.mockRestore();
      }
    });

    it("reports a revision conflict when compare-and-swap updates no rows", async () => {
      const questionIds = await insertFiveQuestions();
      const participantId = await insertParticipant("cas-conflict-owner");
      await insertSubmission({ id: "cas-conflict-submission", participantId, questionIds });
      const transaction = failRevisionCompareAndSwap(true);
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "cas-conflict-submission",
            operationId: "cas-conflict-operation",
            expectedRevision: 1,
            participantId,
            answers: selectedAnswers(questionIds),
          }),
        ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 409 });
      } finally {
        transaction.mockRestore();
      }
    });

    it("reports not found when the submission disappears during compare-and-swap", async () => {
      const questionIds = await insertFiveQuestions();
      const participantId = await insertParticipant("cas-missing-owner");
      await insertSubmission({ id: "cas-missing-submission", participantId, questionIds });
      const transaction = failRevisionCompareAndSwap(false);
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "cas-missing-submission",
            operationId: "cas-missing-operation",
            expectedRevision: 1,
            participantId,
            answers: selectedAnswers(questionIds),
          }),
        ).rejects.toMatchObject({ name: "BatchSubmissionError", status: 404 });
      } finally {
        transaction.mockRestore();
      }
    });

    it("recognizes nested busy conflicts after skipping null, primitive, and visited values", async () => {
      const nestedConflict = Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
      const wrapper: { cause?: unknown; originalError?: unknown; error?: unknown } = {};
      wrapper.cause = wrapper;
      wrapper.originalError = "opaque adapter detail";
      wrapper.error = nestedConflict;
      const transaction = vi.spyOn(dbRef.db!, "transaction").mockRejectedValueOnce(wrapper);
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "nested-conflict-no-row",
            operationId: "nested-conflict-operation",
            expectedRevision: 0,
            participantId: 1,
            answers: [],
          }),
        ).rejects.toBe(wrapper);
        expect(transaction).toHaveBeenCalledTimes(2);
      } finally {
        transaction.mockRestore();
      }
    });

    it("recognizes generic SQLite unique-constraint messages", async () => {
      const conflict = Object.assign(new Error("unique constraint failed: table.key"), {
        code: "SQLITE_CONSTRAINT",
      });
      const transaction = vi.spyOn(dbRef.db!, "transaction").mockRejectedValueOnce(conflict);
      try {
        await expect(
          saveAnswerSubmission({
            submissionId: "unique-conflict-no-row",
            operationId: "unique-conflict-operation",
            expectedRevision: 0,
            participantId: 1,
            answers: [],
          }),
        ).rejects.toBe(conflict);
        expect(transaction).toHaveBeenCalledTimes(2);
      } finally {
        transaction.mockRestore();
      }
    });
  });

  describe("getStats", () => {
    it("returns zero stats when no data", async () => {
      const stats = await getStats();
      expect(stats).toEqual({ totalQuestions: 0, todayAnswers: 0, todayAccuracy: 0 });
    });

    it("uses zero fallbacks when aggregate queries return no rows", async () => {
      const select = vi.spyOn(dbRef.db!, "select");
      select
        .mockImplementationOnce((() => ({ from: async () => [] })) as never)
        .mockImplementationOnce((() => ({
          from: () => ({ where: async () => [] }),
        })) as never);

      try {
        await expect(getStats()).resolves.toEqual({
          totalQuestions: 0,
          todayAnswers: 0,
          todayAccuracy: 0,
        });
      } finally {
        select.mockRestore();
      }
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
