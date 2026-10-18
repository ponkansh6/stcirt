import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
  operatePresentationControls,
  setPresentationPosition,
  PresentationConflictError,
  setParticipantResultsVisible,
} from "@/lib/db/repository/presentation-repository";
import { saveAnswerSubmission } from "@/lib/db/repository/answer-repository";
import {
  getPresentationOperationDiagnostics,
  PresentationOperationError,
} from "@/lib/presentation/operation-diagnostics";

type PresentationOperationRecoveryResult =
  | Awaited<ReturnType<typeof operatePresentation>>
  | Awaited<ReturnType<typeof operatePresentationControls>>;

function commitWinnerThenRaiseAdapterUniqueConflict(
  operationId: string,
): Promise<Awaited<ReturnType<typeof operatePresentation>>>;
function commitWinnerThenRaiseAdapterUniqueConflict<T extends PresentationOperationRecoveryResult>(
  operationId: string,
  run: () => Promise<T>,
  action?: "advance" | "aggregate",
): Promise<T>;
async function commitWinnerThenRaiseAdapterUniqueConflict(
  operationId: string,
  run?: () => Promise<PresentationOperationRecoveryResult>,
  action: "advance" | "aggregate" = "advance",
): Promise<PresentationOperationRecoveryResult> {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  let intercept = true;
  const transactionSpy = vi.spyOn(database, "transaction");
  transactionSpy.mockImplementation((callback, config) => {
    if (!intercept) return originalTransaction(callback, config);
    intercept = false;
    return (async () => {
      await operatePresentation(operationId, action);
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
    return await (run ?? (() => operatePresentation(operationId, action)))();
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function raceWithFirstCommitHeld<T, U>(
  holdWriteTable: unknown,
  first: () => Promise<T>,
  second: () => Promise<U>,
) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  const transactionSpy = vi.spyOn(database, "transaction");
  const held = deferred();
  const release = deferred();
  const contenderAtSerializationPoint = deferred();
  const contenderMayEnterTransaction = deferred();
  let heldOnce = false;
  let contenderStarted = false;
  transactionSpy.mockImplementation(async (callback, config) => {
    if (contenderStarted) {
      // Let the test release and await the first commit before the contender
      // starts its BEGIN IMMEDIATE transaction. SQLite may otherwise report
      // SQLITE_BUSY before the contender callback can reach the shared row.
      contenderAtSerializationPoint.resolve();
      await contenderMayEnterTransaction.promise;
    }
    const transaction = originalTransaction(async (tx) => {
      let touchedHoldTable = false;
      const wrappedTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "insert" && property !== "update") {
            return Reflect.get(target, property, receiver);
          }
          return (table: unknown) => {
            if (table === holdWriteTable) touchedHoldTable = true;
            const method = Reflect.get(target, property, target) as (table: unknown) => unknown;
            return Reflect.apply(method, target, [table]);
          };
        },
      });
      const result = await callback(wrappedTx);
      if (!heldOnce && touchedHoldTable) {
        heldOnce = true;
        held.resolve();
        await release.promise;
      }
      return result;
    }, config);
    return transaction;
  });
  try {
    const firstResult = first().then(
      (result) => {
        if (!heldOnce) held.resolve();
        return result;
      },
      (error: unknown) => {
        held.resolve();
        throw error;
      },
    );
    await held.promise;
    if (!heldOnce) {
      await firstResult;
      throw new Error("Expected the first operation to write the barrier table");
    }
    contenderStarted = true;
    const secondResult = second();
    void secondResult.then(
      () => contenderAtSerializationPoint.resolve(),
      () => contenderAtSerializationPoint.resolve(),
    );
    await contenderAtSerializationPoint.promise;
    release.resolve();
    await firstResult.then(
      () => undefined,
      () => undefined,
    );
    contenderMayEnterTransaction.resolve();
    return await Promise.allSettled([firstResult, secondResult]);
  } finally {
    release.resolve();
    contenderMayEnterTransaction.resolve();
    transactionSpy.mockRestore();
  }
}

async function completeConcurrentQ5Assessment(submissionId: string, revision: number) {
  await dbRef
    .db!.update(schema.examAnswerAssessments)
    .set({
      revision,
      answerText: "Q5 answer",
      questionVersion: "tamami-egg-v1",
      state: "graded",
      rawScore: 9,
      normalizedScore: 1,
      rubricVersion: "jev-q5-fulfillment-v3-02",
      gradedAt: new Date(),
    })
    .where(
      and(
        eq(schema.examAnswerAssessments.submissionId, submissionId),
        eq(schema.examAnswerAssessments.questionId, 5),
      ),
    );
}

