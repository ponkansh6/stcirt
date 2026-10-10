import { bench, describe, vi } from "vitest";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "drizzle-orm/logger";
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

type Action = "start" | "advance" | "previous" | "hide" | "show";
type RepositoryAction = Action | "aggregate";
type Variant = "operatePresentation" | "operatePresentationControls";
type SqlLogger = Logger & { reset(): void; count(): number };

function createSqlLogger(): SqlLogger {
  let statementCount = 0;
  return {
    logQuery() {
      // Count only. SQL text and bound parameters may contain sensitive data.
      statementCount += 1;
    },
    reset() {
      statementCount = 0;
    },
    count() {
      return statementCount;
    },
  };
}

function percentile(samples: number[], percent: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil((percent / 100) * sorted.length) - 1;
  return Number(sorted[Math.max(0, index)]!.toFixed(4));
}

function roundedMean(samples: number[]): number {
  if (samples.length === 0) return 0;
  return Number((samples.reduce((sum, sample) => sum + sample, 0) / samples.length).toFixed(4));
}

function emitResult(result: Record<string, unknown>) {
  const json = JSON.stringify(result);
  process.stdout.write(`${json}\n`);
  const outputPath = process.env.PRESENTATION_BENCH_OUTPUT;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    appendFileSync(outputPath, `${json}\n`, "utf8");
  }
}

