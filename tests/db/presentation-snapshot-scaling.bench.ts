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

type SqlLogger = Logger & { reset(): void; count(): number };
type Aggregate = (operationId: string, action: "aggregate") => Promise<unknown>;
type Dataset = { participants: number; submissionsPerParticipant: number };
type PersistedAnswer = {
  submissionId: string;
  questionId: number;
  selectedIndex: number | null;
  freeText: string | null;
  answerKind: "selected" | "freeText" | "legacy";
};

const QUESTION_IDS = [11, 22, 33, 44, 55];
const WARMUP_SAMPLES = 2;

function createSqlLogger(): SqlLogger {
  let statementCount = 0;
  return {
    logQuery() {
      // Count only; SQL text and bound parameters are intentionally discarded.
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

function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  return Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2));
}

function emitResult(result: Record<string, unknown>) {
  const json = JSON.stringify(result);
  process.stdout.write(`${json}\n`);
  const outputPath = process.env.PRESENTATION_SNAPSHOT_BENCH_OUTPUT;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    appendFileSync(outputPath, `${json}\n`, "utf8");
  }
}

describe("presentation snapshot scaling benchmark", () => {
  let testDb: TestDb | null = null;
  let logger: SqlLogger | null = null;
  let aggregatePresentation: Aggregate | null = null;
  let initialization: Promise<void> | null = null;
  let cleaned = false;

  async function ensureInitialized() {
    initialization ??= (async () => {
      const activeLogger = createSqlLogger();
      const activeTestDb = await createTestDb({ logger: activeLogger });
      testDb = activeTestDb;
      logger = activeLogger;
      dbRef.db = activeTestDb.db;
      aggregatePresentation = (await import("@/lib/db/repository/presentation-repository"))
        .operatePresentation;
      process.once("exit", cleanup);
      activeLogger.reset();
    })();
    await initialization;
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    assert.ok(logger, "Count-only SQL logger must be initialized");
    assert.ok(aggregatePresentation, "Presentation aggregate operation must be initialized");
  }

  function cleanup() {
    if (cleaned || !testDb) return;
    cleaned = true;
    testDb.cleanup();
    testDb = null;
    dbRef.db = null;
  }

  async function prepareDataset(dataset: Dataset) {
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    const { db } = testDb;
    await db.delete(schema.presentationOperations);
    await db.delete(schema.presentationEntries);
    await db.delete(schema.presentationQuestions);
    await db.delete(schema.presentationSessions);
    await db.delete(schema.examAnswerAssessments);
    await db.delete(schema.examSubmissionOperations);
    await db.delete(schema.examSubmissionAnswers);
    await db.delete(schema.examAnswerSubmissions);
    await db.delete(schema.examAnswerLogs);
    await db.delete(schema.examParticipants);
    await db.delete(schema.examQuestions);

    await db.insert(schema.examQuestions).values(
      QUESTION_IDS.map((id, index) => ({
        id,
        key: index === 4 ? "it-literacy-005" : `snapshot-bench-question-${id}`,
        question: `Snapshot benchmark question ${index + 1}`,
        choices: index === 4 ? [] : ["A", "B", "C", "D"],
        correctIndex: 0,
        explanation: null,
      })),
    );

    const participantRows = Array.from({ length: dataset.participants }, (_, index) => {
      const id = index + 1;
      return {
        id,
        normalizedName: `snapshot-bench-${id}`,
        displayName: `Snapshot participant ${id}`,
      };
    });
    await db.insert(schema.examParticipants).values(participantRows);

    const submissionRows: (typeof schema.examAnswerSubmissions.$inferInsert)[] = [];
    const answerRows: PersistedAnswer[] = [];
    const assessmentRows: (typeof schema.examAnswerAssessments.$inferInsert)[] = [];
    let olderValidNewerIncompleteCount = 0;
    let eligibleLegacyQ5Count = 0;
    let eligibleGradedQ5Count = 0;

    for (const participant of participantRows) {
      const isOlderValidPair = dataset.submissionsPerParticipant > 1 && participant.id % 3 === 0;
      const selectedSubmissionIndex = isOlderValidPair ? 0 : dataset.submissionsPerParticipant - 1;
      if (isOlderValidPair) olderValidNewerIncompleteCount += 1;
      const q5IsGraded = participant.id % 3 === 2;
      if (q5IsGraded) eligibleGradedQ5Count += 1;
      else eligibleLegacyQ5Count += 1;

      for (
        let submissionIndex = 0;
        submissionIndex < dataset.submissionsPerParticipant;
        submissionIndex += 1
      ) {
        const revision = submissionIndex + 1;
        const submissionId = `snapshot-bench-${participant.id}-${revision}`;
        const isEligible = submissionIndex === selectedSubmissionIndex;
        submissionRows.push({
          id: submissionId,
          participantId: participant.id,
          questionIds: QUESTION_IDS,
          revision,
        });

        for (const [questionIndex, questionId] of QUESTION_IDS.entries()) {
          if (!isEligible && questionIndex === 4) continue;
          if (questionIndex === 4) {
            if (q5IsGraded) {
              answerRows.push({
                submissionId,
                questionId,
                answerKind: "freeText",
                selectedIndex: null,
                freeText: `Graded response ${participant.id}`,
              });
              if (isEligible) {
                assessmentRows.push({
                  submissionId,
                  questionId,
                  revision,
                  answerText: `Graded response ${participant.id}`,
                  state: "graded",
                  rawScore: 1,
                  normalizedScore: 1,
                  rubricVersion: "snapshot-bench-v1",
                });
              }
            } else {
              answerRows.push({
                submissionId,
                questionId,
                answerKind: "legacy",
                selectedIndex: 0,
                freeText: null,
              });
            }
            continue;
          }
          answerRows.push({
            submissionId,
            questionId,
            answerKind: "selected",
            selectedIndex: (participant.id + questionIndex) % 4,
            freeText: null,
          });
        }
      }
    }

    await db.insert(schema.examAnswerSubmissions).values(submissionRows);
    const answerChunkSize = 400;
    for (let offset = 0; offset < answerRows.length; offset += answerChunkSize) {
      await db
        .insert(schema.examSubmissionAnswers)
        .values(answerRows.slice(offset, offset + answerChunkSize));
    }
    if (assessmentRows.length) {
      await db.insert(schema.examAnswerAssessments).values(assessmentRows);
    }

    assert.equal(submissionRows.length, dataset.participants * dataset.submissionsPerParticipant);
    return {
      totalSubmissions: submissionRows.length,
      totalAnswerRows: answerRows.length,
      eligibleCompleteSubmissions: dataset.participants,
      olderValidNewerIncompleteParticipants: olderValidNewerIncompleteCount,
      eligibleLegacyQ5Submissions: eligibleLegacyQ5Count,
      eligibleSameRevisionGradedQ5Submissions: eligibleGradedQ5Count,
    };
  }

  const datasets: Array<{ dimensions: Dataset; samples: number }> = [
    { dimensions: { participants: 10, submissionsPerParticipant: 1 }, samples: 20 },
    { dimensions: { participants: 10, submissionsPerParticipant: 2 }, samples: 20 },
    { dimensions: { participants: 10, submissionsPerParticipant: 5 }, samples: 20 },
    { dimensions: { participants: 100, submissionsPerParticipant: 1 }, samples: 20 },
    { dimensions: { participants: 100, submissionsPerParticipant: 2 }, samples: 20 },
    { dimensions: { participants: 100, submissionsPerParticipant: 5 }, samples: 20 },
    { dimensions: { participants: 500, submissionsPerParticipant: 1 }, samples: 20 },
    { dimensions: { participants: 500, submissionsPerParticipant: 2 }, samples: 20 },
    { dimensions: { participants: 500, submissionsPerParticipant: 5 }, samples: 20 },
  ];

  for (const { dimensions, samples } of datasets) {
    const durations: number[] = [];
    const statementCounts: number[] = [];
    let invocation = 0;
    let fixtureMix: Awaited<ReturnType<typeof prepareDataset>> | null = null;
    bench(
      `${dimensions.participants}-participants/${dimensions.submissionsPerParticipant}-submissions-each`,
      async () => {
        await ensureInitialized();
        assert.ok(testDb && logger && aggregatePresentation);
        fixtureMix ??= await prepareDataset(dimensions);
        logger.reset();
        invocation += 1;
        const operationId = `snapshot-scale-${dimensions.participants}-${dimensions.submissionsPerParticipant}-${invocation}`;
        const startedAt = performance.now();
        const snapshot = await aggregatePresentation(operationId, "aggregate");
        const elapsedMs = performance.now() - startedAt;
        const sqlStatements = logger.count();
        assert.ok(snapshot !== null && typeof snapshot === "object");
        assert.ok(sqlStatements > 0, "Aggregation must execute SQL statements");

        const result = snapshot as { questions?: unknown[]; entries?: unknown[] };
        assert.equal(result.questions?.length, QUESTION_IDS.length);
        assert.equal(result.entries?.length, dimensions.participants);
        if (invocation <= WARMUP_SAMPLES) return;

        durations.push(elapsedMs);
        statementCounts.push(sqlStatements);
        if (durations.length === samples) {
          emitResult({
            benchmark: "presentation-snapshot-scaling-local",
            algorithm: "current presentation repository aggregation",
            dataset: {
              participants: dimensions.participants,
              submissionsPerParticipant: dimensions.submissionsPerParticipant,
              ...fixtureMix,
            },
            sampleCount: durations.length,
            warmupSamples: WARMUP_SAMPLES,
            totalAggregateTimeMs: {
              p50: percentile(durations, 50),
              p95: percentile(durations, 95),
            },
            sqlStatements: {
              mean: mean(statementCounts),
              p50: percentile(statementCounts, 50),
              p95: percentile(statementCounts, 95),
            },
            timingScope:
              "warm repository aggregation over a local file-backed SQLite fixture; remote Turso RTT and user-perceived waiting are not measured",
            stateScope:
              "each aggregate invocation mutates the presentation snapshot/revision; measured samples do not use identical database state",
            sqlMetricScope:
              "count-only Drizzle statements; SQL text and bound values are not emitted",
          });
        }
      },
      {
        time: 0,
        iterations: WARMUP_SAMPLES + samples,
        warmupIterations: 0,
        warmupTime: 0,
      },
    );
  }
});
