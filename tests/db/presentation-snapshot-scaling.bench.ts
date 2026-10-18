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
const QUESTION_VERSIONS = [
  "nagano-001-v1",
  "nagano-002-v1",
  "nagano-003-v1",
  "nagano-004-v1",
  "tamami-egg-v1",
];
const Q5_RUBRIC_VERSION = "jev-q5-fulfillment-v3-02";
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
        questionVersion: QUESTION_VERSIONS[index]!,
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
    let eligibleGradedQ5Count = 0;

    for (const participant of participantRows) {
      const isOlderValidPair = dataset.submissionsPerParticipant > 1 && participant.id % 3 === 0;
      const selectedSubmissionIndex = isOlderValidPair ? 0 : dataset.submissionsPerParticipant - 1;
      if (isOlderValidPair) olderValidNewerIncompleteCount += 1;
      eligibleGradedQ5Count += 1;

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
          questionVersions: Object.fromEntries(
            QUESTION_IDS.map((questionId, questionIndex) => [
              String(questionId),
              QUESTION_VERSIONS[questionIndex]!,
            ]),
          ),
          revision,
        });

        for (const [questionIndex, questionId] of QUESTION_IDS.entries()) {
          if (!isEligible && questionIndex === 4) continue;
          if (questionIndex === 4) {
            answerRows.push({
              submissionId,
              questionId,
              answerKind: "freeText",
              selectedIndex: null,
              freeText: `Graded response ${participant.id} revision ${revision}`,
            });
            if (isEligible) {
              assessmentRows.push({
                submissionId,
                questionId,
                revision,
                answerText: `Graded response ${participant.id} revision ${revision}`,
                questionVersion: QUESTION_VERSIONS[4]!,
                state: "graded",
                rawScore: 9,
                normalizedScore: 1,
                rubricVersion: Q5_RUBRIC_VERSION,
              });
            }
            continue;
          }
          answerRows.push({
            submissionId,
            questionId,
            answerKind: "selected",
            selectedIndex: (participant.id + questionIndex + revision) % 4,
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
      eligibleLegacyQ5Submissions: 0,
      eligibleSameRevisionGradedQ5Submissions: eligibleGradedQ5Count,
    };
  }

  async function resetPresentationSide() {
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    const { db } = testDb;
    // Keep the seeded source questions, participants, and submissions intact.
    // Delete children before the session row to respect the fixture's FK order.
    await db.delete(schema.presentationOperations);
    await db.delete(schema.presentationEntries);
    await db.delete(schema.presentationQuestions);
    await db.delete(schema.presentationSessions);
  }

  async function assertSnapshotContent(dataset: Dataset) {
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    const questions = await testDb.db
      .select()
      .from(schema.presentationQuestions)
      .orderBy(schema.presentationQuestions.position);
    assert.deepEqual(
      questions,
      QUESTION_IDS.map((id, position) => ({
        sessionId: 1,
        position,
        sourceQuestionId: id,
        question: `Snapshot benchmark question ${position + 1}`,
        choices: position === 4 ? [] : ["A", "B", "C", "D"],
        correctIndex: 0,
        explanation: null,
      })),
      "Aggregate must persist the exact seeded question projection",
    );

    const entries = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .orderBy(schema.presentationEntries.participantId);
    const expectedEntries = Array.from({ length: dataset.participants }, (_, index) => {
      const participantId = index + 1;
      const selectedRevision =
        dataset.submissionsPerParticipant > 1 && participantId % 3 === 0
          ? 1
          : dataset.submissionsPerParticipant;
      const answers = QUESTION_IDS.map((questionId, questionIndex) => ({
        questionId,
        answerKind: questionIndex === 4 ? "freeText" : "selected",
        selectedIndex:
          questionIndex === 4 ? null : (participantId + questionIndex + selectedRevision) % 4,
        freeText:
          questionIndex === 4
            ? `Graded response ${participantId} revision ${selectedRevision}`
            : null,
        rawScore: questionIndex === 4 ? 9 : null,
        normalizedScore: questionIndex === 4 ? 1 : null,
      }));
      const score = answers.reduce(
        (total, answer, questionIndex) =>
          total + (questionIndex === 4 ? 1 : Number(answer.selectedIndex === 0)),
        0,
      );
      return {
        participantId,
        displayName: `Snapshot participant ${participantId}`,
        answers,
        score,
      };
    }).sort((left, right) => right.score - left.score || left.participantId - right.participantId);
    let previousScore: number | undefined;
    let previousRank = 0;
    const rows = expectedEntries
      .map((entry, index) => {
        if (entry.score !== previousScore) previousRank = index + 1;
        previousScore = entry.score;
        return { sessionId: 1, ...entry, rank: previousRank };
      })
      .sort((left, right) => left.participantId - right.participantId);
    assert.deepEqual(
      entries,
      rows,
      "Aggregate must persist exact expected participant rows and answer projections",
    );
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
        await resetPresentationSide();
        invocation += 1;
        const operationId = `snapshot-scale-${dimensions.participants}-${dimensions.submissionsPerParticipant}-${invocation}`;
        logger.reset();
        const startedAt = performance.now();
        const snapshot = await aggregatePresentation(operationId, "aggregate");
        const elapsedMs = performance.now() - startedAt;
        const sqlStatements = logger.count();
        assert.ok(snapshot !== null && typeof snapshot === "object");
        assert.ok(sqlStatements > 0, "Aggregation must execute SQL statements");

        const result = snapshot as { snapshotRevision?: unknown; questionCount?: unknown };
        assert.ok(typeof result.snapshotRevision === "number" && result.snapshotRevision > 0);
        assert.equal(result.questionCount, QUESTION_IDS.length);
        await assertSnapshotContent(dimensions);
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
              "every warmup and measured aggregation starts from the same presentation-side state; seeded source data is reused",
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