describe("presentation repository latency benchmark", () => {
  let testDb: TestDb | null = null;
  let logger: SqlLogger | null = null;
  let repository: Record<string, unknown> | null = null;
  let publicRouteHandler: (() => Promise<Response>) | null = null;
  let initialization: Promise<void> | null = null;
  let cleaned = false;

  async function ensureInitialized() {
    initialization ??= (async () => {
      const activeLogger = createSqlLogger();
      const activeTestDb = await createTestDb({ logger: activeLogger });
      testDb = activeTestDb;
      logger = activeLogger;
      dbRef.db = activeTestDb.db;
      process.once("exit", cleanupTestDb);
      // Dynamic namespace import keeps this benchmark copyable to the old HEAD,
      // where operatePresentationControls may not exist.
      repository =
        (await import("@/lib/db/repository/presentation-repository")) as unknown as Record<
          string,
          unknown
        >;
      const route = await import("@/app/api/presentation/route");
      publicRouteHandler = route.GET;
      activeLogger.reset();
    })();
    await initialization;
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    assert.ok(logger, "Drizzle SQL logger must be initialized");
    assert.ok(repository, "Presentation repository must be initialized");
    assert.ok(publicRouteHandler, "Public presentation route handler must be initialized");
  }

  function cleanupTestDb() {
    if (cleaned || !testDb) return;
    cleaned = true;
    testDb.cleanup();
    testDb = null;
    dbRef.db = null;
  }

  async function resetFixture() {
    assert.ok(testDb, "File-backed benchmark database must be initialized");
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
    await testDb.db.insert(schema.examQuestions).values([
      {
        id: 11,
        key: "bench-question-11",
        question: "Question 11",
        choices: ["Correct", "Wrong"],
        correctIndex: 0,
        explanation: "Explanation 11",
      },
      {
        id: 22,
        key: "bench-question-22",
        question: "Question 22",
        choices: ["Correct", "Wrong"],
        correctIndex: 0,
        explanation: "Explanation 22",
      },
    ]);
  }

  type PublicStage =
    | "hidden"
    | "question"
    | "selected-answer"
    | "q5-free-text-answer"
    | "non-q5-free-text-answer"
    | "podium-preview"
    | "finished"
    | "rank";

  async function preparePublicStage(stage: PublicStage) {
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    await resetFixture();

    const isFreeText = stage === "q5-free-text-answer" || stage === "non-q5-free-text-answer";
    const sourceKey =
      stage === "q5-free-text-answer"
        ? "it-literacy-005"
        : stage === "non-q5-free-text-answer"
          ? "presentation-free-text"
          : "bench-question-11";
    const questionChoices = isFreeText ? [] : ["Correct", "Wrong"];
    if (sourceKey !== "bench-question-11") {
      await testDb.db
        .update(schema.examQuestions)
        .set({ key: sourceKey, choices: questionChoices })
        .where(eq(schema.examQuestions.id, 11));
    }

    const state =
      stage === "question" || stage === "hidden"
        ? "question"
        : stage === "selected-answer" || isFreeText
          ? "answer"
          : stage === "podium-preview"
            ? "podium_preview"
            : stage === "rank"
              ? "third"
              : "finished";
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state,
      version: 1,
      questionIndex: 0,
      questionCount: 2,
      snapshotRevision: 1,
      projectionHidden: stage === "hidden",
    });
    await testDb.db.insert(schema.presentationQuestions).values([
      {
        sessionId: 1,
        position: 0,
        sourceQuestionId: 11,
        question: isFreeText ? "Free-text question" : "Question 11",
        choices: questionChoices,
        correctIndex: 0,
        explanation: "Explanation 11",
      },
      {
        sessionId: 1,
        position: 1,
        sourceQuestionId: 22,
        question: "Question 22",
        choices: ["Correct", "Wrong"],
        correctIndex: 0,
        explanation: "Explanation 22",
      },
    ]);
    await testDb.db.insert(schema.presentationEntries).values(
      [1, 2, 3].map((rank) => ({
        sessionId: 1,
        participantId: rank,
        displayName: `Participant ${rank}`,
        score: 4 - rank,
        rank,
        answers: [
          {
            questionId: 11,
            answerKind: isFreeText ? ("freeText" as const) : ("selected" as const),
            selectedIndex: isFreeText ? null : 0,
            freeText: isFreeText ? `Response ${rank}` : null,
            rawScore: 1,
            normalizedScore: 1,
          },
          {
            questionId: 22,
            answerKind: "selected" as const,
            selectedIndex: 0,
            freeText: null,
            rawScore: 1,
            normalizedScore: 1,
          },
        ],
      })),
    );
  }

  async function runPublicProjection(variant: "repository" | "route-handler") {
    if (variant === "repository") {
      assert.ok(repository, "Presentation repository was not initialized");
      const getPublic = repository.getPublicPresentation as (() => Promise<unknown>) | undefined;
      if (typeof getPublic !== "function") throw new Error("getPublicPresentation must exist");
      return getPublic();
    }
    assert.ok(publicRouteHandler, "Public presentation route handler was not initialized");
    return publicRouteHandler();
  }

  async function runOperation(variant: Variant, operationId: string, action: RepositoryAction) {
    assert.ok(repository, "Presentation repository was not initialized");
    const operation = repository[variant] as
      | ((id: string, selectedAction: RepositoryAction) => Promise<unknown>)
      | undefined;
    if (typeof operation !== "function") {
      throw new Error(`${variant} must exist for this benchmark`);
    }
    return operation(operationId, action);
  }

  const scenarios: Array<{
    action: Action | "replay";
    actionToRun: Action;
    before: (variant: Variant, operationId: string) => Promise<void>;
    requiredReads: string;
    stateTransitions: string[];
  }> = [
    {
      action: "start",
      actionToRun: "start",
      before: async () => {},
      requiredReads: "current session and aggregate presentation snapshot",
      stateTransitions: ["aggregate"],
    },
    {
      action: "advance",
      actionToRun: "advance",
      before: async (variant, operationId) => {
        await runOperation(variant, `${operationId}-setup-start`, "start");
      },
      requiredReads: "current session and presentation snapshot",
      stateTransitions: ["aggregate", "start"],
    },
    {
      action: "previous",
      actionToRun: "previous",
      before: async (variant, operationId) => {
        await runOperation(variant, `${operationId}-setup-start`, "start");
        await runOperation(variant, `${operationId}-setup-advance-1`, "advance");
        await runOperation(variant, `${operationId}-setup-advance-2`, "advance");
      },
      requiredReads: "current session and presentation snapshot",
      stateTransitions: ["aggregate", "start", "advance", "advance"],
    },
    {
      action: "hide",
      actionToRun: "hide",
      before: async (variant, operationId) => {
        await runOperation(variant, `${operationId}-setup-start`, "start");
      },
      requiredReads: "current session state",
      stateTransitions: ["aggregate", "start"],
    },
    {
      action: "show",
      actionToRun: "show",
      before: async (variant, operationId) => {
        await runOperation(variant, `${operationId}-setup-start`, "start");
        await runOperation(variant, `${operationId}-setup-hide`, "hide");
      },
      requiredReads: "current session state",
      stateTransitions: ["aggregate", "start", "hide"],
    },
    {
      action: "replay",
      actionToRun: "start",
      before: async (variant, operationId) => {
        await runOperation(variant, operationId, "start");
      },
      requiredReads: "operation idempotency record and current session state",
      stateTransitions: ["aggregate", "start (same operation ID before measurement)"],
    },
  ];

  for (const variant of ["operatePresentation", "operatePresentationControls"] as const) {
    for (const scenario of scenarios) {
      const durations: number[] = [];
      const statementCounts: number[] = [];
      const operationId = `presentation-bench-${scenario.action}`;
      const action = scenario.actionToRun;
      let sampleSequence = 0;
      let unavailableReported = false;
      let unavailableRuns = 0;

      bench(
        `${variant}/${scenario.action}`,
        async () => {
          await ensureInitialized();
          assert.ok(repository, "Presentation repository was not initialized");
          if (repository[variant] === undefined) {
            assert.equal(variant, "operatePresentationControls");
            unavailableRuns += 1;
            if (!unavailableReported) {
              emitResult({
                benchmark: "presentation-latency",
                variant,
                available: false,
                action: scenario.action,
                samples: 0,
              });
              unavailableReported = true;
            }
            return;
          }
          // Reset and fixture work are outside the measured operation.
          await resetFixture();
          const aggregateOperationId = `${operationId}-${variant}-aggregate-${++sampleSequence}`;
          const aggregateResult = await runOperation(variant, aggregateOperationId, "aggregate");
          assert.ok(
            aggregateResult !== null &&
              typeof aggregateResult === "object" &&
              "snapshotRevision" in aggregateResult &&
              typeof aggregateResult.snapshotRevision === "number" &&
              aggregateResult.snapshotRevision > 0,
            "Each scenario must prepare a unique aggregate presentation snapshot",
          );
          await scenario.before(variant, operationId);
          assert.ok(logger, "Drizzle SQL logger must be initialized");
          logger.reset();

          const startedAt = performance.now();
          const result = await runOperation(variant, operationId, action);
          const duration = performance.now() - startedAt;
          const sqlStatements = logger.count();
          assert.ok(
            result !== null && typeof result === "object",
            "Operation must return a result",
          );
          assert.ok(sqlStatements > 0, "Operation must execute logged Drizzle SQL statements");
          durations.push(duration);
          statementCounts.push(sqlStatements);
          if (durations.length === 40) {
            emitResult({
              benchmark: "presentation-latency",
              variant,
              available: true,
              action: scenario.action,
              cacheState: "warm steady-state; migration and first-use startup excluded",
              stateTransitionsBeforeMeasurement: scenario.stateTransitions,
              requiredReads: scenario.requiredReads,
              samples: durations.length,
              sqlStatementsPerOperation: roundedMean(statementCounts),
              durationMs: {
                p50: percentile(durations, 50),
                p95: percentile(durations, 95),
              },
              vitestRunnerMetricValid: false,
              vitestRunnerMetricReason:
                "Vitest task timing includes fixture reset and state preparation; use durationMs only.",
            });
          }
        },
        {
          time: 0,
          iterations: 40,
          warmupIterations: 0,
          warmupTime: 0,
        },
      );
    }
  }

  const publicStages: PublicStage[] = [
    "hidden",
    "question",
    "selected-answer",
    "q5-free-text-answer",
    "non-q5-free-text-answer",
    "podium-preview",
    "finished",
    "rank",
  ];
  for (const stage of publicStages) {
    for (const variant of ["repository", "route-handler"] as const) {
      const durations: number[] = [];
      const statementCounts: number[] = [];
      bench(
        `getPublicPresentation/${stage}/${variant}`,
        async () => {
          await ensureInitialized();
          await preparePublicStage(stage);
          assert.ok(logger, "Drizzle SQL logger must be initialized");
          logger.reset();

          const startedAt = performance.now();
          const result = await runPublicProjection(variant);
          const duration = performance.now() - startedAt;
          const sqlStatements = logger.count();
          assert.ok(result !== null && typeof result === "object");
          assert.ok(sqlStatements > 0, "Projection must execute logged Drizzle SQL statements");
          durations.push(duration);
          statementCounts.push(sqlStatements);
          if (durations.length === 40) {
            emitResult({
              benchmark: "presentation-latency",
              variant,
              available: true,
              operation: "getPublicPresentation",
              stage,
              samples: durations.length,
              sqlStatementsPerOperation: roundedMean(statementCounts),
              durationMs: {
                p50: percentile(durations, 50),
                p95: percentile(durations, 95),
              },
              timingScope: "local in-process SQLite fixture; route-handler excludes wire HTTP",
              sqlMetricScope: "aggregate Drizzle statement count; not network roundtrips",
            });
          }
        },
        {
          time: 0,
          iterations: 40,
          warmupIterations: 0,
          warmupTime: 0,
        },
      );
    }
  }
});
