import { bench, describe, vi } from "vitest";
import assert from "node:assert/strict";
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
      activeLogger.reset();
    })();
    await initialization;
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    assert.ok(logger, "Drizzle SQL logger must be initialized");
    assert.ok(repository, "Presentation repository must be initialized");
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

  async function runOperation(variant: Variant, operationId: string, action: Action) {
    assert.ok(repository, "Presentation repository was not initialized");
    const operation = repository[variant] as
      | ((id: string, selectedAction: Action) => Promise<unknown>)
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
      requiredReads: "source questions and current session state",
      stateTransitions: [],
    },
    {
      action: "advance",
      actionToRun: "advance",
      before: async (variant, operationId) => {
        await runOperation(variant, `${operationId}-setup-start`, "start");
      },
      requiredReads: "current session and presentation snapshot",
      stateTransitions: ["start"],
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
      stateTransitions: ["start", "advance", "advance"],
    },
    {
      action: "hide",
      actionToRun: "hide",
      before: async (variant, operationId) => {
        await runOperation(variant, `${operationId}-setup-start`, "start");
      },
      requiredReads: "current session state",
      stateTransitions: ["start"],
    },
    {
      action: "show",
      actionToRun: "show",
      before: async (variant, operationId) => {
        await runOperation(variant, `${operationId}-setup-start`, "start");
        await runOperation(variant, `${operationId}-setup-hide`, "hide");
      },
      requiredReads: "current session state",
      stateTransitions: ["start", "hide"],
    },
    {
      action: "replay",
      actionToRun: "start",
      before: async (variant, operationId) => {
        await runOperation(variant, operationId, "start");
      },
      requiredReads: "operation idempotency record and current session state",
      stateTransitions: ["start (same operation ID before measurement)"],
    },
  ];

  for (const variant of ["operatePresentation", "operatePresentationControls"] as const) {
    for (const scenario of scenarios) {
      const durations: number[] = [];
      const statementCounts: number[] = [];
      const operationId = `presentation-bench-${scenario.action}`;
      const action = scenario.actionToRun;
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
            if (
              variant === "operatePresentationControls" &&
              scenario.action === "replay" &&
              unavailableRuns === 40
            ) {
              cleanupTestDb();
            }
            return;
          }
          // Reset and fixture work are outside the measured operation.
          await resetFixture();
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
            if (variant === "operatePresentationControls" && scenario.action === "replay") {
              cleanupTestDb();
            }
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
