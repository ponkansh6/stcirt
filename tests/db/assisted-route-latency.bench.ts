import { bench, describe, vi } from "vitest";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

const IDS = {
  eligibleOwner: 711,
  ownerWithoutSubmission: 712,
  proxyOwner: 713,
  proxyTarget: 718,
  incompleteOwner: 714,
  incompleteTarget: 715,
  completeOwner: 716,
  completeTarget: 717,
} as const;
const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 20;
const URL = "http://localhost/api/participants/assisted";

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

function emitResult(result: Record<string, unknown>) {
  const json = JSON.stringify(result);
  process.stdout.write(`${json}\n`);
  const outputPath = process.env.ASSISTED_ROUTE_BENCH_OUTPUT;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    appendFileSync(outputPath, `${json}\n`, "utf8");
  }
}

describe("assisted participant status local SQLite latency benchmark", () => {
  let testDb: TestDb | null = null;
  let logger: SqlLogger | null = null;
  let handler: RouteHandler | null = null;
  let cookies = new Map<number, string>();
  let initialization: Promise<void> | null = null;
  let cleaned = false;

  async function ensureInitialized() {
    initialization ??= (async () => {
      vi.stubEnv("PARTICIPANT_SESSION_SECRET", "assisted-route-bench-secret-value-32-bytes");
      vi.stubEnv("PARTICIPANT_PIN", "0123");
      const activeLogger = createSqlLogger();
      const activeTestDb = await createTestDb({ logger: activeLogger });
      testDb = activeTestDb;
      logger = activeLogger;
      dbRef.db = activeTestDb.db;
      process.once("exit", cleanup);
      await seedFixture();

      for (const participantId of Object.values(IDS)) {
        const token = createParticipantSession(participantId, 60 * 60);
        assert.ok(token, "Participant cookie must be created for the local route benchmark");
        cookies.set(participantId, `stcirt_participant_session=${token.value}`);
      }
      const route = await import("@/app/api/participants/assisted/route");
      handler = route.GET;
      activeLogger.reset();
    })();
    await initialization;
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    assert.ok(logger, "Count-only SQL logger must be initialized");
    assert.ok(handler, "Assisted participant route handler must be initialized");
  }

  async function seedFixture() {
    assert.ok(testDb, "File-backed benchmark database must be initialized");
    const participantRows = Object.entries(IDS).map(([role, id]) => ({
      id,
      normalizedName: `assisted-route-${role}`,
      displayName: `Assisted route ${role}`,
    }));
    await testDb.db.insert(schema.examParticipants).values(participantRows);
    await testDb.db.insert(schema.assistedParticipants).values([
      { ownerParticipantId: IDS.proxyOwner, targetParticipantId: IDS.proxyTarget },
      { ownerParticipantId: IDS.incompleteOwner, targetParticipantId: IDS.incompleteTarget },
      { ownerParticipantId: IDS.completeOwner, targetParticipantId: IDS.completeTarget },
    ]);
    await testDb.db.insert(schema.examAnswerSubmissions).values(
      [
        IDS.eligibleOwner,
        IDS.proxyOwner,
        IDS.proxyTarget,
        IDS.incompleteOwner,
        IDS.completeOwner,
        IDS.completeTarget,
      ].map((participantId, index) => ({
        id: `assisted-route-submission-${index}`,
        participantId,
        questionIds: [1, 2, 3, 4, 5],
        revision: 1,
      })),
    );
  }

  function cleanup() {
    if (cleaned || !testDb) return;
    cleaned = true;
    testDb.cleanup();
    testDb = null;
    dbRef.db = null;
    cookies = new Map();
    vi.unstubAllEnvs();
  }

  type ExpectedBody =
    | { participant: null; hasSubmission: false; eligible: boolean }
    | { participant: { id: number; name: string }; hasSubmission: boolean; eligible: false }
    | { error: string };
  type Scenario = {
    name: string;
    participantId?: number;
    status: number;
    body: ExpectedBody;
  };
  const scenarios: Scenario[] = [
    {
      name: "eligible-owner",
      participantId: IDS.eligibleOwner,
      status: 200,
      body: { participant: null, hasSubmission: false, eligible: true },
    },
    {
      name: "owner-without-submission",
      participantId: IDS.ownerWithoutSubmission,
      status: 200,
      body: { participant: null, hasSubmission: false, eligible: false },
    },
    {
      name: "owner-as-proxy",
      participantId: IDS.proxyTarget,
      status: 200,
      body: { participant: null, hasSubmission: false, eligible: false },
    },
    {
      name: "linked-target-incomplete",
      participantId: IDS.incompleteOwner,
      status: 200,
      body: {
        participant: { id: IDS.incompleteTarget, name: "Assisted route incompleteTarget" },
        hasSubmission: false,
        eligible: false,
      },
    },
    {
      name: "linked-target-complete",
      participantId: IDS.completeOwner,
      status: 200,
      body: {
        participant: { id: IDS.completeTarget, name: "Assisted route completeTarget" },
        hasSubmission: true,
        eligible: false,
      },
    },
    {
      name: "unauthenticated-boundary",
      status: 401,
      body: { error: "Participant session required" },
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
        assert.ok(logger && handler);
        logger.reset();
        invocation += 1;
        const cookie =
          scenario.participantId === undefined ? undefined : cookies.get(scenario.participantId);
        const request = new Request(URL, {
          headers: cookie ? { cookie } : undefined,
        });
        const startedAt = performance.now();
        const response = await handler(request);
        const elapsedMs = performance.now() - startedAt;
        const sqlStatements = logger.count();
        assert.equal(response.status, scenario.status, `${scenario.name} status contract`);
        assert.equal(
          response.headers.get("Cache-Control"),
          "private, no-store",
          `${scenario.name} must not be cached`,
        );
        assert.deepEqual(await response.json(), scenario.body, `${scenario.name} body contract`);
        if (scenario.status === 200) {
          assert.ok(sqlStatements > 0, `${scenario.name} must execute SQL`);
        } else {
          assert.equal(sqlStatements, 0, "Unauthenticated requests must fail before SQL access");
        }
        if (invocation <= WARMUP_SAMPLES) return;

        durations.push(elapsedMs);
        statementCounts.push(sqlStatements);
        if (durations.length === MEASURED_SAMPLES) {
          emitResult({
            benchmark: "assisted-route-latency-local",
            scenario: scenario.name,
            samples: MEASURED_SAMPLES,
            warmupSamples: WARMUP_SAMPLES,
            durationMs: {
              p50: percentile(durations, 50),
              p95: percentile(durations, 95),
            },
            sqlStatements: {
              p50: percentile(statementCounts, 50),
              p95: percentile(statementCounts, 95),
            },
            timingScope:
              "warm in-process GET handler over a migration-backed local file SQLite fixture; not remote RTT or same-snapshot proof",
            sqlMetricScope:
              "count-only Drizzle statements; SQL text and bound values are never emitted",
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
