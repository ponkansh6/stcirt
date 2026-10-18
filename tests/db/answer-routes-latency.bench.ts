import { bench, describe, vi } from "vitest";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import type { Logger } from "drizzle-orm/logger";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";
import { createParticipantSession } from "@/lib/participants/security";

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
type RouteHandler = (request: Request) => Promise<Response>;
type Scenario = {
  name: string;
  handler: "assistedStatus" | "answersLatest" | "answersBatch" | "participantResults";
  url: string;
  visible?: boolean;
};

function assertScenarioResponse(scenario: Scenario, response: Response, body: unknown) {
  assert.equal(response.status, 200, `${scenario.name} must return successfully`);
  const data = body as Record<string, unknown>;
  if (scenario.name === "assisted-status/owner") {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(data, {
      participant: { id: ASSISTED_ID, name: "Bench assisted" },
      hasSubmission: true,
      eligible: false,
    });
    return;
  }
  if (scenario.name.startsWith("answers-latest/")) {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const assisted = scenario.name.endsWith("assisted");
    assert.ok(data.submission !== null && typeof data.submission === "object");
    const submission = data.submission as Record<string, unknown>;
    assert.equal(submission.submissionId, assisted ? ASSISTED_SUBMISSION_ID : OWNER_SUBMISSION_ID);
    assert.equal(submission.revision, assisted ? 5 : 4);
    assert.deepEqual(
      submission.answers,
      QUESTION_IDS.map((questionId, index) => ({
        questionId,
        answerKind: index === 4 ? "freeText" : "selected",
        selectedIndex: index === 4 ? null : assisted ? 1 : 0,
        freeText: index === 4 ? `Response ${assisted ? ASSISTED_ID : OWNER_ID}` : null,
      })),
    );
    return;
  }
  if (scenario.name.startsWith("answers-batch-get/")) {
    const assisted = scenario.name.endsWith("assisted");
    assert.equal(data.submissionId, assisted ? ASSISTED_SUBMISSION_ID : OWNER_SUBMISSION_ID);
    assert.equal(data.revision, assisted ? 5 : 4);
    assert.equal(data.resultsVisible, false);
    assert.deepEqual(
      data.answers,
      QUESTION_IDS.map((questionId, index) => ({
        questionId,
        answerKind: index === 4 ? "freeText" : "selected",
        selectedIndex: index === 4 ? null : assisted ? 1 : 0,
        freeText: index === 4 ? `Response ${assisted ? ASSISTED_ID : OWNER_ID}` : null,
      })),
    );
    return;
  }

  assert.equal(response.headers.get("cache-control"), "private, no-store");
  if (!scenario.visible) {
    assert.deepEqual(data, { state: "waiting" });
    return;
  }
  const assisted = scenario.name.includes("assisted");
  assert.equal(data.state, "visible");
  assert.equal(data.rank, assisted ? 2 : 1);
  assert.equal(data.score, assisted ? 0 : 1);
  assert.deepEqual(data.questions, [
    {
      position: 0,
      question: "Benchmark result question",
      answer: {
        kind: "selected",
        value: assisted ? "B" : "A",
        correctness: assisted ? "incorrect" : "correct",
      },
    },
  ]);
  assert.equal("participantId" in data, false, "Public results must not expose participant IDs");
}

const OWNER_ID = 701;
const ASSISTED_ID = 702;
const QUESTION_IDS = [101, 102, 103, 104, 105];
const QUESTION_VERSIONS = [
  "nagano-001-v1",
  "nagano-002-v1",
  "nagano-003-v1",
  "nagano-004-v1",
  "tamami-egg-v1",
];
const OWNER_SUBMISSION_ID = "00000000-0000-4000-8000-000000000701";
const ASSISTED_SUBMISSION_ID = "00000000-0000-4000-8000-000000000702";
const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 20;