async function countTableSelectCalls<T>(run: () => Promise<T>) {
  const database = dbRef.db!;
  const originalTransaction = database.transaction.bind(database);
  const transactionSpy = vi.spyOn(database, "transaction");
  const selectCalls = new Map<unknown, number>();
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
                return (table: unknown) => {
                  selectCalls.set(table, (selectCalls.get(table) ?? 0) + 1);
                  return Reflect.apply(
                    Reflect.get(builderTarget, builderProperty, builderTarget) as (
                      table: unknown,
                    ) => unknown,
                    builderTarget,
                    [table],
                  );
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
    return { value: await run(), selectCalls };
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
        id: 5,
        key: "it-literacy-005",
        questionVersion: "tamami-egg-v1",
        question: "Question 5",
        choices: [],
        correctIndex: 0,
        explanation: "Explanation 5",
      },
      {
        id: 1,
        key: "it-literacy-001",
        questionVersion: "nagano-001-v1",
        question: "Question 1",
        choices: ["Correct 1", "Wrong 1"],
        correctIndex: 0,
        explanation: "Explanation 1",
      },
    ]);
  }

  async function addCurrentFiveQuestions() {
    await testDb.db.insert(schema.examQuestions).values(
      [1, 2, 3, 4, 5].map((id) => ({
        id,
        key: `it-literacy-00${id}`,
        questionVersion: id === 5 ? "tamami-egg-v1" : `nagano-00${id}-v1`,
        question: `Current question ${id}`,
        choices: id === 5 ? [] : [`Correct ${id}`, `Wrong ${id}`],
        correctIndex: 0,
        explanation: `Current explanation ${id}`,
      })),
    );
  }

  async function addQ5OnlyQuestion() {
    await testDb.db.insert(schema.examQuestions).values({
      id: 5,
      key: "it-literacy-005",
      questionVersion: "tamami-egg-v1",
      question: "Question 5",
      choices: [],
      correctIndex: 0,
      explanation: "Explanation 5",
    });
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
    const questions = await testDb.db.select().from(schema.examQuestions);
    const orderedQuestions = [...questions].sort((left, right) => left.id - right.id);
    const q5 = orderedQuestions.find((question) => question.id === 5)!;
    const questionVersions = Object.fromEntries(
      orderedQuestions.map((question) => [String(question.id), question.questionVersion!]),
    );
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id,
      participantId,
      questionIds: orderedQuestions.map(({ id: questionId }) => questionId),
      questionVersions,
      revision,
    });
    await testDb.db.insert(schema.examSubmissionAnswers).values(
      orderedQuestions.map((question) =>
        question.id === 5
          ? {
              submissionId: id,
              questionId: question.id,
              answerKind: "freeText" as const,
              freeText: `Q5 ${suffix}`,
            }
          : {
              submissionId: id,
              questionId: question.id,
              selectedIndex: question.id === 1 ? selectedIndices[0]! : 0,
            },
      ),
    );
    await testDb.db.insert(schema.examAnswerAssessments).values({
      submissionId: id,
      questionId: 5,
      revision,
      answerText: `Q5 ${suffix}`,
      questionVersion: q5.questionVersion!,
      state: "graded",
      rawScore: selectedIndices[1] === 0 ? 9 : 0,
      normalizedScore: selectedIndices[1] === 0 ? 1 : 0,
      rubricVersion: "jev-q5-fulfillment-v3-02",
    });
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
      snapshotRevision: 0,
    });

    await addQuestions();
    await startWithAggregate("controls-start");
    await expect(getAdminPresentationControls()).resolves.toMatchObject({
      state: "question",
      version: 3,
      questionIndex: 0,
      questionCount: 2,
      projectionHidden: false,
      snapshotRevision: 1,
    });
  });

  it("builds an empty presentation deck without querying source questions", async () => {
    await expect(getAdminPresentationDeck()).resolves.toMatchObject({
      snapshotRevision: 0,
      questionCount: 0,
      slides: [{ state: "opening" }, { state: "podium_preview" }, { state: "finished" }],
    });
  });

  it("exposes empty-choice Q5 as free text while keeping its answer private", async () => {
    await addQuestions();
    await startWithAggregate("free-text-question-stage");
    await operatePresentation("free-text-answer-one", "advance");
    await operatePresentation("free-text-question-two", "advance");

    const admin = await getAdminPresentation();
    expect(admin.state).toBe("question");
    expect(admin.questions.find(({ id }) => id === 5)).toMatchObject({
      choices: [],
      correctAnswer: "",
      answerType: "freeText",
    });
    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "question",
      question: {
        id: 5,
        choices: [],
        answerType: "freeText",
      },
    });
    await expect(getPublicPresentation()).resolves.not.toHaveProperty("question.correctAnswer");
  });

  it("rejects starting when the snapshot question version map is invalid", async () => {
    await addCurrentFiveQuestions();
    await op("aggregate", "stale-question-version-aggregate");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ questionVersions: { "1": "nagano-001-v1", "5": "omiwatari-v1" } })
      .where(eq(schema.presentationSessions.id, 1));

    await expect(op("start", "stale-question-version-start")).rejects.toMatchObject({
      status: 409,
    });
  });

  it.each([
    ["questionVersions", null],
    ["questionVersions", []],
    ["questionVersions", "invalid"],
    ["rubricVersions", null],
    ["rubricVersions", []],
    ["rubricVersions", "invalid"],
  ] as const)("rejects starting with a non-object %s map (%s)", async (field, value) => {
    await addCurrentFiveQuestions();
    await op("aggregate", `invalid-${field}-map-aggregate`);
    await testDb.db
      .update(schema.presentationSessions)
      .set({ [field]: value } as never)
      .where(eq(schema.presentationSessions.id, 1));

    await expect(op("start", `invalid-${field}-map-start`)).rejects.toMatchObject({
      status: 409,
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["scalar", "invalid"],
  ] as const)("excludes a submission with a %s question-version map", async (_label, value) => {
    await addQuestions();
    const participantId = await addParticipant("Invalid version map");
    await addSubmission(participantId, [0, 0]);
    await testDb.db
      .update(schema.examAnswerSubmissions)
      .set({ questionVersions: value as never })
      .where(eq(schema.examAnswerSubmissions.id, `submission-${participantId}-latest`));

    const result = await op("aggregate", `invalid-submission-version-map-${_label}`);
    expect(result.aggregationSummary).toEqual({
      snapshotUpdated: false,
      includedSubmissionCount: 0,
      excludedSubmissionCount: 1,
      excludedReasonCounts: {
        questionVersionMismatch: 1,
        q5AssessmentVersionMismatch: 0,
      },
    });
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { state: "not_started", version: 0, snapshotRevision: 0, questionCount: 0 },
    ]);
    await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
  });

  it("snapshots a participant without a submission with a zero score", async () => {
    await addQuestions();
    await addParticipant("No submission");

    const aggregated = await op("aggregate", "no-submission-zero-score");

    expect(aggregated.entries).toMatchObject([{ displayName: "No submission", score: 0, rank: 1 }]);
  });

  it("advances an opening presentation with no questions to the podium preview", async () => {
    await addQ5OnlyQuestion();
    await op("aggregate", "empty-opening-aggregate");
    await op("start", "empty-opening-start");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ questionCount: 0 })
      .where(eq(schema.presentationSessions.id, 1));

    await expect(op("advance", "empty-opening-advance")).resolves.toMatchObject({
      state: "podium_preview",
      questionIndex: 0,
    });
  });

  it("moves backward from an empty podium preview to opening", async () => {
    await addQuestions();
    await op("aggregate", "empty-preview-aggregate");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ state: "podium_preview", questionCount: 0 })
      .where(eq(schema.presentationSessions.id, 1));

    const deck = await getAdminPresentationDeck();
    expect(
      deck.slides
        .filter(({ state }) => state === "podium_preview" || state === "finished")
        .map(({ questionIndex }) => questionIndex),
    ).toEqual([0, 0]);
    await expect(
      setPresentationPosition("empty-preview-position", "podium_preview", 0, 1, 1),
    ).resolves.toMatchObject({ state: "podium_preview", questionIndex: 0 });

    await expect(op("previous", "empty-preview-previous")).resolves.toMatchObject({
      state: "opening",
      questionIndex: 0,
    });
  });

  async function addFreeTextProjectionFixture(sourceKey?: string, rawScore = 1) {
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
          rawScore,
          normalizedScore: 0.5,
        },
      ],
    });
    await testDb.db
      .insert(schema.participantResultSettings)
      .values({ id: 1, visible: true, everPublished: true })
      .onConflictDoUpdate({
        target: schema.participantResultSettings.id,
        set: { visible: true, everPublished: true },
      });
  }

  async function op(
    action: "aggregate" | "start" | "advance" | "previous" | "hide" | "show" | "reset",
    id: string,
  ) {
    return operatePresentation(`operation-${id}`, action);
  }

  async function startWithAggregate(id: string) {
    await op("aggregate", `${id}-aggregate`);
    await operatePresentation(`operation-${id}`, "start");
    // Most scenarios below exercise question-or-later behavior; consume the new opening first.
    return operatePresentation(`operation-${id}-opening-next`, "advance");
  }

  it("increments snapshot revisions on aggregate and resets the cursor without reaggregating", async () => {
    await addRankFixture();
    await expect(
      operatePresentation("revision-start-before-aggregate", "start"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(setParticipantResultsVisible(true)).rejects.toMatchObject({ status: 409 });

    const firstAggregate = await op("aggregate", "revision-first-aggregate");
    expect(firstAggregate).toMatchObject({
      state: "not_started",
      version: 1,
      snapshotRevision: 1,
    });
    await expect(
      operatePresentationControls("revision-stale-start", "start", 0),
    ).rejects.toMatchObject({ status: 409 });
    const started = await operatePresentation("revision-start", "start");
    await operatePresentation("revision-advance-one", "advance");
    const reset = await op("reset", "revision-reset");
    expect(reset).toMatchObject({
      state: "opening",
      questionIndex: 0,
      questionCount: 2,
      version: 4,
      snapshotRevision: 1,
    });
    expect(reset.questions).toEqual(started.questions);
    expect(reset.entries).toEqual(started.entries);
    await expect(
      operatePresentationControls("revision-stale-next", "advance", 0),
    ).rejects.toMatchObject({ status: 409 });

    const reaggregate = await op("aggregate", "revision-second-aggregate");
    expect(reaggregate).toMatchObject({
      state: "opening",
      questionIndex: 0,
      version: 5,
      snapshotRevision: 2,
    });
  });

  it("starts and resets at opening, with reversible question and Q5-only boundaries", async () => {
    await addQuestions();
    await op("aggregate", "opening-contract-aggregate");
    await setParticipantResultsVisible(true);
    const started = await operatePresentation("opening-contract-start", "start");
    expect(started).toMatchObject({ state: "opening", questionIndex: 0, snapshotRevision: 1 });
    await expect(getPublicPresentation()).resolves.toEqual({ state: "opening" });
    await operatePresentation("opening-contract-hide", "hide");
    await expect(getPublicPresentation()).resolves.toEqual({ state: "standby" });
    const reset = await op("reset", "opening-contract-reset");
    expect(reset).toMatchObject({
      state: "opening",
      questionIndex: 0,
      version: started.version + 2,
      snapshotRevision: 1,
      projectionHidden: true,
      participantResultsVisible: true,
    });
    expect(reset.questions).toEqual(started.questions);
    expect(reset.entries).toEqual(started.entries);
    await expect(op("previous", "opening-contract-previous")).rejects.toMatchObject({
      status: 409,
    });
    await expect(op("advance", "opening-contract-next")).resolves.toMatchObject({
      state: "question",
      questionIndex: 0,
    });
    await expect(op("previous", "opening-contract-question-back")).resolves.toMatchObject({
      state: "opening",
      questionIndex: 0,
    });

    await testDb.db.delete(schema.examQuestions);
    await addQ5OnlyQuestion();
    await op("aggregate", "opening-contract-q5-only-aggregate");
    await expect(op("reset", "opening-contract-q5-only-reset")).resolves.toMatchObject({
      state: "opening",
      questionIndex: 0,
      questionCount: 1,
    });
    await expect(op("advance", "opening-contract-q5-next")).resolves.toMatchObject({
      state: "question",
      questionIndex: 0,
    });
    await expect(op("previous", "opening-contract-q5-back")).resolves.toMatchObject({
      state: "opening",
      questionIndex: 0,
    });
  });

  it("resets an out-of-range answer cursor to the initial question slide after aggregate", async () => {
    await addQuestions();
    await op("aggregate", "invalid-answer-cursor-initial-aggregate");
    await operatePresentation("invalid-answer-cursor-start", "start");
    await operatePresentation("invalid-answer-cursor-advance", "advance");
    await operatePresentation("invalid-answer-cursor-answer", "advance");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ questionIndex: 2 })
      .where(eq(schema.presentationSessions.id, 1));

    const aggregated = await op("aggregate", "invalid-answer-cursor-reaggregate");

    expect(aggregated).toMatchObject({
      state: "question",
      questionIndex: 0,
      questionCount: 2,
      version: 5,
      snapshotRevision: 2,
    });
  });

  it("resets a hidden finished presentation to its first slide without changing snapshot flags", async () => {
    await addQuestions();
    await op("aggregate", "finished-reset-aggregate");
    await setParticipantResultsVisible(true);
    await operatePresentation("finished-reset-start", "start");
    for (let index = 0; index < 6; index += 1) {
      await operatePresentation(`finished-reset-advance-${index}`, "advance");
    }
    await operatePresentation("finished-reset-hide", "hide");
    const beforeReset = await getAdminPresentation();
    expect(beforeReset).toMatchObject({
      state: "finished",
      questionIndex: 1,
      version: 9,
      snapshotRevision: 1,
      projectionHidden: true,
      participantResultsVisible: true,
    });

    const reset = await op("reset", "finished-hidden-reset");

    expect(reset).toMatchObject({
      state: "opening",
      questionIndex: 0,
      questionCount: 2,
      version: beforeReset.version + 1,
      snapshotRevision: beforeReset.snapshotRevision,
      projectionHidden: beforeReset.projectionHidden,
      participantResultsVisible: beforeReset.participantResultsVisible,
    });
    expect(reset.questions).toEqual(beforeReset.questions);
    expect(reset.entries).toEqual(beforeReset.entries);
  });

  it("rejects reset before the presentation has started", async () => {
    await addQ5OnlyQuestion();
    await op("aggregate", "reset-before-start-aggregate");

    await expect(op("reset", "reset-before-start")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(getAdminPresentation()).resolves.toMatchObject({
      state: "not_started",
      version: 1,
    });
  });

  it("snapshots questions in ID order and freezes every participant score and standard tie rank", async () => {
    const participants = await addRankFixture();

    const started = await startWithAggregate("start");
    expect(started.questions.map(({ id }) => id)).toEqual([1, 5]);
    expect(started.entries).toMatchObject([
      { displayName: "First", score: 2, rank: 1 },
      { displayName: "Tied", score: 2, rank: 1 },
      { displayName: "Third", score: 1, rank: 3 },
      { displayName: "Unanswered", score: 0, rank: 4 },
    ]);

    await testDb.db
      .update(schema.examQuestions)
      .set({ question: "Edited after start", explanation: "Changed explanation" })
      .where(eq(schema.examQuestions.id, 1));
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ selectedIndex: 1 })
      .where(
        and(
          eq(schema.examSubmissionAnswers.submissionId, `submission-${participants.first}-latest`),
          eq(schema.examSubmissionAnswers.questionId, 1),
        ),
      );
    await testDb.db
      .update(schema.examParticipants)
      .set({ displayName: "Changed name" })
      .where(eq(schema.examParticipants.id, participants.first));

    const restored = await getAdminPresentation();
    expect(restored.questions[0]).toMatchObject({
      id: 1,
      question: "Question 1",
      explanation: "Explanation 1",
    });
    expect(restored.entries[0]).toMatchObject({ displayName: "First", score: 2, rank: 1 });
  });

  it("keeps correct answers private on question stages and exposes only announced winners", async () => {
    await addRankFixture();
    await startWithAggregate("start");

    const question = await getPublicPresentation();
    expect(question).toEqual({
      state: "question",
      question: {
        id: 1,
        ordinal: 1,
        total: 2,
        question: "Question 1",
        choices: ["Correct 1", "Wrong 1"],
        answerType: "selected",
      },
    });
    expect(JSON.stringify(question)).not.toContain("correctAnswer");
    expect(JSON.stringify(question)).not.toContain("Explanation");

    await op("advance", "a1");
    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "answer",
      question: { correctAnswer: "Correct 1", correctIndex: 0, explanation: "Explanation 1" },
    });
    await op("advance", "a2");
    await op("advance", "a3");
    await op("advance", "a4");

    await expect(getPublicPresentation()).resolves.toEqual({ state: "podium_preview" });
    await op("advance", "a5");
    await expect(getPublicPresentation()).resolves.toEqual({
      state: "third",
      winners: [
        {
          displayName: "Third",
          score: 1,
          rank: 3,
          questionResults: [
            {
              position: 0,
              question: "Question 1",
              answer: { kind: "selected", value: "Correct 1" },
              correctness: "correct",
            },
            {
              position: 1,
              question: "Question 5",
              answer: { kind: "freeText", value: "Q5 latest" },
              normalizedScore: 0,
            },
          ],
        },
      ],
    });
  });

  it("limits Drizzle SELECT-call counts to the public data required by each stage", async () => {
    await addRankFixture();
    await startWithAggregate("stage-read-counts");

    const tableSelectCalls = async (state: string, projectionHidden = false) => {
      await testDb.db
        .update(schema.presentationSessions)
        .set({ state, projectionHidden })
        .where(eq(schema.presentationSessions.id, 1));
      const { selectCalls } = await countTableSelectCalls(getPublicPresentation);
      return {
        questions: selectCalls.get(schema.presentationQuestions) ?? 0,
        entries: selectCalls.get(schema.presentationEntries) ?? 0,
        sourceQuestions: selectCalls.get(schema.examQuestions) ?? 0,
      };
    };

    expect(await tableSelectCalls("question")).toEqual({
      questions: 1,
      entries: 0,
      sourceQuestions: 0,
    });
    expect(await tableSelectCalls("answer")).toEqual({
      questions: 1,
      entries: 0,
      sourceQuestions: 1,
    });
    expect(await tableSelectCalls("podium_preview")).toEqual({
      questions: 0,
      entries: 0,
      sourceQuestions: 0,
    });
    expect(await tableSelectCalls("third")).toEqual({
      questions: 1,
      entries: 1,
      sourceQuestions: 1,
    });
    expect(await tableSelectCalls("answer", true)).toEqual({
      questions: 0,
      entries: 0,
      sourceQuestions: 0,
    });

    await testDb.db
      .update(schema.presentationSessions)
      .set({ state: "answer", questionIndex: 1, projectionHidden: false })
      .where(eq(schema.presentationSessions.id, 1));
    const secondAnswer = await countTableSelectCalls(getPublicPresentation);
    expect(secondAnswer.value).toMatchObject({
      state: "answer",
      question: { id: 5, ordinal: 2, question: "Question 5" },
    });
    expect(secondAnswer.selectCalls.get(schema.presentationQuestions)).toBe(1);
    expect(secondAnswer.selectCalls.get(schema.presentationEntries) ?? 0).toBe(0);
  });

  it("reads free-text response entries only when the current question permits publishing them", async () => {
    await addFreeTextProjectionFixture("presentation-free-text");
    const ordinary = await countTableSelectCalls(getPublicPresentation);
    expect(ordinary.value).toMatchObject({
      state: "answer",
      question: { responses: [{ displayName: "Private Name", answer: "Private response" }] },
    });
    expect(ordinary.selectCalls.get(schema.presentationEntries)).toBe(1);
    expect(ordinary.selectCalls.get(schema.examQuestions)).toBe(1);

    await testDb.db.delete(schema.presentationSessions);
    await testDb.db.delete(schema.presentationQuestions);
    await testDb.db.delete(schema.presentationEntries);
    await testDb.db.delete(schema.examQuestions);
    await addFreeTextProjectionFixture("it-literacy-005");
    const q5 = await countTableSelectCalls(getPublicPresentation);
    expect(q5.value).toMatchObject({
      state: "answer",
      question: { expectedAnswer: "Model answer" },
    });
    expect(q5.value).not.toHaveProperty("question.responses");
    expect(q5.selectCalls.get(schema.presentationEntries) ?? 0).toBe(0);
    expect(q5.selectCalls.get(schema.examQuestions)).toBe(1);
  });

  it("orders free-text responses by rank and then display name", async () => {
    await addFreeTextProjectionFixture("presentation-free-text");
    const answer = [
      {
        questionId: 105,
        answerKind: "freeText" as const,
        selectedIndex: null,
        freeText: "Response",
        rawScore: 1,
        normalizedScore: 0.5,
      },
    ];
    await testDb.db.insert(schema.presentationEntries).values([
      { sessionId: 1, participantId: 2, displayName: "Zulu", score: 0.5, rank: 2, answers: answer },
      {
        sessionId: 1,
        participantId: 3,
        displayName: "Bravo",
        score: 0.5,
        rank: 1,
        answers: answer,
      },
      {
        sessionId: 1,
        participantId: 4,
        displayName: "Alpha",
        score: 0.5,
        rank: 1,
        answers: answer,
      },
    ]);

    const projection = await getPublicPresentation();
    expect(
      projection.state === "answer" && projection.question && "responses" in projection.question
        ? projection.question.responses?.map(({ displayName }) => displayName)
        : [],
    ).toEqual(["Alpha", "Bravo", "Private Name", "Zulu"]);
  });

  it("skips source-question SELECT calls when the active snapshot question is missing", async () => {
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "answer",
      version: 1,
      questionIndex: 0,
      questionCount: 1,
    });
    const result = await countTableSelectCalls(getPublicPresentation);
    expect(result.value).toEqual({ state: "answer" });
    expect(result.selectCalls.get(schema.presentationQuestions)).toBe(1);
    expect(result.selectCalls.get(schema.examQuestions) ?? 0).toBe(0);
    expect(result.selectCalls.get(schema.presentationEntries) ?? 0).toBe(0);
  });

  it("preloads every question, answer, podium and completion slide into the presenter deck", async () => {
    await addRankFixture();
    await startWithAggregate("deck-start");

    const deck = await getAdminPresentationDeck();

    expect(deck).toMatchObject({ questionCount: 2, questionIndex: 0 });
    expect(deck.slides.map(({ state, questionIndex }) => [state, questionIndex])).toEqual([
      ["opening", 0],
      ["question", 0],
      ["answer", 0],
      ["question", 1],
      ["answer", 1],
      ["podium_preview", 1],
      ["third", 1],
      ["first", 1],
      ["finished", 1],
    ]);
    expect(deck.slides[1]?.projection).toMatchObject({
      state: "question",
      question: { question: "Question 1" },
    });
    expect(deck.slides[1]?.projection).not.toHaveProperty("question.correctAnswer");
    expect(deck.slides[2]?.projection).toMatchObject({
      state: "answer",
      question: { correctAnswer: "Correct 1", explanation: "Explanation 1" },
    });
    expect(deck.slides.find(({ state }) => state === "third")?.projection).toMatchObject({
      state: "third",
      winners: [
        {
          displayName: "Third",
          rank: 3,
          questionResults: [
            { position: 0, answer: { kind: "selected", value: "Correct 1" } },
            { position: 1, answer: { kind: "freeText", value: "Q5 latest" } },
          ],
        },
      ],
    });
    const rankSlides = deck.slides.filter(({ state }) =>
      ["third", "second", "first"].includes(state),
    );
    expect(rankSlides).toHaveLength(2);
    for (const slide of rankSlides) {
      if (
        slide.projection.state === "third" ||
        slide.projection.state === "second" ||
        slide.projection.state === "first"
      ) {
        expect(slide.projection.winners.length).toBeGreaterThan(0);
        expect(
          slide.projection.winners.every((winner) => Array.isArray(winner.questionResults)),
        ).toBe(true);
      }
    }
    const firstSlide = deck.slides.find(({ state }) => state === "first");
    expect(firstSlide?.projection).toMatchObject({
      state: "first",
      winners: [
        { displayName: "First", questionResults: [{ position: 0 }, { position: 1 }] },
        { displayName: "Tied", questionResults: [{ position: 0 }, { position: 1 }] },
      ],
    });
  });

  it("keeps tied winners' answers paired to each person and snapshot position", async () => {
    await addQuestions();
    const first = await addParticipant("First tied");
    const second = await addParticipant("Second tied");
    await addSubmission(first, [0, 1]);
    await addSubmission(second, [1, 0]);
    await startWithAggregate("tie-answer-start");
    for (let index = 0; index < 5; index += 1)
      await operatePresentation(`tie-answer-forward-${index}`, "advance");

    const projection = await getPublicPresentation();
    expect(projection).toMatchObject({ state: "first" });
    if (projection.state !== "first") return;
    expect(projection.winners).toHaveLength(2);
    expect(projection.winners.map((winner) => winner.displayName)).toEqual([
      "First tied",
      "Second tied",
    ]);
    expect(projection.winners[0]?.questionResults.map((result) => result.position)).toEqual([0, 1]);
    expect(projection.winners[0]?.questionResults).toMatchObject([
      { answer: { kind: "selected", value: "Correct 1" }, correctness: "correct" },
      { answer: { kind: "freeText", value: "Q5 latest" }, normalizedScore: 0 },
    ]);
    expect(projection.winners[1]?.questionResults).toMatchObject([
      { answer: { kind: "selected", value: "Wrong 1" }, correctness: "incorrect" },
      { answer: { kind: "freeText", value: "Q5 latest" }, normalizedScore: 1 },
    ]);
  });

  it("keeps missing, invalid, unknown, unanswered and legacy answers distinct", async () => {
    await addQuestions();
    const participantId = await addParticipant("Answer states");
    await addSubmission(participantId, [0, 0]);
    await startWithAggregate("answer-states-start");
    for (let index = 0; index < 5; index += 1)
      await operatePresentation(`answer-states-forward-${index}`, "advance");
    const [entry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, participantId));
    const answers = entry!.answers;
    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: [
          { ...answers[0]!, selectedIndex: 99 },
          { ...answers[1]!, answerKind: "unanswered", selectedIndex: null },
        ],
      })
      .where(eq(schema.presentationEntries.participantId, participantId));

    let projection = await getPublicPresentation();
    if (projection.state !== "first") throw new Error("Expected first-rank projection");
    expect(projection.winners[0]?.questionResults[0]).toMatchObject({
      answer: { kind: "selected", value: null },
      correctness: "unavailable",
    });
    expect(projection.winners[0]?.questionResults[1]?.answer).toEqual({ kind: "unanswered" });

    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: [answers[0]!, { ...answers[1]!, answerKind: "unexpected" as never }],
      })
      .where(eq(schema.presentationEntries.participantId, participantId));
    projection = await getPublicPresentation();
    if (projection.state !== "first") throw new Error("Expected first-rank projection");
    expect(projection.winners[0]?.questionResults[1]?.answer).toEqual({ kind: "unavailable" });

    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: [answers[0]!, { ...answers[1]!, answerKind: "legacy" }] })
      .where(eq(schema.presentationEntries.participantId, participantId));
    projection = await getPublicPresentation();
    if (projection.state !== "first") throw new Error("Expected first-rank projection");
    expect(projection.winners[0]?.questionResults[1]?.answer).toEqual({ kind: "legacy" });

    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: [answers[0]!] })
      .where(eq(schema.presentationEntries.participantId, participantId));
    projection = await getPublicPresentation();
    if (projection.state !== "first") throw new Error("Expected first-rank projection");
    expect(projection.winners[0]?.questionResults[1]?.answer).toEqual({ kind: "unavailable" });
  });

  it("always includes answer explanations even when the legacy stored mode is short", async () => {
    await addQuestions();
    await startWithAggregate("start-short");
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
        choices: ["Correct 1", "Wrong 1"],
        correctAnswer: "Correct 1",
        correctIndex: 0,
        explanation: "Explanation 1",
      },
    });
  });

  it("uses the question master explanation when a legacy snapshot explanation is blank", async () => {
    await addQuestions();
    await startWithAggregate("start-blank-explanation");
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ explanation: "   " })
      .where(eq(schema.presentationQuestions.sourceQuestionId, 1));
    await testDb.db
      .update(schema.examQuestions)
      .set({ explanation: "Current master explanation" })
      .where(eq(schema.examQuestions.id, 1));

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
    await addFreeTextProjectionFixture("it-literacy-005", 4.5);

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
      expect.objectContaining({
        freeText: "Private response",
        rawScore: 4.5,
        normalizedScore: 0.5,
      }),
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
        questionIds: [1],
        questionVersions: { "1": "nagano-001-v1", "5": "tamami-egg-v1" },
        revision: 1,
      },
      {
        id: "partial-answer-set",
        participantId: partialAnswersParticipant,
        questionIds: [1, 5],
        questionVersions: { "1": "nagano-001-v1", "5": "tamami-egg-v1" },
        revision: 1,
      },
    ]);
    await testDb.db.insert(schema.examSubmissionAnswers).values([
      {
        submissionId: "partial-question-set",
        questionId: 1,
        selectedIndex: 0,
      },
      {
        submissionId: "partial-answer-set",
        questionId: 1,
        selectedIndex: 0,
      },
      {
        submissionId: "partial-question-set",
        questionId: 5,
        answerKind: "freeText",
        freeText: "Q5 partial",
      },
      {
        submissionId: "partial-answer-set",
        questionId: 5,
        answerKind: "freeText",
        freeText: "Q5 partial",
      },
    ]);
    await testDb.db.insert(schema.examAnswerAssessments).values(
      ["partial-question-set", "partial-answer-set"].map((submissionId) => ({
        submissionId,
        questionId: 5,
        revision: 1,
        answerText: "Q5 partial",
        questionVersion: "tamami-egg-v1",
        state: "graded" as const,
        rawScore: 0,
        normalizedScore: 0,
        rubricVersion: "jev-q5-fulfillment-v3-02",
      })),
    );

    await startWithAggregate("partial-submissions-start");

    const entries = await testDb.db.select().from(schema.presentationEntries);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: partialQuestionsParticipant,
          score: 0,
          answers: [
            expect.objectContaining({ questionId: 1, answerKind: "unanswered" }),
            expect.objectContaining({ questionId: 5, answerKind: "unanswered" }),
          ],
        }),
        expect.objectContaining({
          participantId: partialAnswersParticipant,
          score: 1,
          answers: [
            expect.objectContaining({ questionId: 1, answerKind: "selected" }),
            expect.objectContaining({ questionId: 5, answerKind: "freeText" }),
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

    await startWithAggregate("start-hidden");
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
    await startWithAggregate("start");
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
    await op("aggregate", "stable-start-aggregate");
    const started = await operatePresentation("stable-start", "start");
    const replayedStart = await operatePresentation("stable-start", "start");
    expect(replayedStart.version).toBe(started.version);
    expect(await testDb.db.select().from(schema.presentationQuestions)).toHaveLength(2);

    await expect(op("previous", "at-first-stage")).rejects.toMatchObject({ status: 409 });
    const advanced = await operatePresentation("stable-advance", "advance");
    const replayedAdvance = await operatePresentation("stable-advance", "advance");
    expect(replayedAdvance.version).toBe(advanced.version);
    expect(replayedAdvance.state).toBe("question");
    await expect(operatePresentation("stable-back-to-opening", "previous")).resolves.toMatchObject({
      state: "opening",
    });
    expect(await testDb.db.select().from(schema.presentationOperations)).toHaveLength(4);
  });

  it.each(["missing-current-question-version", "outdated-submission-version"] as const)(
    "handles version guard for %s",
    async (caseName) => {
      await addQuestions();
      const participant = await addParticipant(`Version guard ${caseName}`);
      await addSubmission(participant, [0, 0]);

      if (caseName === "missing-current-question-version") {
        await testDb.db
          .update(schema.examQuestions)
          .set({ questionVersion: null })
          .where(eq(schema.examQuestions.id, 5));
      } else {
        await testDb.db
          .update(schema.examAnswerSubmissions)
          .set({ questionVersions: { "1": "nagano-001-v1", "5": "omiwatari-v1" } })
          .where(eq(schema.examAnswerSubmissions.id, `submission-${participant}-latest`));
      }

      if (caseName === "missing-current-question-version") {
        await expect(op("aggregate", `version-guard-${caseName}`)).rejects.toBeInstanceOf(
          PresentationConflictError,
        );
        await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toHaveLength(0);
        await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
      } else {
        const result = await op("aggregate", `version-guard-${caseName}`);
        expect(result.aggregationSummary).toEqual({
          snapshotUpdated: false,
          includedSubmissionCount: 0,
          excludedSubmissionCount: 1,
          excludedReasonCounts: {
            questionVersionMismatch: 1,
            q5AssessmentVersionMismatch: 0,
          },
        });
        await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
          { state: "not_started", version: 0, snapshotRevision: 0, questionCount: 0 },
        ]);
        await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(
          0,
        );
        await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
      }
    },
  );

  it("fails aggregation closed when the current Q5 version has no grader mapping", async () => {
    await addCurrentFiveQuestions();
    const participant = await addParticipant("Unsupported Q5 version");
    await addSubmission(participant, [0, 0]);
    await testDb.db
      .update(schema.examQuestions)
      .set({ questionVersion: "omiwatari-v1" })
      .where(eq(schema.examQuestions.id, 5));

    await expect(op("aggregate", "unsupported-current-q5-version")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toHaveLength(0);
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
  });

  it("aggregates the complete current Q1–Q5 set with matching submitted and assessed versions", async () => {
    await addCurrentFiveQuestions();
    const participant = await addParticipant("Current five-question participant");
    const submissionId = "current-five-question-submission";
    const questionVersions = {
      "1": "nagano-001-v1",
      "2": "nagano-002-v1",
      "3": "nagano-003-v1",
      "4": "nagano-004-v1",
      "5": "tamami-egg-v1",
    };
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId: participant,
      questionIds: [1, 2, 3, 4, 5],
      questionVersions,
      revision: 1,
    });
    await testDb.db.insert(schema.examSubmissionAnswers).values([
      ...[1, 2, 3, 4].map((questionId) => ({
        submissionId,
        questionId,
        selectedIndex: 0,
      })),
      { submissionId, questionId: 5, answerKind: "freeText", freeText: "Q5 current answer" },
    ]);
    await testDb.db.insert(schema.examAnswerAssessments).values({
      submissionId,
      questionId: 5,
      revision: 1,
      answerText: "Q5 current answer",
      questionVersion: "tamami-egg-v1",
      state: "graded",
      rawScore: 4.5,
      normalizedScore: 0.5,
      rubricVersion: "jev-q5-fulfillment-v3-02",
    });

    await op("aggregate", "current-five-question-aggregate");

    await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toMatchObject(
      [1, 2, 3, 4, 5].map((id) => ({ sourceQuestionId: id })),
    );
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toMatchObject([
      { participantId: participant, score: 4.5 },
    ]);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { questionVersions, rubricVersions: { "5": "jev-q5-fulfillment-v3-02" } },
    ]);
  });

  it.each([
    {
      name: "assessment question version",
      questionVersion: "omiwatari-v1",
      rubricVersion: "tamami-egg-v1",
    },
    {
      name: "assessment rubric version",
      questionVersion: "tamami-egg-v1",
      rubricVersion: "omiwatari-v1",
    },
  ])(
    "excludes a submission with a mismatched $name",
    async ({ name, questionVersion, rubricVersion }) => {
      await addCurrentFiveQuestions();
      const participant = await addParticipant(`Mismatched ${questionVersion}-${rubricVersion}`);
      const submissionId = "mismatched-q5-assessment-submission";
      const questionVersions = {
        "1": "nagano-001-v1",
        "2": "nagano-002-v1",
        "3": "nagano-003-v1",
        "4": "nagano-004-v1",
        "5": "tamami-egg-v1",
      };
      await testDb.db.insert(schema.examAnswerSubmissions).values({
        id: submissionId,
        participantId: participant,
        questionIds: [1, 2, 3, 4, 5],
        questionVersions,
        revision: 1,
      });
      await testDb.db
        .insert(schema.examSubmissionAnswers)
        .values([
          ...[1, 2, 3, 4].map((questionId) => ({ submissionId, questionId, selectedIndex: 0 })),
          { submissionId, questionId: 5, answerKind: "freeText", freeText: "Q5 current answer" },
        ]);
      await testDb.db.insert(schema.examAnswerAssessments).values({
        submissionId,
        questionId: 5,
        revision: 1,
        answerText: "Q5 current answer",
        questionVersion,
        state: "graded",
        rawScore: 4.5,
        normalizedScore: 0.5,
        rubricVersion,
      });

      const result = await op("aggregate", `mismatched-q5-${name.replaceAll(" ", "-")}`);
      expect(result.aggregationSummary).toEqual({
        snapshotUpdated: false,
        includedSubmissionCount: 0,
        excludedSubmissionCount: 1,
        excludedReasonCounts: {
          questionVersionMismatch: 0,
          q5AssessmentVersionMismatch: 1,
        },
      });
      await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
        { state: "not_started", version: 0, snapshotRevision: 0, questionCount: 0 },
      ]);
      await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(0);
      await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
    },
  );

  it.each([
    { name: "an older rubric version", rubricVersions: { "5": "omiwatari-v1" } },
    { name: "a missing rubric version", rubricVersions: {} as Record<string, string> },
  ])("blocks presentation start when the Q5 snapshot has $name", async ({ rubricVersions }) => {
    await addCurrentFiveQuestions();
    const participant = await addParticipant("Stale snapshot participant");
    const submissionId = "stale-snapshot-submission";
    const questionVersions = {
      "1": "nagano-001-v1",
      "2": "nagano-002-v1",
      "3": "nagano-003-v1",
      "4": "nagano-004-v1",
      "5": "tamami-egg-v1",
    };
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId: participant,
      questionIds: [1, 2, 3, 4, 5],
      questionVersions,
      revision: 1,
    });
    await testDb.db.insert(schema.examSubmissionAnswers).values([
      ...[1, 2, 3, 4].map((questionId) => ({
        submissionId,
        questionId,
        selectedIndex: 0,
      })),
      { submissionId, questionId: 5, answerKind: "freeText", freeText: "Q5 current answer" },
    ]);
    await testDb.db.insert(schema.examAnswerAssessments).values({
      submissionId,
      questionId: 5,
      revision: 1,
      answerText: "Q5 current answer",
      questionVersion: "tamami-egg-v1",
      state: "graded",
      rawScore: 4.5,
      normalizedScore: 0.5,
      rubricVersion: "jev-q5-fulfillment-v3-02",
    });

    await op("aggregate", "stale-q5-snapshot-aggregate");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ rubricVersions })
      .where(eq(schema.presentationSessions.id, 1));

    await expect(op("start", "stale-q5-snapshot-start")).rejects.toMatchObject({
      status: 409,
    });
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { state: "not_started", rubricVersions },
    ]);
    await expect(
      testDb.db
        .select()
        .from(schema.presentationOperations)
        .where(eq(schema.presentationOperations.operationId, "operation-stale-q5-snapshot-start")),
    ).resolves.toHaveLength(0);
  });

  it("fails closed when previous encounters an unsupported persisted state", async () => {
    await addQuestions();
    await op("aggregate", "unsupported-state-aggregate");
    await operatePresentation("unsupported-state-start", "start");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ state: "unsupported_persisted_state" })
      .where(eq(schema.presentationSessions.id, 1));
    const sessionBefore = await testDb.db.select().from(schema.presentationSessions);
    const operationHistoryBefore = await testDb.db.select().from(schema.presentationOperations);

    for (const action of ["advance", "previous"] as const) {
      const operationId = `unsupported-state-${action}`;
      await expect(operatePresentation(operationId, action)).rejects.toMatchObject({
        message: "Presentation state is invalid",
        status: 409,
      });
      await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toEqual(
        sessionBefore,
      );
      await expect(testDb.db.select().from(schema.presentationOperations)).resolves.toEqual(
        operationHistoryBefore,
      );
      await expect(
        testDb.db
          .select()
          .from(schema.presentationOperations)
          .where(eq(schema.presentationOperations.operationId, operationId)),
      ).resolves.toHaveLength(0);
    }
  });

  it("rejects reusing an operation ID for a different action", async () => {
    await operatePresentation("direct-operation-id-conflict", "hide");

    await expect(operatePresentation("direct-operation-id-conflict", "show")).rejects.toMatchObject(
      {
        message: "Operation ID conflict",
        status: 409,
      },
    );
  });

  it("returns lightweight controls for new and replayed operations while preserving full callers", async () => {
    await addQuestions();

    await operatePresentationControls("controls-aggregate", "aggregate");
    const controls = await operatePresentationControls("controls-start", "start");
    expect(controls).toEqual({
      state: "opening",
      version: 2,
      questionIndex: 0,
      questionCount: 2,
      projectionHidden: false,
      snapshotRevision: 1,
    });
    await expect(operatePresentationControls("controls-start", "start")).resolves.toEqual(controls);

    const fullSnapshot = await operatePresentation("controls-start", "start");
    expect(fullSnapshot).toMatchObject({
      state: "opening",
      version: 2,
      questionCount: 2,
      participantResultsVisible: false,
      participantResultsReady: true,
    });
    expect(fullSnapshot.questions).toHaveLength(2);
    expect(fullSnapshot.entries).toEqual([]);
  });

  it("accepts only slide positions present in the active presentation deck", async () => {
    await addQuestions();
    await operatePresentationControls("position-validation-aggregate", "aggregate");
    await operatePresentationControls("position-validation-start", "start");

    await expect(
      setPresentationPosition("position-validation-valid", "question", 1, 1, 2),
    ).resolves.toMatchObject({ state: "question", questionIndex: 1 });
    await expect(
      setPresentationPosition("position-validation-valid", "question", 0, 1, 2),
    ).rejects.toMatchObject({ status: 409, message: "Operation ID conflict" });
    await expect(
      setPresentationPosition("position-validation-question-overflow", "answer", 2, 1, 3),
    ).rejects.toMatchObject({ status: 409, message: "Invalid presentation position" });
    await expect(
      setPresentationPosition("position-validation-opening-index", "opening", 1, 1, 3),
    ).rejects.toMatchObject({ status: 409, message: "Invalid presentation position" });
    await expect(
      setPresentationPosition("position-validation-podium-index", "podium_preview", 0, 1, 3),
    ).rejects.toMatchObject({ status: 409, message: "Invalid presentation position" });
    await expect(
      setPresentationPosition("position-validation-missing-rank", "third", 1, 1, 3),
    ).rejects.toMatchObject({ status: 409, message: "Invalid presentation position" });
  });

  it("rejects unknown presentation states and non-integer question indices", async () => {
    await addQuestions();
    await operatePresentationControls("position-unknown-aggregate", "aggregate");
    await operatePresentationControls("position-unknown-start", "start");

    await expect(
      setPresentationPosition("position-unknown-state", "bogus_state" as never, 1, 1, 2),
    ).rejects.toMatchObject({ status: 409, message: "Invalid presentation position" });

    await expect(
      setPresentationPosition("position-fractional-index", "question", 1.5, 1, 2),
    ).rejects.toMatchObject({ status: 409, message: "Invalid presentation position" });
  });

  it("fences delayed position writes by session version and binds replay IDs to the request", async () => {
    await addQuestions();
    await operatePresentationControls("position-fence-aggregate", "aggregate");
    await operatePresentationControls("position-fence-start", "start");

    const first = await setPresentationPosition("position-fence-a", "question", 0, 1, 2);
    const newer = await setPresentationPosition("position-fence-b", "answer", 0, 1, first.version);
    await expect(
      setPresentationPosition("position-fence-a", "question", 0, 1, 2),
    ).resolves.toMatchObject({ state: "answer", questionIndex: 0, version: newer.version });
    await expect(
      setPresentationPosition("position-fence-a", "answer", 0, 1, 2),
    ).rejects.toMatchObject({ status: 409, message: "Operation ID conflict" });
    await expect(getAdminPresentationControls()).resolves.toMatchObject({
      state: "answer",
      questionIndex: 0,
      version: newer.version,
    });
    await expect(
      setPresentationPosition("position-fence-delayed", "question", 1, 1, 2),
    ).rejects.toMatchObject({ status: 409 });
    await expect(getAdminPresentationControls()).resolves.toMatchObject({
      state: "answer",
      questionIndex: 0,
      version: newer.version,
    });
  });

  it("uses cached terminal deck cursors for jumps and backward navigation", async () => {
    await addRankFixture();
    await startWithAggregate("terminal-deck-cursor");
    const deck = await getAdminPresentationDeck();
    const terminalSlides = deck.slides.filter(({ state }) =>
      ["podium_preview", "third", "first", "finished"].includes(state),
    );
    expect(deck.questionIndex).toBe(0);
    expect(terminalSlides.map(({ state, questionIndex }) => [state, questionIndex])).toEqual([
      ["podium_preview", 1],
      ["third", 1],
      ["first", 1],
      ["finished", 1],
    ]);

    const confirmedBeforePosition = await getAdminPresentationControls();
    const preview = await setPresentationPosition(
      "terminal-deck-jump-preview",
      "podium_preview",
      1,
      1,
      confirmedBeforePosition.version,
    );
    expect(preview).toMatchObject({ state: "podium_preview", questionIndex: 1 });
    const third = await setPresentationPosition(
      "terminal-deck-jump-third",
      "third",
      1,
      1,
      preview.version,
    );
    expect(third).toMatchObject({ state: "third", questionIndex: 1 });
    await expect(
      setPresentationPosition("terminal-deck-jump-finished", "finished", 1, 1, third.version),
    ).resolves.toMatchObject({ state: "finished", questionIndex: 1 });
    await expect(op("previous", "terminal-deck-finished-back")).resolves.toMatchObject({
      state: "first",
      questionIndex: 1,
    });
    await expect(op("previous", "terminal-deck-rank-back")).resolves.toMatchObject({
      state: "third",
      questionIndex: 1,
    });
    await expect(op("previous", "terminal-deck-third-back")).resolves.toMatchObject({
      state: "podium_preview",
      questionIndex: 1,
    });
  });

  it("rebuilds the shared snapshot only on aggregate while publication and start reuse it", async () => {
    await addQuestions();
    const participant = await addParticipant("Participant");
    await addSubmission(participant, [0, 0]);
    await op("aggregate", "results-initial-aggregate");
    await setParticipantResultsVisible(true);
    const published = await getAdminPresentation();
    expect(published).toMatchObject({
      state: "not_started",
      version: 1,
      questionIndex: 0,
      questionCount: 2,
      snapshotRevision: 1,
      projectionHidden: false,
      participantResultsVisible: true,
      participantResultsReady: true,
    });
    expect(published.questions).toHaveLength(2);
    expect(published.entries).toMatchObject([{ displayName: "Participant", score: 2, rank: 1 }]);

    await testDb.db
      .update(schema.examQuestions)
      .set({ question: "Edited after publication" })
      .where(eq(schema.examQuestions.id, 1));
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ selectedIndex: 1 })
      .where(
        and(
          eq(schema.examSubmissionAnswers.submissionId, `submission-${participant}-latest`),
          eq(schema.examSubmissionAnswers.questionId, 1),
        ),
      );
    await setParticipantResultsVisible(true);
    const repeatedPublish = await getAdminPresentation();
    expect(repeatedPublish.questions).toEqual(published.questions);
    expect(repeatedPublish.entries).toEqual(published.entries);
    expect(repeatedPublish.snapshotRevision).toBe(published.snapshotRevision);
    const started = await operatePresentation("visibility-start", "start");
    expect(started).toMatchObject({
      state: "opening",
      version: 2,
      participantResultsVisible: true,
      participantResultsReady: true,
    });
    expect(started.questions).toEqual(published.questions);
    expect(started.entries).toEqual(published.entries);

    await setParticipantResultsVisible(false);
    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({ rawScore: 0, normalizedScore: 0 })
      .where(eq(schema.examAnswerAssessments.submissionId, `submission-${participant}-latest`));
    await op("aggregate", "results-edited-aggregate");
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
      snapshotRevision: hiddenState.snapshotRevision,
      questionIndex: hiddenState.questionIndex,
      projectionHidden: hiddenState.projectionHidden,
      participantResultsVisible: true,
    });
    expect(republished.questions[0]).toMatchObject({
      id: 1,
      question: "Edited after publication",
    });
    expect(republished.entries).toMatchObject([{ displayName: "Participant", score: 0, rank: 1 }]);
    await expect(getPublicPresentation()).resolves.toEqual({ state: "opening" });
    const participantResult = await getParticipantResult(participant);
    expect(participantResult).toEqual({
      state: "visible",
      rank: 1,
      score: 0,
      questions: [
        {
          position: 0,
          question: "Edited after publication",
          answer: { kind: "selected", value: "Wrong 1", correctness: "incorrect" },
        },
        {
          position: 1,
          question: "Question 5",
          answer: { kind: "freeText", value: "Q5 latest", score: 0 },
        },
      ],
    });
  });

  it("rejects an answer update when the publication transaction commits first", async () => {
    await addCurrentFiveQuestions();
    const participantId = await addParticipant("Contended participant");
    const submissionId = `submission-${participantId}-latest`;
    const answers = [
      { questionId: 1, selectedIndex: 0 },
      { questionId: 2, selectedIndex: 0 },
      { questionId: 3, selectedIndex: 0 },
      { questionId: 4, selectedIndex: 0 },
      { questionId: 5, freeText: "Q5 answer" },
    ];
    await saveAnswerSubmission({
      submissionId,
      operationId: "concurrent-show-initial-save",
      expectedRevision: 0,
      participantId,
      answers,
    });
    await completeConcurrentQ5Assessment(submissionId, 1);
    await operatePresentation("concurrent-show-initial-aggregate", "aggregate");

    const nextAnswers = answers.map((answer) =>
      answer.questionId === 1 && "selectedIndex" in answer
        ? { ...answer, selectedIndex: 1 }
        : answer,
    );
    const [show, update] = await raceWithFirstCommitHeld(
      schema.participantResultSettings,
      () => setParticipantResultsVisible(true),
      () =>
        saveAnswerSubmission({
          submissionId,
          operationId: "concurrent-show-update-after",
          expectedRevision: 1,
          participantId,
          answers: nextAnswers,
        }),
    );

    expect(show.status).toBe("fulfilled");
    expect(update).toMatchObject({
      status: "rejected",
      reason: { code: "SUBMISSION_LOCKED" },
    });
    await expect(
      testDb.db
        .select({ revision: schema.examAnswerSubmissions.revision })
        .from(schema.examAnswerSubmissions)
        .where(eq(schema.examAnswerSubmissions.id, submissionId)),
    ).resolves.toEqual([{ revision: 1 }]);
    const [settings] = await testDb.db
      .select()
      .from(schema.participantResultSettings)
      .where(eq(schema.participantResultSettings.id, 1));
    const [session] = await testDb.db
      .select({ snapshotRevision: schema.presentationSessions.snapshotRevision })
      .from(schema.presentationSessions)
      .where(eq(schema.presentationSessions.id, 1));
    expect(settings).toMatchObject({ visible: true, everPublished: true });
    expect(session).toMatchObject({ snapshotRevision: 1 });
  });

  it("publishes after an answer update commits first and republishes its explicit aggregate", async () => {
    await addCurrentFiveQuestions();
    const participantId = await addParticipant("Contended participant");
    const submissionId = `submission-${participantId}-latest`;
    const answers = [
      { questionId: 1, selectedIndex: 0 },
      { questionId: 2, selectedIndex: 0 },
      { questionId: 3, selectedIndex: 0 },
      { questionId: 4, selectedIndex: 0 },
      { questionId: 5, freeText: "Q5 answer" },
    ];
    await saveAnswerSubmission({
      submissionId,
      operationId: "concurrent-update-initial-save",
      expectedRevision: 0,
      participantId,
      answers,
    });
    await completeConcurrentQ5Assessment(submissionId, 1);
    await operatePresentation("concurrent-update-initial-aggregate", "aggregate");
    const nextAnswers = answers.map((answer) =>
      answer.questionId === 1 && "selectedIndex" in answer
        ? { ...answer, selectedIndex: 1 }
        : answer,
    );

    const [update, show] = await raceWithFirstCommitHeld(
      schema.examAnswerSubmissions,
      () =>
        saveAnswerSubmission({
          submissionId,
          operationId: "concurrent-update-before-show",
          expectedRevision: 1,
          participantId,
          answers: nextAnswers,
        }),
      () => setParticipantResultsVisible(true),
    );

    expect(update.status).toBe("fulfilled");
    if (show.status === "rejected") throw show.reason;
    expect(show).toMatchObject({ status: "fulfilled", value: { visible: true } });
    await expect(
      testDb.db
        .select({ revision: schema.examAnswerSubmissions.revision })
        .from(schema.examAnswerSubmissions)
        .where(eq(schema.examAnswerSubmissions.id, submissionId)),
    ).resolves.toEqual([{ revision: 2 }]);
    const [settings] = await testDb.db
      .select()
      .from(schema.participantResultSettings)
      .where(eq(schema.participantResultSettings.id, 1));
    const [session] = await testDb.db
      .select({ snapshotRevision: schema.presentationSessions.snapshotRevision })
      .from(schema.presentationSessions)
      .where(eq(schema.presentationSessions.id, 1));
    expect(settings).toMatchObject({ visible: true, everPublished: true });
    expect(session).toMatchObject({ snapshotRevision: 1 });

    // Showing reuses the old explicit snapshot. Reaggregate after hiding, then
    // republish and verify the snapshot reflects the committed revision.
    await setParticipantResultsVisible(false);
    await completeConcurrentQ5Assessment(submissionId, 2);
    await operatePresentation("concurrent-update-refreshed-aggregate", "aggregate");
    await setParticipantResultsVisible(true);
    const [refreshedEntry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(
        and(
          eq(schema.presentationEntries.sessionId, 1),
          eq(schema.presentationEntries.participantId, participantId),
        ),
      );
    const [refreshedSession] = await testDb.db
      .select({ snapshotRevision: schema.presentationSessions.snapshotRevision })
      .from(schema.presentationSessions)
      .where(eq(schema.presentationSessions.id, 1));
    expect(refreshedEntry?.answers).toContainEqual(
      expect.objectContaining({ questionId: 1, answerKind: "selected", selectedIndex: 1 }),
    );
    expect(refreshedSession).toMatchObject({ snapshotRevision: 2 });
  });

  it("keeps the old hidden snapshot when republishing fails during recalculation", async () => {
    await addQuestions();
    const participant = await addParticipant("Participant");
    await addSubmission(participant, [0, 0]);
    await op("aggregate", "failed-publish-initial-aggregate");
    await setParticipantResultsVisible(true);
    const original = await getAdminPresentation();
    await setParticipantResultsVisible(false);
    await testDb.db;
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ answerKind: "freeText", selectedIndex: null, freeText: "pending response" })
      .where(eq(schema.examSubmissionAnswers.questionId, 5));
    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({ answerText: "pending response", state: "pending" })
      .where(eq(schema.examAnswerAssessments.submissionId, `submission-${participant}-latest`));

    await expect(op("aggregate", "failed-reaggregate")).rejects.toBeInstanceOf(
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

    await failFirstTransactionAfterCallback(() => op("aggregate", "retry-aggregate"));
    await setParticipantResultsVisible(true);
    await expect(getAdminPresentation()).resolves.toMatchObject({
      participantResultsVisible: true,
      participantResultsReady: true,
    });

    await op("aggregate", "retry-start-aggregate");
    const started = await failFirstTransactionAfterCallback(() =>
      operatePresentation("retry-after-lock-start", "start"),
    );
    expect(started).toMatchObject({ state: "opening", version: 3 });
    await expect(testDb.db.select().from(schema.presentationOperations)).resolves.toHaveLength(3);
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
      expect(transactionSpy).toHaveBeenCalledTimes(6);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("rethrows an exhausted lock error from a non-aggregate hide operation", async () => {
    const lockError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const transactionSpy = vi.spyOn(dbRef.db!, "transaction").mockRejectedValue(lockError);

    try {
      await expect(operatePresentation("hide-lock-exhaustion", "hide")).rejects.toBe(lockError);
      expect(transactionSpy).toHaveBeenCalledTimes(6);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("attributes an exhausted aggregate lock error to transaction begin", async () => {
    const lockError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const transactionSpy = vi.spyOn(dbRef.db!, "transaction").mockRejectedValue(lockError);

    try {
      const error = await operatePresentation("aggregate-lock-exhaustion", "aggregate").catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(PresentationOperationError);
      expect(error).toMatchObject({ phase: "transaction_begin", databaseCode: "SQLITE_BUSY" });
      expect(transactionSpy).toHaveBeenCalledTimes(6);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("rethrows non-race transaction errors from a non-aggregate hide operation", async () => {
    const transactionError = Object.assign(new Error("database unavailable"), {
      code: "SQLITE_ERROR",
    });
    const transactionSpy = vi.spyOn(dbRef.db!, "transaction").mockRejectedValue(transactionError);

    try {
      await expect(operatePresentation("hide-transaction-error", "hide")).rejects.toBe(
        transactionError,
      );
      expect(transactionSpy).toHaveBeenCalledTimes(1);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("attributes aggregate failures to the source read and snapshot write phases", async () => {
    await addQuestions();
    const sourceReadFailure = await failTransactionAtTable(schema.examQuestions, "select", () =>
      op("aggregate", "diagnostic-source-read"),
    ).catch((error: unknown) => error);
    expect(getPresentationOperationDiagnostics(sourceReadFailure)).toEqual({
      phase: "source_questions_read",
      errorKind: "database",
      databaseCode: "SQLITE_ERROR",
      clientErrorClass: null,
      clientCode: null,
    });

    await op("aggregate", "diagnostic-write-initial-aggregate");
    await setParticipantResultsVisible(true);
    await setParticipantResultsVisible(false);
    const snapshotWriteFailure = await failTransactionAtTable(
      schema.presentationEntries,
      "delete",
      () => op("aggregate", "diagnostic-snapshot-write"),
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
    await addQ5OnlyQuestion();
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
      const retryFailure = await op("aggregate", "retry-diagnostic-phase").catch(
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

  it("keeps publication private when no aggregate is ready", async () => {
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

  it("requires an explicit aggregate before starting or publishing with no participants", async () => {
    await expect(setParticipantResultsVisible(true)).rejects.toMatchObject({
      message: "Results are not ready",
      status: 409,
    });

    await expect(operatePresentation("empty-start", "start")).rejects.toMatchObject({
      status: 409,
    });
    await addQ5OnlyQuestion();
    const aggregated = await operatePresentation("empty-aggregate", "aggregate");
    expect(aggregated).toMatchObject({ snapshotRevision: 1, version: 1, state: "not_started" });
    const started = await operatePresentation("empty-start", "start");
    expect(started).toMatchObject({
      state: "opening",
      version: 2,
      questionCount: 1,
      participantResultsReady: true,
    });
    expect(started.questions).toMatchObject([{ id: 5 }]);
    expect(started.entries).toEqual([]);
    await expect(op("reset", "empty-reset")).resolves.toMatchObject({
      state: "opening",
      version: 3,
      questionCount: 1,
    });
    await expect(getAdminPresentationDeck()).resolves.toMatchObject({
      questionCount: 1,
      slides: [
        { state: "opening", projection: { state: "opening" } },
        { state: "question", projection: { state: "question" } },
        { state: "answer", projection: { state: "answer" } },
        { state: "podium_preview", projection: { state: "podium_preview" } },
        { state: "finished", projection: { state: "finished" } },
      ],
    });

    await testDb.db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: false,
      everPublished: false,
    });
    await expect(setParticipantResultsVisible(true)).resolves.toEqual({ visible: true });
    await expect(getAdminPresentation()).resolves.toMatchObject({
      state: "opening",
      version: 3,
      questionCount: 1,
      participantResultsVisible: true,
      participantResultsReady: true,
      questions: [{ id: 5 }],
      entries: [],
    });
  });

  it("does not repair a malformed presentation snapshot on first publication", async () => {
    await addQuestions();
    const participant = await addParticipant("Malformed result");
    await addSubmission(participant, [0, 0]);
    await startWithAggregate("malformed-first-publish-start");
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

  it("resets an out-of-range cursor while reaggregating after questions are removed", async () => {
    await addQuestions();
    const participant = await addParticipant("Cursor participant");
    await addSubmission(participant, [0, 0]);
    await op("aggregate", "cursor-initial-aggregate");
    await setParticipantResultsVisible(true);
    await operatePresentation("cursor-start", "start");
    await operatePresentation("cursor-answer-1", "advance");
    await operatePresentation("cursor-question-2", "advance");
    await operatePresentation("cursor-answer-2", "advance");

    await setParticipantResultsVisible(false);
    await testDb.db.delete(schema.examQuestions).where(eq(schema.examQuestions.id, 1));
    await testDb.db
      .update(schema.examAnswerSubmissions)
      .set({ questionIds: [5], questionVersions: { "5": "tamami-egg-v1" } })
      .where(eq(schema.examAnswerSubmissions.id, `submission-${participant}-latest`));
    await testDb.db
      .delete(schema.examSubmissionAnswers)
      .where(
        and(
          eq(schema.examSubmissionAnswers.submissionId, `submission-${participant}-latest`),
          eq(schema.examSubmissionAnswers.questionId, 1),
        ),
      );
    await op("aggregate", "cursor-one-question-aggregate");
    await setParticipantResultsVisible(true);
    const oneQuestion = await getAdminPresentation();
    expect(oneQuestion).toMatchObject({
      state: "question",
      questionIndex: 0,
      questionCount: 1,
      version: 6,
      snapshotRevision: 2,
    });

    await setParticipantResultsVisible(false);
    await testDb.db.delete(schema.examQuestions).where(eq(schema.examQuestions.id, 5));
    await expect(op("aggregate", "cursor-no-questions-aggregate")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await setParticipantResultsVisible(true);
    const noQuestions = await getAdminPresentation();
    expect(noQuestions).toMatchObject({
      state: "question",
      questionIndex: 0,
      questionCount: 1,
      version: 6,
      snapshotRevision: 2,
    });
  });

  it("rolls back aggregation when a free response is still ungraded", async () => {
    await addQuestions();
    const participant = await addParticipant("Waiting assessment");
    await addSubmission(participant, [0, 0]);
    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "it-literacy-005", choices: [] })
      .where(eq(schema.examQuestions.id, 5));
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ answerKind: "freeText", selectedIndex: null, freeText: "pending response" })
      .where(eq(schema.examSubmissionAnswers.questionId, 5));
    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({
        answerText: "pending response",
        state: "pending",
        questionVersion: "tamami-egg-v1",
        rubricVersion: "jev-q5-fulfillment-v3-02",
      })
      .where(eq(schema.examAnswerAssessments.submissionId, `submission-${participant}-latest`));

    await expect(op("aggregate", "pending-response-aggregate")).rejects.toBeInstanceOf(
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

  it("rejects a legacy Q5 answer even when its sibling submission has a matching assessment", async () => {
    await addQuestions();
    const legacyParticipant = await addParticipant("Legacy Q5");
    const gradedParticipant = await addParticipant("Graded Q5");
    await addSubmission(legacyParticipant, [0, 0], 1, "legacy");
    await addSubmission(gradedParticipant, [0, 0], 1, "graded");
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ answerKind: "legacy", selectedIndex: 0, freeText: null })
      .where(
        and(
          eq(schema.examSubmissionAnswers.submissionId, `submission-${legacyParticipant}-legacy`),
          eq(schema.examSubmissionAnswers.questionId, 5),
        ),
      );
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ answerKind: "freeText", selectedIndex: null, freeText: "graded response" })
      .where(
        and(
          eq(schema.examSubmissionAnswers.submissionId, `submission-${gradedParticipant}-graded`),
          eq(schema.examSubmissionAnswers.questionId, 5),
        ),
      );
    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({ answerText: "graded response", rawScore: 6.75, normalizedScore: 0.75 })
      .where(
        eq(schema.examAnswerAssessments.submissionId, `submission-${gradedParticipant}-graded`),
      );

    await expect(op("aggregate", "q5-eligibility")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
  });

  it("returns the cookie owner's answers and correctness and fails closed on malformed snapshots", async () => {
    await addQuestions();
    const first = await addParticipant("First");
    const second = await addParticipant("Second");
    await addSubmission(first, [0, 0]);
    await addSubmission(second, [0, 1]);
    await startWithAggregate("results-start");
    const lateParticipant = await addParticipant("Late participant");
    await setParticipantResultsVisible(true);
    await expect(getParticipantResult(lateParticipant)).resolves.toEqual({ state: "unavailable" });

    await testDb.db
      .update(schema.examQuestions)
      .set({ question: "Changed after presentation" })
      .where(eq(schema.examQuestions.id, 1));
    await expect(getParticipantResult(first)).resolves.toEqual({
      state: "visible",
      rank: 1,
      score: 2,
      questions: [
        {
          position: 0,
          question: "Question 1",
          answer: { kind: "selected", value: "Correct 1", correctness: "correct" },
        },
        {
          position: 1,
          question: "Question 5",
          answer: { kind: "freeText", value: "Q5 latest", score: 1 },
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
          question: "Question 1",
          answer: { kind: "selected", value: "Correct 1", correctness: "correct" },
        },
        {
          position: 1,
          question: "Question 5",
          answer: { kind: "freeText", value: "Q5 latest", score: 0 },
        },
      ],
    });
    const [firstEntry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, first));
    const invalidIndexSnapshot = firstEntry!.answers.map((answer) =>
      answer.questionId === 1 ? { ...answer, selectedIndex: -1 } : answer,
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
          answer: { kind: "freeText", value: "Q5 latest" },
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
          answer: { kind: "freeText", value: "Q5 latest" },
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
      answer.questionId === 1
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
        { position: 0, question: "Question 1", answer: { kind: "unanswered" } },
        { position: 1, question: "Question 5", answer: { kind: "legacy" } },
      ],
    });
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ choices: ["Correct 5", "Wrong 5"] })
      .where(eq(schema.presentationQuestions.position, 1));
    const legacyOnChoiceQuestion = firstEntry!.answers.map((answer) =>
      answer.questionId === 1
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
      answer.questionId === 5
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
          question: "Question 1",
          answer: { kind: "selected", value: "Correct 1", correctness: "correct" },
        },
        {
          position: 1,
          question: "Question 5",
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
      answer.questionId === 5 ? { ...answer, normalizedScore: 1.2 } : answer,
    );
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: outOfRangeScoreSnapshot })
      .where(eq(schema.presentationEntries.participantId, second));
    await expect(getParticipantResult(second)).resolves.toEqual({ state: "unavailable" });
    const malformedSnapshot = freeTextSnapshot.map((answer) =>
      answer.questionId === 5 ? { ...answer, answerKind: "unrecognized" } : answer,
    ) as unknown as typeof freeTextSnapshot;
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: malformedSnapshot })
      .where(eq(schema.presentationEntries.participantId, second));
    await expect(getParticipantResult(second)).resolves.toEqual({ state: "unavailable" });
  });

  it("recovers an operation retry after an adapter conflict without advancing twice", async () => {
    await addQuestions();
    await startWithAggregate("start");

    const recovered = await commitWinnerThenRaiseAdapterUniqueConflict("adapter-retry");

    expect(recovered).toMatchObject({ state: "answer", questionIndex: 0, version: 4 });
    expect(await testDb.db.select().from(schema.presentationOperations)).toHaveLength(4);
  });

  it("returns controls when recovering an operation committed by a concurrent retry", async () => {
    await addQuestions();
    await op("aggregate", "controls-race-aggregate");
    await operatePresentation("controls-race-start", "start");

    const recovered = await commitWinnerThenRaiseAdapterUniqueConflict(
      "controls-race-advance",
      () => operatePresentationControls("controls-race-advance", "advance"),
    );

    expect(recovered).toEqual({
      state: "question",
      version: 3,
      questionIndex: 0,
      questionCount: 2,
      projectionHidden: false,
      snapshotRevision: 1,
    });
    expect(await testDb.db.select().from(schema.presentationOperations)).toHaveLength(3);
    await expect(operatePresentationControls("controls-race-advance", "advance")).resolves.toEqual(
      recovered,
    );
    expect(await testDb.db.select().from(schema.presentationOperations)).toHaveLength(3);
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

  it("marks malformed winner question snapshots unavailable", async () => {
    await addFreeTextProjectionFixture("another-free-text-question");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ state: "first" })
      .where(eq(schema.presentationSessions.id, 1));
    // JSON persistence stores null slots, which must fail dense string-choice
    // validation before the answer can be projected.
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ choices: ["Only choice", null] as never })
      .where(eq(schema.presentationQuestions.position, 0));

    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "first",
      winners: [
        {
          questionResults: [
            {
              question: null,
              answer: { kind: "unavailable" },
            },
          ],
        },
      ],
    });
  });

  it("preserves a null free-text answer as an unavailable value in winner results", async () => {
    await addFreeTextProjectionFixture("another-free-text-question");
    await testDb.db
      .update(schema.presentationSessions)
      .set({ state: "first" })
      .where(eq(schema.presentationSessions.id, 1));
    const [entry] = await testDb.db.select().from(schema.presentationEntries);
    const [snapshot] = entry!.answers;
    await testDb.db
      .update(schema.presentationEntries)
      .set({ answers: [{ ...snapshot!, freeText: null }] })
      .where(eq(schema.presentationEntries.participantId, 1));

    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "first",
      winners: [
        {
          questionResults: [
            {
              question: "Free-text question",
              answer: { kind: "freeText", value: null },
              scoreStatus: "unavailable",
            },
          ],
        },
      ],
    });
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

  it("defaults to the not-started projection when no presentation session exists", async () => {
    await expect(getPublicPresentation()).resolves.toEqual({ state: "not_started" });
  });

  it("skips older submissions for an already-ranked participant", async () => {
    await addQuestions();
    const participant = await addParticipant("Multiple submissions");
    await addSubmission(participant, [0, 0], 1, "older");
    await addSubmission(participant, [0, 1], 2, "newer");

    await startWithAggregate("multiple-submissions-start");

    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toMatchObject([
      { participantId: participant, score: 1, rank: 1 },
    ]);
  });

  it("falls back to an older complete submission when the newest Q5 answer is incomplete", async () => {
    await addQuestions();
    const participant = await addParticipant("Older complete submission");
    await addSubmission(participant, [0, 0], 1, "older-complete");
    await addSubmission(participant, [1, 1], 2, "newer-incomplete");
    await testDb.db
      .delete(schema.examSubmissionAnswers)
      .where(
        and(
          eq(
            schema.examSubmissionAnswers.submissionId,
            `submission-${participant}-newer-incomplete`,
          ),
          eq(schema.examSubmissionAnswers.questionId, 5),
        ),
      );

    const aggregated = await op("aggregate", "fallback-older-complete");

    expect(aggregated.entries).toMatchObject([{ score: 2, rank: 1 }]);
  });

  it("scores a participant with only an incomplete Q5 submission as unanswered", async () => {
    await addQuestions();
    const participant = await addParticipant("Incomplete only submission");
    await addSubmission(participant, [0, 0], 1, "incomplete-only");
    await testDb.db
      .delete(schema.examSubmissionAnswers)
      .where(
        and(
          eq(
            schema.examSubmissionAnswers.submissionId,
            `submission-${participant}-incomplete-only`,
          ),
          eq(schema.examSubmissionAnswers.questionId, 5),
        ),
      );

    const aggregated = await op("aggregate", "incomplete-only-submission");

    expect(aggregated.entries).toMatchObject([
      {
        score: 0,
        answers: [
          { questionId: 1, answerKind: "unanswered" },
          { questionId: 5, answerKind: "unanswered" },
        ],
      },
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
    await addQ5OnlyQuestion();

    await expect(
      returnNoSelectedRows(
        schema.presentationSessions,
        () => op("aggregate", "missing-session-read"),
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
    await startWithAggregate("started-once");

    await expect(operatePresentation("started-twice", "start")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
  });

  it("moves backward through answer and podium preview cursor states", async () => {
    await addQuestions();
    await startWithAggregate("previous-states-start");
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
    await startWithAggregate("third-place-start");
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

  it("returns from a Q5-only presentation with no participants from finished to preview", async () => {
    await addQ5OnlyQuestion();
    await startWithAggregate("empty-finished-start");
    await operatePresentation("empty-finished-answer", "advance");
    await operatePresentation("empty-finished-preview", "advance");
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
    await op("aggregate", "start-cas-aggregate");

    await expect(
      returnNoUpdatedRows(schema.presentationSessions, () =>
        operatePresentation("start-cas-miss", "start"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { state: "not_started", version: 1, snapshotRevision: 1, questionCount: 2 },
    ]);
    await expect(testDb.db.select().from(schema.presentationQuestions)).resolves.toHaveLength(2);
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
    await startWithAggregate("advance-cas-start");

    await expect(
      returnNoUpdatedRows(schema.presentationSessions, () =>
        operatePresentation("advance-cas-miss", "advance"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { state: "question", version: 3, questionIndex: 0 },
    ]);
  });

  it("rejects a reset when its compare-and-swap update returns no rows", async () => {
    await addQuestions();
    await startWithAggregate("reset-cas-start");

    await expect(
      returnNoUpdatedRows(schema.presentationSessions, () => op("reset", "reset-cas-miss")),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toMatchObject([
      { state: "question", version: 3, questionIndex: 0 },
    ]);
  });

  it("rejects an aggregate when its snapshot compare-and-swap update returns no rows", async () => {
    await addQuestions();
    await op("aggregate", "aggregate-cas-initial");
    await testDb.db
      .update(schema.examQuestions)
      .set({ question: "Changed before failed aggregate" })
      .where(eq(schema.examQuestions.id, 1));

    await expect(
      returnNoUpdatedRows(schema.presentationSessions, () => op("aggregate", "aggregate-cas-miss")),
    ).rejects.toBeInstanceOf(PresentationConflictError);
    await expect(getAdminPresentation()).resolves.toMatchObject({
      version: 1,
      snapshotRevision: 1,
      questions: [
        expect.objectContaining({ id: 1, question: "Question 1" }),
        expect.objectContaining({ id: 5, question: "Question 5" }),
      ],
    });
  });

  it("wraps non-conflict errors while publishing participant results", async () => {
    await addQuestions();
    await op("aggregate", "visibility-transaction-error-aggregate");

    const error = await failTransactionAtTable(schema.participantResultSettings, "insert", () =>
      setParticipantResultsVisible(true),
    ).catch((caught: unknown) => caught);

    expect(getPresentationOperationDiagnostics(error)).toEqual({
      phase: "write_visibility",
      errorKind: "database",
      databaseCode: "SQLITE_ERROR",
      clientErrorClass: null,
      clientCode: null,
    });
  });

  it("reports a state conflict when a known adapter conflict has no committed operation", async () => {
    await addQuestions();
    await startWithAggregate("unique-conflict-start");

    await expect(
      failFirstTransactionWithUniqueConflict(() =>
        operatePresentation("unique-conflict-no-winner", "advance"),
      ),
    ).rejects.toBeInstanceOf(PresentationConflictError);
  });

  it("reports an operation ID conflict when race recovery finds a different action", async () => {
    await addQuestions();
    await op("aggregate", "reused-operation-aggregate");
    await operatePresentation("reused-operation-id", "start");

    const error = await returnNoSelectedRows(schema.presentationOperations, () =>
      operatePresentation("reused-operation-id", "advance"),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PresentationConflictError);
    expect(error).toHaveProperty("message", "Operation ID conflict");
    expect(error).toHaveProperty("status", 409);
  });

  it("does not invent an aggregation summary when replaying an aggregate without persisted summary data", async () => {
    await addQuestions();
    await addParticipant("Aggregate replay");
    const operationId = "aggregate-summary-replay";
    await operatePresentation(operationId, "aggregate");
    await testDb.db
      .update(schema.presentationOperations)
      .set({ aggregationSummary: null })
      .where(eq(schema.presentationOperations.operationId, operationId));

    await expect(
      testDb.db
        .select({ aggregationSummary: schema.presentationOperations.aggregationSummary })
        .from(schema.presentationOperations)
        .where(eq(schema.presentationOperations.operationId, operationId)),
    ).resolves.toEqual([{ aggregationSummary: null }]);

    const replay = await operatePresentation(operationId, "aggregate");

    expect(replay).not.toHaveProperty("aggregationSummary");
  });

  it("returns the persisted aggregation summary when replaying an aggregate operation", async () => {
    await addQuestions();
    await addParticipant("Aggregate replay with summary");
    const operationId = "aggregate-summary-replay-with-summary";
    const first = await operatePresentation(operationId, "aggregate");

    const replay = await operatePresentation(operationId, "aggregate");

    expect(first.aggregationSummary).toBeDefined();
    expect(replay.aggregationSummary).toEqual(first.aggregationSummary);
  });

  it("does not attach an aggregation summary when recovering a non-aggregate operation replay", async () => {
    await addQuestions();
    await startWithAggregate("replay-non-aggregate");
    const operationId = "recover-non-aggregate-replay";

    const recovered = await commitWinnerThenRaiseAdapterUniqueConflict(operationId, () =>
      operatePresentation(operationId, "advance"),
    );

    expect(recovered).not.toHaveProperty("aggregationSummary");
    await expect(
      testDb.db
        .select({ action: schema.presentationOperations.action })
        .from(schema.presentationOperations)
        .where(eq(schema.presentationOperations.operationId, operationId)),
    ).resolves.toEqual([{ action: "advance" }]);
  });

  it("returns the persisted aggregation summary when recovering an aggregate operation race", async () => {
    await addQuestions();
    await addParticipant("Aggregate race recovery");
    const operationId = "recover-aggregate-replay";

    const recovered = await commitWinnerThenRaiseAdapterUniqueConflict(
      operationId,
      () => operatePresentation(operationId, "aggregate"),
      "aggregate",
    );

    expect(recovered.aggregationSummary).toEqual({
      snapshotUpdated: true,
      includedSubmissionCount: 0,
      excludedSubmissionCount: 0,
      excludedReasonCounts: {
        questionVersionMismatch: 0,
        q5AssessmentVersionMismatch: 0,
      },
    });
  });
});
