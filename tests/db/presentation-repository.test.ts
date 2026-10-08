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
  getAdminPresentationControls,
  getAdminPresentationDeck,
  getParticipantResult,
  getPublicPresentation,
  operatePresentation,
  PresentationConflictError,
  setParticipantResultsVisible,
} from "@/lib/db/repository/presentation-repository";
import { getPresentationOperationDiagnostics } from "@/lib/presentation/operation-diagnostics";

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

async function failFirstTransactionAfterCallback<T>(run: () => Promise<T>) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let intercept = true;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    if (!intercept) return originalTransaction(callback, config);
    intercept = false;
    return originalTransaction(async (tx) => {
      await callback(tx);
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }, config);
  });
  try {
    return await run();
  } finally {
    transactionSpy.mockRestore();
  }
}

async function failFirstTransactionWithUniqueConflict<T>(run: () => Promise<T>) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let intercept = true;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    if (!intercept) return originalTransaction(callback, config);
    intercept = false;
    return originalTransaction(async (tx) => {
      await callback(tx);
      throw Object.assign(new Error("adapter transaction failed"), {
        cause: Object.assign(
          new Error("UNIQUE constraint failed: presentation_operations.operation_id"),
          { code: "SQLITE_CONSTRAINT" },
        ),
      });
    }, config);
  });
  try {
    return await run();
  } finally {
    transactionSpy.mockRestore();
  }
}

async function failTransactionAtTable<T>(
  table: unknown,
  operation: "select" | "delete" | "insert" | "update",
  run: () => Promise<T>,
) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) =>
    originalTransaction((tx) => {
      const wrappedTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== operation) return Reflect.get(target, property, receiver);
          if (operation !== "select") {
            return (selectedTable: unknown) => {
              if (selectedTable === table) {
                throw Object.assign(new Error("private database detail"), {
                  code: "SQLITE_ERROR",
                });
              }
              const method = Reflect.get(target, property, receiver) as (
                selectedTable: unknown,
              ) => unknown;
              return Reflect.apply(method, target, [selectedTable]);
            };
          }
          return (...args: unknown[]) => {
            const method = Reflect.get(target, property, receiver) as (
              ...args: unknown[]
            ) => object;
            const query = Reflect.apply(method, target, args);
            return new Proxy(query, {
              get(queryTarget, queryProperty, queryReceiver) {
                if (queryProperty !== "from")
                  return Reflect.get(queryTarget, queryProperty, queryReceiver);
                return (selectedTable: unknown) => {
                  if (selectedTable === table) {
                    throw Object.assign(new Error("private database detail"), {
                      code: "SQLITE_ERROR",
                    });
                  }
                  const from = Reflect.get(queryTarget, queryProperty, queryTarget) as (
                    selectedTable: unknown,
                  ) => unknown;
                  return Reflect.apply(from, queryTarget, [selectedTable]);
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
    return await run();
  } finally {
    transactionSpy.mockRestore();
  }
}

async function returnNoUpdatedRows<T>(table: unknown, run: () => Promise<T>) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) =>
    originalTransaction((tx) => {
      const wrappedTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "update") return Reflect.get(target, property, receiver);
          return (selectedTable: unknown) => {
            const builder = Reflect.apply(
              Reflect.get(target, property, receiver) as (...args: unknown[]) => unknown,
              target,
              [selectedTable],
            );
            if (selectedTable !== table) return builder;
            const wrapBuilder = (current: object): object =>
              new Proxy(current, {
                get(builderTarget, builderProperty, builderReceiver) {
                  if (builderProperty === "returning") return async () => [];
                  const method = Reflect.get(builderTarget, builderProperty, builderReceiver);
                  if (typeof method !== "function") return method;
                  return (...args: unknown[]) =>
                    wrapBuilder(Reflect.apply(method, builderTarget, args));
                },
              });
            return wrapBuilder(builder as object);
          };
        },
      });
      return callback(wrappedTx);
    }, config),
  );
  try {
    return await run();
  } finally {
    transactionSpy.mockRestore();
  }
}