function createSqlLogger(): SqlLogger {
  let statementCount = 0;
  return {
    logQuery() {
      // Keep only a count; SQL text and bound values can contain private data.
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
  const outputPath = process.env.ANSWER_ROUTES_BENCH_OUTPUT;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    appendFileSync(outputPath, `${json}\n`, "utf8");
  }
}

describe("answer route local SQLite latency benchmark", () => {
  let testDb: TestDb | null = null;
  let logger: SqlLogger | null = null;
  let handlers: Record<string, RouteHandler> | null = null;
  let cookieHeader = "";
  let initialization: Promise<void> | null = null;
  let cleaned = false;

  async function ensureInitialized() {
    initialization ??= (async () => {
      vi.stubEnv("PARTICIPANT_SESSION_SECRET", "answer-route-bench-secret-value-32-bytes");
      vi.stubEnv("PARTICIPANT_PIN", "0123");
      const activeLogger = createSqlLogger();
      const activeTestDb = await createTestDb({ logger: activeLogger });
      testDb = activeTestDb;
      logger = activeLogger;
      dbRef.db = activeTestDb.db;

      await seedFixture();
      const token = createParticipantSession(OWNER_ID, 60 * 60);
      assert.ok(token, "Participant cookie must be created for the local route benchmark");
      cookieHeader = `stcirt_participant_session=${token.value}`;
      const [assisted, latest, batch, results] = await Promise.all([
        import("@/app/api/participants/assisted/route"),
        import("@/app/api/answers/latest/route"),
        import("@/app/api/answers/batch/route"),
        import("@/app/api/participants/results/route"),
      ]);
      handlers = {
        assistedStatus: assisted.GET,
        answersLatest: latest.GET,
        answersBatch: batch.GET,
        participantResults: results.GET,
      };
      process.once("exit", cleanup);
      activeLogger.reset();
    })();
    await initialization;
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    assert.ok(logger, "Count-only SQL logger must be initialized");
    assert.ok(handlers, "Answer route handlers must be initialized");
  }

  async function seedFixture() {
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    await testDb.db.insert(schema.examParticipants).values([
      { id: OWNER_ID, normalizedName: "bench-owner", displayName: "Bench owner" },
      { id: ASSISTED_ID, normalizedName: "bench-assisted", displayName: "Bench assisted" },
    ]);
    await testDb.db.insert(schema.assistedParticipants).values({
      ownerParticipantId: OWNER_ID,
      targetParticipantId: ASSISTED_ID,
    });
    await testDb.db.insert(schema.examQuestions).values(
      QUESTION_IDS.map((id, index) => ({
        id,
        key: `answer-route-bench-${id}`,
        questionVersion: QUESTION_VERSIONS[index]!,
        question: `Benchmark question ${index + 1}`,
        choices: index === 4 ? [] : ["A", "B", "C", "D"],
        correctIndex: 0,
        explanation: null,
      })),
    );

    const submissionRows = [
      { id: OWNER_SUBMISSION_ID, participantId: OWNER_ID, revision: 4 },
      { id: ASSISTED_SUBMISSION_ID, participantId: ASSISTED_ID, revision: 5 },
    ];
    await testDb.db.insert(schema.examAnswerSubmissions).values(
      submissionRows.map(({ id, participantId, revision }) => ({
        id,
        participantId,
        questionIds: QUESTION_IDS,
        questionVersions: Object.fromEntries(
          QUESTION_IDS.map((questionId, index) => [String(questionId), QUESTION_VERSIONS[index]!]),
        ),
        revision,
      })),
    );
    await testDb.db.insert(schema.examSubmissionAnswers).values(
      submissionRows.flatMap(({ id, participantId }) =>
        QUESTION_IDS.map((questionId, index) => ({
          submissionId: id,
          questionId,
          answerKind: index === 4 ? "freeText" : "selected",
          selectedIndex: index === 4 ? null : participantId === OWNER_ID ? 0 : 1,
          freeText: index === 4 ? `Response ${participantId}` : null,
        })),
      ),
    );

    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "finished",
      version: 1,
      questionIndex: 0,
      questionCount: 1,
      snapshotRevision: 1,
    });
    await testDb.db.insert(schema.presentationQuestions).values({
      sessionId: 1,
      position: 0,
      sourceQuestionId: QUESTION_IDS[0]!,
      question: "Benchmark result question",
      choices: ["A", "B"],
      correctIndex: 0,
      explanation: null,
    });
    await testDb.db.insert(schema.presentationEntries).values([
      {
        sessionId: 1,
        participantId: OWNER_ID,
        displayName: "Bench owner",
        score: 1,
        rank: 1,
        answers: [
          {
            questionId: QUESTION_IDS[0]!,
            answerKind: "selected",
            selectedIndex: 0,
            freeText: null,
            rawScore: 1,
            normalizedScore: 1,
          },
        ],
      },
      {
        sessionId: 1,
        participantId: ASSISTED_ID,
        displayName: "Bench assisted",
        score: 0,
        rank: 2,
        answers: [
          {
            questionId: QUESTION_IDS[0]!,
            answerKind: "selected",
            selectedIndex: 1,
            freeText: null,
            rawScore: 0,
            normalizedScore: 0,
          },
        ],
      },
    ]);
    await testDb.db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: false,
      everPublished: true,
    });
  }

  function cleanup() {
    if (cleaned || !testDb) return;
    cleaned = true;
    testDb.cleanup();
    testDb = null;
    dbRef.db = null;
    vi.unstubAllEnvs();
  }

  const scenarios: Scenario[] = [
    {
      name: "assisted-status/owner",
      handler: "assistedStatus",
      url: "http://localhost/api/participants/assisted",
    },
    {
      name: "answers-latest/owner",
      handler: "answersLatest",
      url: "http://localhost/api/answers/latest",
    },
    {
      name: "answers-latest/assisted",
      handler: "answersLatest",
      url: "http://localhost/api/answers/latest?scope=assisted",
    },
    {
      name: "answers-batch-get/owner",
      handler: "answersBatch",
      url: `http://localhost/api/answers/batch?submissionId=${OWNER_SUBMISSION_ID}`,
    },
    {
      name: "answers-batch-get/assisted",
      handler: "answersBatch",
      url: `http://localhost/api/answers/batch?scope=assisted&submissionId=${ASSISTED_SUBMISSION_ID}`,
    },
    {
      name: "participant-results/owner-private",
      handler: "participantResults",
      url: "http://localhost/api/participants/results",
      visible: false,
    },
    {
      name: "participant-results/assisted-private",
      handler: "participantResults",
      url: "http://localhost/api/participants/results?scope=assisted",
      visible: false,
    },
    {
      name: "participant-results/owner-visible",
      handler: "participantResults",
      url: "http://localhost/api/participants/results",
      visible: true,
    },
    {
      name: "participant-results/assisted-visible",
      handler: "participantResults",
      url: "http://localhost/api/participants/results?scope=assisted",
      visible: true,
    },
  ];

  for (const scenario of scenarios) {
    const durations: number[] = [];
    const statementCounts: number[] = [];
    let invocation = 0;
    bench(
      scenario.name,
      async () => {
        await ensureInitialized();
        assert.ok(testDb && logger && handlers);
        if (scenario.visible !== undefined) {
          await testDb.db
            .update(schema.participantResultSettings)
            .set({ visible: scenario.visible })
            .where(eq(schema.participantResultSettings.id, 1));
        }
        logger.reset();
        invocation += 1;
        const request = new Request(scenario.url, { headers: { cookie: cookieHeader } });
        const startedAt = performance.now();
        const response = await handlers[scenario.handler](request);
        const elapsedMs = performance.now() - startedAt;
        const sqlStatements = logger.count();
        const body = await response.json();
        assertScenarioResponse(scenario, response, body);
        assert.ok(sqlStatements > 0, `${scenario.name} must execute SQL`);
        if (invocation <= WARMUP_SAMPLES) return;

        durations.push(elapsedMs);
        statementCounts.push(sqlStatements);
        if (durations.length === MEASURED_SAMPLES) {
          emitResult({
            benchmark: "answer-route-latency-local",
            scenario: scenario.name,
            samples: MEASURED_SAMPLES,
            warmupSamples: WARMUP_SAMPLES,
            durationMs: {
              p50: percentile(durations, 50),
              p95: percentile(durations, 95),
            },
            sqlStatements: {
              mean: mean(statementCounts),
              p50: percentile(statementCounts, 50),
              p95: percentile(statementCounts, 95),
            },
            timingScope:
              "warm in-process route handlers over a local file-backed SQLite fixture; excludes HTTP, network, and remote Turso RTT",
            sqlMetricScope:
              "count-only Drizzle statements; SQL text and bound values are not emitted",
          });
        }
      },
      {
        time: 0,
        iterations: WARMUP_SAMPLES + MEASURED_SAMPLES,
        warmupIterations: 0,
        warmupTime: 0,
      },
    );
  }
});