async function returnNoSelectedRows<T>(table: unknown, run: () => Promise<T>, readNumber = 1) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  const transactionSpy = vi.spyOn(database, "transaction");
  let matchingReads = 0;
  transactionSpy.mockImplementation((callback, config) =>
    originalTransaction((tx) => {
      const wrappedTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "select") return Reflect.get(target, property, receiver);
          return (...args: unknown[]) => {
            const builder = Reflect.apply(
              Reflect.get(target, property, target) as (...args: unknown[]) => object,
              target,
              args,
            );
            return new Proxy(builder, {
              get(builderTarget, builderProperty, builderReceiver) {
                if (builderProperty !== "from")
                  return Reflect.get(builderTarget, builderProperty, builderReceiver);
                return (selectedTable: unknown) => {
                  const matchingRead = selectedTable === table ? ++matchingReads : 0;
                  const query = Reflect.apply(
                    Reflect.get(builderTarget, builderProperty, builderTarget) as (
                      selectedTable: unknown,
                    ) => object,
                    builderTarget,
                    [selectedTable],
                  );
                  if (selectedTable !== table || matchingRead !== readNumber) return query;
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
    return await run();
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

  it("returns compact presenter controls and their defaults without an active row", async () => {
    await expect(getAdminPresentationControls()).resolves.toEqual({
      state: "not_started",
      version: 0,
      questionIndex: 0,
      questionCount: 0,
      projectionHidden: false,
    });

    await addQuestions();
    await op("start", "controls-start");
    await expect(getAdminPresentationControls()).resolves.toMatchObject({
      state: "question",
      version: 1,
      questionIndex: 0,
      questionCount: 2,
      projectionHidden: false,
    });
  });

  async function addFreeTextProjectionFixture(sourceKey?: string) {
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "answer",
      version: 1,
      questionIndex: 0,
      questionCount: 1,
    });
    await testDb.db.insert(schema.presentationQuestions).values({
      sessionId: 1,
      position: 0,
      sourceQuestionId: 105,
      question: "Free-text question",
      choices: [],
      correctIndex: 0,
      explanation: "Model answer",
    });
    if (sourceKey !== undefined) {
      await testDb.db.insert(schema.examQuestions).values({
        id: 105,
        key: sourceKey,
        question: "Current source question",
        choices: [],
        correctIndex: 0,
        explanation: "Current explanation",
      });
    }
    await testDb.db.insert(schema.presentationEntries).values({
      sessionId: 1,
      participantId: 1,
      displayName: "Private Name",
      score: 0.5,
      rank: 1,
      answers: [
        {
          questionId: 105,
          answerKind: "freeText",
          selectedIndex: null,
          freeText: "Private response",
          rawScore: 1,
          normalizedScore: 0.5,
        },
      ],
    });
    await testDb.db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: true,
      everPublished: true,
    });
  }

  async function op(action: "start" | "advance" | "previous" | "hide" | "show", id: string) {
    return operatePresentation(`operation-${id}`, action);
  }

  it("snapshots questions in ID order and freezes every participant score and standard tie rank", async () => {
    const participants = await addRankFixture();

    const started = await op("start", "start");
    expect(started.questions.map(({ id }) => id)).toEqual([11, 22]);
    expect(started.entries).toMatchObject([
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
    expect(restored.entries[0]).toMatchObject({ displayName: "First", score: 2, rank: 1 });
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
        answerType: "selected",
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

  it("preloads every question, answer, podium and completion slide into the presenter deck", async () => {
    await addRankFixture();
    await op("start", "deck-start");

    const deck = await getAdminPresentationDeck();

    expect(deck).toMatchObject({ questionCount: 2, questionIndex: 0 });
    expect(deck.slides.map(({ state, questionIndex }) => [state, questionIndex])).toEqual([
      ["question", 0],
      ["answer", 0],
      ["question", 1],
      ["answer", 1],
      ["podium_preview", 0],
      ["third", 0],
      ["first", 0],
      ["finished", 0],
    ]);
    expect(deck.slides[0]?.projection).toMatchObject({
      state: "question",
      question: { question: "Question 11" },
    });
    expect(deck.slides[0]?.projection).not.toHaveProperty("question.correctAnswer");
    expect(deck.slides[1]?.projection).toMatchObject({
      state: "answer",
      question: { correctAnswer: "Correct 11", explanation: "Explanation 11" },
    });
    expect(deck.slides.find(({ state }) => state === "third")?.projection).toMatchObject({
      state: "third",
      winners: [{ displayName: "Third", rank: 3 }],
    });
  });

  it("always includes answer explanations even when the legacy stored mode is short", async () => {
    await addQuestions();
    await operatePresentation("start-short", "start");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ presentationMode: "short" })
      .where(eq(schema.presentationSessions.id, 1));
    await expect(getAdminPresentation()).resolves.not.toHaveProperty("presentationMode");

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
        explanation: "Explanation 11",
      },
    });
  });

  it("uses the question master explanation when a legacy snapshot explanation is blank", async () => {
    await addQuestions();
    await operatePresentation("start-blank-explanation", "start");
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ explanation: "   " })
      .where(eq(schema.presentationQuestions.sourceQuestionId, 11));
    await testDb.db
      .update(schema.examQuestions)
      .set({ explanation: "Current master explanation" })
      .where(eq(schema.examQuestions.id, 11));

    const question = await getPublicPresentation();
    expect(question).toMatchObject({ state: "question" });
    expect(JSON.stringify(question)).not.toContain("Current master explanation");

    await operatePresentation("answer-blank-explanation", "advance");
    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "answer",
      question: { explanation: "Current master explanation" },
    });
  });

  it("suppresses only the identified fifth-question responses in the public projection", async () => {
    await addFreeTextProjectionFixture("it-literacy-005");

    const projection = await getPublicPresentation();
    expect(projection).toEqual({
      state: "answer",
      question: {
        id: 105,
        ordinal: 1,
        total: 1,
        question: "Free-text question",
        choices: [],
        answerType: "freeText",
        expectedAnswer: "Model answer",
      },
    });
    if (projection.state === "answer" && projection.question?.answerType === "freeText") {
      expect(projection.question).not.toHaveProperty("responses");
    }
    const admin = await getAdminPresentation();
    expect(admin.entries[0]?.answers).toContainEqual(
      expect.objectContaining({ freeText: "Private response", rawScore: 1, normalizedScore: 0.5 }),
    );
    await expect(getParticipantResult(1)).resolves.toEqual({
      state: "visible",
      score: 0.5,
      rank: 1,
      questions: [
        {
          position: 0,
          question: "Free-text question",
          answer: { kind: "freeText", value: "Private response", score: 0.5 },
        },
      ],
    });
  });

  it("keeps responses for another explicitly identified free-text question", async () => {
    await addFreeTextProjectionFixture("another-free-text-question");

    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "answer",
      question: {
        expectedAnswer: "Model answer",
        responses: [
          {
            displayName: "Private Name",
            answer: "Private response",
            answerKind: "freeText",
            similarity: 1,
            score: 0.5,
          },
        ],
      },
    });
  });

  it("keeps responses when the snapshot source question row is missing", async () => {
    await addFreeTextProjectionFixture();

    const projection = await getPublicPresentation();
    expect(projection).toMatchObject({
      state: "answer",
      question: {
        expectedAnswer: "Model answer",
      },
    });
    const question = projection.state === "answer" ? projection.question : undefined;
    if (question && "responses" in question) {
      expect(question.responses).toEqual([
        expect.objectContaining({
          displayName: "Private Name",
          answer: "Private response",
          answerKind: "freeText",
          score: 0.5,
        }),
      ]);
    }
  });

  it("uses the unanswered response fallback when a snapshot answer is absent", async () => {
    await addFreeTextProjectionFixture("another-free-text-question");
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: [] })
      .where(eq(schema.presentationEntries.participantId, 1));

    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "answer",
      question: {
        responses: [
          expect.objectContaining({ displayName: "Private Name", answerKind: "unanswered" }),
        ],
      },
    });
  });

  it("excludes incomplete submissions from scoring and snapshots them as unanswered", async () => {
    await addQuestions();
    const partialQuestionsParticipant = await addParticipant("Partial question set");
    const partialAnswersParticipant = await addParticipant("Partial answers");
    await testDb.db.insert(schema.examAnswerSubmissions).values([
      {
        id: "partial-question-set",
        participantId: partialQuestionsParticipant,
        questionIds: [11],
        revision: 1,
      },
      {
        id: "partial-answer-set",
        participantId: partialAnswersParticipant,
        questionIds: [11, 22],
        revision: 1,
      },
    ]);
    await testDb.db.insert(schema.examSubmissionAnswers).values([
      {
        submissionId: "partial-question-set",
        questionId: 11,
        selectedIndex: 0,
      },
      {
        submissionId: "partial-answer-set",
        questionId: 11,
        selectedIndex: 0,
      },
    ]);

    await operatePresentation("partial-submissions-start", "start");

    const entries = await testDb.db.select().from(schema.presentationEntries);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: partialQuestionsParticipant,
          score: 0,
          answers: [
            expect.objectContaining({ questionId: 11, answerKind: "unanswered" }),
            expect.objectContaining({ questionId: 22, answerKind: "unanswered" }),
          ],
        }),
        expect.objectContaining({
          participantId: partialAnswersParticipant,
          score: 0,
          answers: [
            expect.objectContaining({ questionId: 11, answerKind: "unanswered" }),
            expect.objectContaining({ questionId: 22, answerKind: "unanswered" }),
          ],
        }),
      ]),
    );
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

  it("rebuilds the shared snapshot on republish while start and repeated publication reuse it", async () => {
    await addQuestions();
    const participant = await addParticipant("Participant");
    await addSubmission(participant, [0, 0]);
    await setParticipantResultsVisible(true);
    const published = await getAdminPresentation();
    expect(published).toMatchObject({
      state: "not_started",
      version: 0,
      questionIndex: 0,
      questionCount: 2,
      projectionHidden: false,
      participantResultsVisible: true,
      participantResultsReady: true,
    });
    expect(published.questions).toHaveLength(2);
    expect(published.entries).toMatchObject([{ displayName: "Participant", score: 2, rank: 1 }]);

    await testDb.db
      .update(schema.examQuestions)
      .set({ question: "Edited after publication" })
      .where(eq(schema.examQuestions.id, 11));
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ selectedIndex: 1 })
      .where(eq(schema.examSubmissionAnswers.submissionId, `submission-${participant}-latest`));
    await setParticipantResultsVisible(true);
    const repeatedPublish = await getAdminPresentation();
    expect(repeatedPublish.questions).toEqual(published.questions);
    expect(repeatedPublish.entries).toEqual(published.entries);
    const started = await operatePresentation("visibility-start", "start");
    expect(started).toMatchObject({
      state: "question",
      version: 1,
      participantResultsVisible: true,
      participantResultsReady: true,
    });
    expect(started.questions).toEqual(published.questions);
    expect(started.entries).toEqual(published.entries);

    await setParticipantResultsVisible(false);
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ selectedIndex: 1 })
      .where(eq(schema.examSubmissionAnswers.questionId, 22));
    const hiddenState = await getAdminPresentation();
    await expect(testDb.db.select().from(schema.participantResultSettings)).resolves.toMatchObject([
      { id: 1, visible: false, everPublished: true },
    ]);
    await setParticipantResultsVisible(true);
    const republished = await getAdminPresentation();
    await expect(testDb.db.select().from(schema.participantResultSettings)).resolves.toMatchObject([
      { id: 1, visible: true, everPublished: true },
    ]);
    expect(republished).toMatchObject({
      state: hiddenState.state,
      version: hiddenState.version,
      questionIndex: hiddenState.questionIndex,
      projectionHidden: hiddenState.projectionHidden,
      participantResultsVisible: true,
    });
    expect(republished.questions[0]).toMatchObject({
      id: 11,
      question: "Edited after publication",
    });
    expect(republished.entries).toMatchObject([{ displayName: "Participant", score: 0, rank: 1 }]);
    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: hiddenState.state,
      question: { id: 11, question: "Edited after publication" },
    });
    const participantResult = await getParticipantResult(participant);
    expect(participantResult).toEqual({
      state: "visible",
      rank: 1,
      score: 0,
      questions: [
        {
          position: 0,
          question: "Edited after publication",
          answer: { kind: "selected", value: "Wrong 11", correctness: "incorrect" },
        },
        {
          position: 1,
          question: "Question 22",
          answer: { kind: "selected", value: "Wrong 22", correctness: "incorrect" },
        },
      ],
    });
  });

  it("keeps the old hidden snapshot when republishing fails during recalculation", async () => {
    await addQuestions();
    const participant = await addParticipant("Participant");
    await addSubmission(participant, [0, 0]);
    await setParticipantResultsVisible(true);
    const original = await getAdminPresentation();
    await setParticipantResultsVisible(false);
    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "it-literacy-005", choices: [] })
      .where(eq(schema.examQuestions.id, 22));
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ answerKind: "freeText", selectedIndex: null, freeText: "pending response" })
      .where(eq(schema.examSubmissionAnswers.questionId, 22));
    await testDb.db.insert(schema.examAnswerAssessments).values({
      submissionId: `submission-${participant}-latest`,
      questionId: 22,
      revision: 1,
      answerText: "pending response",
      state: "pending",
      rubricVersion: "test-rubric",
    });

    await expect(setParticipantResultsVisible(true)).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(getAdminPresentation()).resolves.toMatchObject({
      state: original.state,
      version: original.version,
      participantResultsVisible: false,
      questions: original.questions,
      entries: original.entries,
    });
    await expect(testDb.db.select().from(schema.participantResultSettings)).resolves.toMatchObject([
      { id: 1, visible: false, everPublished: true },
    ]);
  });

  it("retries publication and start in fresh transactions after a lock error", async () => {
    await addQuestions();
    const participant = await addParticipant("Retry participant");
    await addSubmission(participant, [0, 1]);

    await failFirstTransactionAfterCallback(() => setParticipantResultsVisible(true));
    await expect(getAdminPresentation()).resolves.toMatchObject({
      participantResultsVisible: true,
      participantResultsReady: true,
    });

    const started = await failFirstTransactionAfterCallback(() =>
      operatePresentation("retry-after-lock-start", "start"),
    );
    expect(started).toMatchObject({ state: "question", version: 1 });
    await expect(testDb.db.select().from(schema.presentationOperations)).resolves.toHaveLength(1);
  });

  it("retries nested lock errors to the attempt limit and preserves the adapter error", async () => {
    const nestedLock = Object.assign(new Error("adapter transaction failed"), {
      cause: Object.assign(new Error("database is locked"), {
        code: "SQLITE_LOCKED_SHAREDCACHE",
      }),
    });
    const transactionSpy = vi.spyOn(dbRef.db!, "transaction").mockRejectedValue(nestedLock);

    try {
      await expect(operatePresentation("nested-lock-exhaustion", "hide")).rejects.toBe(nestedLock);
      expect(transactionSpy).toHaveBeenCalledTimes(4);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("attributes publication failures to the source read and snapshot write phases", async () => {
    await addQuestions();
    const sourceReadFailure = await failTransactionAtTable(schema.examQuestions, "select", () =>
      setParticipantResultsVisible(true),
    ).catch((error: unknown) => error);
    expect(getPresentationOperationDiagnostics(sourceReadFailure)).toEqual({
      phase: "source_questions_read",
      errorKind: "database",
      databaseCode: "SQLITE_ERROR",
      clientErrorClass: null,
      clientCode: null,
    });

    await setParticipantResultsVisible(true);
    await setParticipantResultsVisible(false);
    const snapshotWriteFailure = await failTransactionAtTable(
      schema.presentationEntries,
      "delete",
      () => setParticipantResultsVisible(true),
    ).catch((error: unknown) => error);
    expect(getPresentationOperationDiagnostics(snapshotWriteFailure)).toEqual({
      phase: "delete_entries",
      errorKind: "database",
      databaseCode: "SQLITE_ERROR",
      clientErrorClass: null,
      clientCode: null,
    });
  });

  it("resets the diagnostic phase before every retry attempt", async () => {
    const database = dbRef.db!;
    const originalTransaction = database.transaction.bind(database);
    let attempts = 0;
    const transactionSpy = vi.spyOn(database, "transaction");
    transactionSpy.mockImplementation((callback, config) => {
      attempts += 1;
      if (attempts === 1) {
        return originalTransaction(async (tx) => {
          await callback(tx);
          throw Object.assign(new Error("retry this transaction"), { code: "SQLITE_BUSY" });
        }, config);
      }
      return Promise.reject(
        Object.assign(new Error("private database detail"), {
          code: "SQLITE_ERROR",
        }),
      );
    });
    try {
      const retryFailure = await setParticipantResultsVisible(false).catch(
        (error: unknown) => error,
      );
      expect(getPresentationOperationDiagnostics(retryFailure)).toEqual({
        phase: "transaction_begin",
        errorKind: "database",
        databaseCode: "SQLITE_ERROR",
        clientErrorClass: null,
        clientCode: null,
      });
      expect(attempts).toBe(2);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("rolls back session and visibility when snapshot creation is not ready", async () => {
    await expect(setParticipantResultsVisible(true)).rejects.toMatchObject({
      message: "Results are not ready",
      status: 409,
    });
    await expect(getAdminPresentation()).resolves.toMatchObject({
      state: "not_started",
      participantResultsVisible: false,
      participantResultsReady: false,
    });
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
  });

  it("allows an empty presentation start and publishes its empty snapshot without rebuilding it", async () => {
    await expect(setParticipantResultsVisible(true)).rejects.toMatchObject({
      message: "Results are not ready",
      status: 409,
    });

    const started = await operatePresentation("empty-start", "start");
    expect(started).toMatchObject({
      state: "podium_preview",
      version: 1,
      questionCount: 0,
      participantResultsReady: true,
    });
    expect(started.questions).toEqual([]);
    expect(started.entries).toEqual([]);
    await expect(getAdminPresentationDeck()).resolves.toMatchObject({
      questionCount: 0,
      slides: [
        { state: "podium_preview", projection: { state: "podium_preview" } },
        { state: "finished", projection: { state: "finished" } },
      ],
    });

    await addQuestions();
    await testDb.db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: false,
      everPublished: false,
    });
    await setParticipantResultsVisible(true);
    await expect(getAdminPresentation()).resolves.toMatchObject({
      state: "podium_preview",
      version: 1,
      questionCount: 0,
      participantResultsVisible: true,
      participantResultsReady: true,
      questions: [],
      entries: [],
    });
  });

  it("does not repair a malformed presentation snapshot on first publication", async () => {
    await addQuestions();
    const participant = await addParticipant("Malformed result");
    await addSubmission(participant, [0, 0]);
    await operatePresentation("malformed-first-publish-start", "start");
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: [] })
      .where(eq(schema.presentationEntries.participantId, participant));

    await setParticipantResultsVisible(true);

    await expect(getParticipantResult(participant)).resolves.toEqual({ state: "unavailable" });
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toMatchObject([
      { participantId: participant, answers: [] },
    ]);
  });

  it("keeps the presenter on a valid stage and cursor when republish removes questions", async () => {
    await addQuestions();
    const participant = await addParticipant("Cursor participant");
    await addSubmission(participant, [0, 0]);
    await setParticipantResultsVisible(true);
    await operatePresentation("cursor-start", "start");
    await operatePresentation("cursor-answer-1", "advance");
    await operatePresentation("cursor-question-2", "advance");
    await operatePresentation("cursor-answer-2", "advance");

    await setParticipantResultsVisible(false);
    await testDb.db.delete(schema.examQuestions).where(eq(schema.examQuestions.id, 22));
    await setParticipantResultsVisible(true);
    const oneQuestion = await getAdminPresentation();
    expect(oneQuestion).toMatchObject({
      state: "answer",
      questionIndex: 0,
      questionCount: 1,
      version: 4,
    });

    await setParticipantResultsVisible(false);
    await testDb.db.delete(schema.examQuestions).where(eq(schema.examQuestions.id, 11));
    await setParticipantResultsVisible(true);
    const noQuestions = await getAdminPresentation();
    expect(noQuestions).toMatchObject({
      state: "podium_preview",
      questionIndex: 0,
      questionCount: 0,
      version: 4,
    });
  });

  it("rolls back a partial snapshot when a free response is still ungraded", async () => {
    await addQuestions();
    const participant = await addParticipant("Waiting assessment");
    await addSubmission(participant, [0, 0]);
    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "it-literacy-005", choices: [] })
      .where(eq(schema.examQuestions.id, 22));
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ answerKind: "freeText", selectedIndex: null, freeText: "pending response" })
      .where(eq(schema.examSubmissionAnswers.questionId, 22));
    await testDb.db.insert(schema.examAnswerAssessments).values({
      submissionId: `submission-${participant}-latest`,
      questionId: 22,
      revision: 1,
      answerText: "pending response",
      state: "pending",
      rubricVersion: "test-rubric",
    });

    await expect(setParticipantResultsVisible(true)).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
    await expect(getAdminPresentation()).resolves.toMatchObject({
      participantResultsVisible: false,
      participantResultsReady: false,
    });
  });

  it("returns the cookie owner's answers and correctness and fails closed on malformed snapshots", async () => {
    await addQuestions();
    const first = await addParticipant("First");
    const second = await addParticipant("Second");
    await addSubmission(first, [0, 0]);
    await addSubmission(second, [0, 1]);
    await operatePresentation("results-start", "start");
    const lateParticipant = await addParticipant("Late participant");
    await setParticipantResultsVisible(true);
    await expect(getParticipantResult(lateParticipant)).resolves.toEqual({ state: "unavailable" });

    await testDb.db
      .update(schema.examQuestions)
      .set({ question: "Changed after presentation" })
      .where(eq(schema.examQuestions.id, 11));
    await expect(getParticipantResult(first)).resolves.toEqual({
      state: "visible",
      rank: 1,
      score: 2,
      questions: [
        {
          position: 0,
          question: "Question 11",
          answer: { kind: "selected", value: "Correct 11", correctness: "correct" },
        },
        {
          position: 1,
          question: "Question 22",
          answer: { kind: "selected", value: "Correct 22", correctness: "correct" },
        },
      ],
    });
    await expect(getParticipantResult(second)).resolves.toEqual({
      state: "visible",
      rank: 2,
      score: 1,
      questions: [
        {
          position: 0,
          question: "Question 11",
          answer: { kind: "selected", value: "Correct 11", correctness: "correct" },
        },
        {
          position: 1,
          question: "Question 22",
          answer: { kind: "selected", value: "Wrong 22", correctness: "incorrect" },
        },
      ],
    });
    const [firstEntry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, first));
    const invalidIndexSnapshot = firstEntry!.answers.map((answer) =>
      answer.questionId === 11 ? { ...answer, selectedIndex: -1 } : answer,
    );
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: invalidIndexSnapshot })
      .where(eq(schema.presentationEntries.participantId, first));
    await expect(getParticipantResult(first)).resolves.toMatchObject({
      state: "visible",
      questions: [
        {
          position: 0,
          answer: { kind: "selected", value: "", correctness: "unavailable" },
        },
        {
          position: 1,
          answer: { kind: "selected", value: "Correct 22", correctness: "correct" },
        },
      ],
    });
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ correctIndex: 99 })
      .where(eq(schema.presentationQuestions.position, 0));
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: firstEntry!.answers })
      .where(eq(schema.presentationEntries.participantId, first));
    await expect(getParticipantResult(first)).resolves.toMatchObject({
      state: "visible",
      questions: [
        {
          position: 0,
          answer: { kind: "selected", value: "", correctness: "unavailable" },
        },
        {
          position: 1,
          answer: { kind: "selected", value: "Correct 22", correctness: "correct" },
        },
      ],
    });
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ correctIndex: 0 })
      .where(eq(schema.presentationQuestions.position, 0));
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ choices: [] })
      .where(eq(schema.presentationQuestions.position, 1));
    const legacyAndUnansweredSnapshot = firstEntry!.answers.map((answer) =>
      answer.questionId === 11
        ? { ...answer, answerKind: "unanswered" as const, selectedIndex: null }
        : {
            ...answer,
            answerKind: "legacy" as const,
            selectedIndex: 1,
            freeText: null,
            rawScore: null,
            normalizedScore: null,
          },
    );
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: legacyAndUnansweredSnapshot })
      .where(eq(schema.presentationEntries.participantId, first));
    await expect(getParticipantResult(first)).resolves.toEqual({
      state: "visible",
      rank: 1,
      score: 2,
      questions: [
        { position: 0, question: "Question 11", answer: { kind: "unanswered" } },
        { position: 1, question: "Question 22", answer: { kind: "legacy" } },
      ],
    });
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ choices: ["Correct 22", "Wrong 22"] })
      .where(eq(schema.presentationQuestions.position, 1));
    const legacyOnChoiceQuestion = firstEntry!.answers.map((answer) =>
      answer.questionId === 11
        ? { ...answer, answerKind: "legacy" as const, selectedIndex: 0 }
        : answer,
    );
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: legacyOnChoiceQuestion })
      .where(eq(schema.presentationEntries.participantId, first));
    await expect(getParticipantResult(first)).resolves.toEqual({ state: "unavailable" });
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: legacyAndUnansweredSnapshot.slice(1) })
      .where(eq(schema.presentationEntries.participantId, first));
    await expect(getParticipantResult(first)).resolves.toEqual({ state: "unavailable" });
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: [legacyAndUnansweredSnapshot[0]!, legacyAndUnansweredSnapshot[0]!] })
      .where(eq(schema.presentationEntries.participantId, first));
    await expect(getParticipantResult(first)).resolves.toEqual({ state: "unavailable" });
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ position: 3 })
      .where(eq(schema.presentationQuestions.position, 1));
    await expect(getParticipantResult(first)).resolves.toEqual({ state: "unavailable" });
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ position: 1 })
      .where(eq(schema.presentationQuestions.position, 3));
    const [secondEntry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, second));
    const freeTextSnapshot = secondEntry!.answers.map((answer) =>
      answer.questionId === 22
        ? {
            ...answer,
            answerKind: "freeText" as const,
            selectedIndex: null,
            freeText: "saved free response",
            rawScore: 987,
            normalizedScore: 0.75,
          }
        : answer,
    );
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: freeTextSnapshot })
      .where(eq(schema.presentationEntries.participantId, second));
    await expect(getParticipantResult(second)).resolves.toEqual({ state: "unavailable" });
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ choices: [] })
      .where(eq(schema.presentationQuestions.position, 1));
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: freeTextSnapshot })
      .where(eq(schema.presentationEntries.participantId, second));
    const freeTextResult = await getParticipantResult(second);
    expect(freeTextResult).toEqual({
      state: "visible",
      rank: 2,
      score: 1,
      questions: [
        {
          position: 0,
          question: "Question 11",
          answer: { kind: "selected", value: "Correct 11", correctness: "correct" },
        },
        {
          position: 1,
          question: "Question 22",
          answer: { kind: "freeText", value: "saved free response", score: 0.75 },
        },
      ],
    });
    expect(JSON.stringify(freeTextResult)).not.toContain("rawScore");
    expect(JSON.stringify(freeTextResult)).not.toContain("987");
    await testDb.db
      .update(schema.presentationEntries)
      .set({ score: 3 })
      .where(eq(schema.presentationEntries.participantId, second));
    await expect(getParticipantResult(second)).resolves.toEqual({ state: "unavailable" });
    await testDb.db
      .update(schema.presentationEntries)
      .set({ score: -0.1 })
      .where(eq(schema.presentationEntries.participantId, second));
    await expect(getParticipantResult(second)).resolves.toEqual({ state: "unavailable" });
    await testDb.db
      .update(schema.presentationEntries)
      .set({ score: 1 })
      .where(eq(schema.presentationEntries.participantId, second));
    const outOfRangeScoreSnapshot = freeTextSnapshot.map((answer) =>
      answer.questionId === 22 ? { ...answer, normalizedScore: 1.2 } : answer,
    );
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: outOfRangeScoreSnapshot })
      .where(eq(schema.presentationEntries.participantId, second));
    await expect(getParticipantResult(second)).resolves.toEqual({ state: "unavailable" });
    const malformedSnapshot = freeTextSnapshot.map((answer) =>
      answer.questionId === 22 ? { ...answer, answerKind: "unrecognized" } : answer,
    ) as unknown as typeof freeTextSnapshot;
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: malformedSnapshot })
      .where(eq(schema.presentationEntries.participantId, second));
    await expect(getParticipantResult(second)).resolves.toEqual({ state: "unavailable" });
  });

  it("recovers an operation retry after an adapter conflict without advancing twice", async () => {
    await addQuestions();
    await op("start", "start");

    const recovered = await commitWinnerThenRaiseAdapterUniqueConflict("adapter-retry");

    expect(recovered).toMatchObject({ state: "answer", questionIndex: 0, version: 2 });
    expect(await testDb.db.select().from(schema.presentationOperations)).toHaveLength(2);
  });

  it("returns waiting before publication and unavailable for malformed result question data", async () => {
    await expect(getParticipantResult(1)).resolves.toEqual({ state: "waiting" });
    await addFreeTextProjectionFixture("another-free-text-question");

    await testDb.db
      .update(schema.presentationQuestions)
      .set({ choices: "not-an-array" as never })
      .where(eq(schema.presentationQuestions.position, 0));

    await expect(getParticipantResult(1)).resolves.toEqual({ state: "unavailable" });
  });

  it("rejects selected answers for a free-text question and free-text snapshots without text", async () => {
    await addFreeTextProjectionFixture("another-free-text-question");
    const [entry] = await testDb.db.select().from(schema.presentationEntries);
    const [snapshot] = entry!.answers;

    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: [{ ...snapshot!, answerKind: "selected", selectedIndex: 0 }],
      })
      .where(eq(schema.presentationEntries.participantId, 1));
    await expect(getParticipantResult(1)).resolves.toEqual({ state: "unavailable" });

    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: [{ ...snapshot!, freeText: null }],
      })
      .where(eq(schema.presentationEntries.participantId, 1));
    await expect(getParticipantResult(1)).resolves.toEqual({ state: "unavailable" });
  });

  it("returns a question stage without a question row when a stale cursor is read", async () => {
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "question",
      version: 1,
      questionIndex: 0,
      questionCount: 1,
    });

    await expect(getPublicPresentation()).resolves.toEqual({ state: "question" });
  });

  it("skips older submissions for an already-ranked participant", async () => {
    await addQuestions();
    const participant = await addParticipant("Multiple submissions");
    await addSubmission(participant, [0, 0], 1, "older");
    await addSubmission(participant, [0, 1], 2, "newer");

    await operatePresentation("multiple-submissions-start", "start");

    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toMatchObject([
      { participantId: participant, score: 1, rank: 1 },
    ]);
  });

  it("rejects deprecated mode actions and advancing with invalid state", async () => {
    await expect(operatePresentation("invalid-mode", "setMode" as never)).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(operatePresentation("advance-before-start", "advance")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
  });

  it("reports an unavailable session when the session read returns no row", async () => {
    await expect(
      returnNoSelectedRows(schema.presentationSessions, () =>
        operatePresentation("session-read-missing", "hide"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
  });

  it("reports an unavailable session when snapshot persistence cannot reread it", async () => {
    await addQuestions();

    await expect(
      returnNoSelectedRows(
        schema.presentationSessions,
        () => setParticipantResultsVisible(true),
        2,
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.participantResultSettings)).resolves.toHaveLength(
      0,
    );
  });

  it("rejects a second start with a different operation ID", async () => {
    await addQuestions();
    await operatePresentation("started-once", "start");

    await expect(operatePresentation("started-twice", "start")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
  });

  it("moves backward through answer and podium preview cursor states", async () => {
    await addQuestions();
    await operatePresentation("previous-states-start", "start");
    await operatePresentation("previous-states-to-answer", "advance");
    await operatePresentation("previous-states-question-two", "advance");
    await operatePresentation("previous-states-answer-two", "advance");
    await operatePresentation("previous-states-preview", "advance");
    await expect(
      operatePresentation("previous-states-preview-back", "previous"),
    ).resolves.toMatchObject({ state: "answer", questionIndex: 1 });
    await expect(
      operatePresentation("previous-states-answer-back", "previous"),
    ).resolves.toMatchObject({ state: "question", questionIndex: 1 });
    await expect(
      operatePresentation("previous-states-question-back", "previous"),
    ).resolves.toMatchObject({ state: "answer", questionIndex: 0 });
  });

  it("returns to the podium preview when the third-place stage is reversed", async () => {
    await addRankFixture();
    await operatePresentation("third-place-start", "start");
    await operatePresentation("third-place-answer-1", "advance");
    await operatePresentation("third-place-question-2", "advance");
    await operatePresentation("third-place-answer-2", "advance");
    await operatePresentation("third-place-preview", "advance");
    await expect(operatePresentation("third-place-stage", "advance")).resolves.toMatchObject({
      state: "third",
    });

    await expect(operatePresentation("third-place-back", "previous")).resolves.toMatchObject({
      state: "podium_preview",
    });
  });

  it("returns from an empty finished presentation to its preview", async () => {
    await operatePresentation("empty-finished-start", "start");
    await expect(operatePresentation("empty-finished-end", "advance")).resolves.toMatchObject({
      state: "finished",
    });

    await expect(operatePresentation("advance-finished", "advance")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(operatePresentation("empty-finished-back", "previous")).resolves.toMatchObject({
      state: "podium_preview",
    });
  });

  it("rejects a start when its compare-and-swap update returns no rows", async () => {
    await addQuestions();

    await expect(
      returnNoUpdatedRows(schema.presentationSessions, () =>
        operatePresentation("start-cas-miss", "start"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(0);
  });

  it("rejects a projection toggle when its compare-and-swap update returns no rows", async () => {
    await operatePresentation("visibility-cas-initial", "hide");

    await expect(
      returnNoUpdatedRows(schema.presentationSessions, () =>
        operatePresentation("visibility-cas-miss", "show"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { projectionHidden: true, version: 1 },
    ]);
  });

  it("rejects a cursor action when its compare-and-swap update returns no rows", async () => {
    await addQuestions();
    await operatePresentation("advance-cas-start", "start");

    await expect(
      returnNoUpdatedRows(schema.presentationSessions, () =>
        operatePresentation("advance-cas-miss", "advance"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { state: "question", version: 1, questionIndex: 0 },
    ]);
  });

  it("reports a state conflict when a known adapter conflict has no committed operation", async () => {
    await addQuestions();
    await operatePresentation("unique-conflict-start", "start");

    await expect(
      failFirstTransactionWithUniqueConflict(() =>
        operatePresentation("unique-conflict-no-winner", "advance"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
  });

  it("reports an operation ID conflict when race recovery finds a different action", async () => {
    await addQuestions();
    await operatePresentation("reused-operation-id", "start");

    const error = await returnNoSelectedRows(schema.presentationOperations, () =>
      operatePresentation("reused-operation-id", "advance"),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PresentationConflictError);
    expect(error).toHaveProperty("message", "Operation ID conflict");
    expect(error).toHaveProperty("status", 409);
  });
});
