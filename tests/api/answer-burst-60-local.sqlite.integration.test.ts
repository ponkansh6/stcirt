import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";

const dbRef = vi.hoisted(() => ({ db: null as TestDb["db"] | null }));
const retryHarness = vi.hoisted(() => ({
  runSeed: 0,
  randomState: 0,
  events: [] as Array<{
    phase: "preflight_read" | "write_transaction" | "recovery_read";
    retryNumber: number;
    capMs: number;
    delayMs: number;
  }>,
  invocationWaitTotalsMs: [] as number[],
  invocationPhaseWaitTotalsMs: {
    preflight_read: [] as number[],
    write_transaction: [] as number[],
    recovery_read: [] as number[],
  },
  reset(seed: number) {
    this.runSeed = seed;
    this.randomState = seed >>> 0 || 1;
    this.events = [];
    this.invocationWaitTotalsMs = [];
    this.invocationPhaseWaitTotalsMs = {
      preflight_read: [],
      write_transaction: [],
      recovery_read: [],
    };
  },
  random() {
    // xorshift32: deterministic across requests, without replacing global randomness.
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 0x1_0000_0000;
  },
  record(event: {
    phase: "preflight_read" | "write_transaction" | "recovery_read";
    retryNumber: number;
    capMs: number;
    delayMs: number;
  }) {
    if (
      ["preflight_read", "write_transaction", "recovery_read"].includes(event.phase) &&
      Number.isInteger(event.retryNumber) &&
      Number.isInteger(event.capMs) &&
      Number.isInteger(event.delayMs) &&
      event.retryNumber > 0 &&
      event.capMs > 0 &&
      event.delayMs >= 0
    ) {
      this.events.push({
        phase: event.phase,
        retryNumber: event.retryNumber,
        capMs: event.capMs,
        delayMs: event.delayMs,
      });
      return true;
    }
    return false;
  },
  recordInvocation(
    totalWaitMs: number,
    phaseWaitMs: Record<"preflight_read" | "write_transaction" | "recovery_read", number>,
  ) {
    this.invocationWaitTotalsMs.push(totalWaitMs);
    for (const phase of ["preflight_read", "write_transaction", "recovery_read"] as const) {
      this.invocationPhaseWaitTotalsMs[phase].push(phaseWaitMs[phase]);
    }
  },
  snapshot() {
    const percentile = (sorted: number[], fraction: number) =>
      sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
    const summarize = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      return {
        count: sorted.length,
        minMs: sorted[0] ?? null,
        maxMs: sorted.at(-1) ?? null,
        meanMs:
          sorted.length === 0
            ? null
            : Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(2)),
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        histogramByWaitMs: Object.fromEntries(
          [...new Set(sorted)].map((waitMs) => [
            String(waitMs),
            sorted.filter((value) => value === waitMs).length,
          ]),
        ),
      };
    };
    const aggregate = (byPhase: boolean) => {
      const groups = new Map<
        string,
        {
          phase?: "preflight_read" | "write_transaction" | "recovery_read";
          retryNumber: number;
          capMs: number;
          delays: number[];
        }
      >();
      for (const event of this.events) {
        const key = `${byPhase ? `${event.phase}:` : ""}${event.retryNumber}:${event.capMs}`;
        const group = groups.get(key) ?? {
          ...(byPhase ? { phase: event.phase } : {}),
          retryNumber: event.retryNumber,
          capMs: event.capMs,
          delays: [],
        };
        group.delays.push(event.delayMs);
        groups.set(key, group);
      }
      return [...groups.values()]
        .sort((left, right) =>
          left.phase === right.phase
            ? left.retryNumber - right.retryNumber
            : (left.phase ?? "").localeCompare(right.phase ?? ""),
        )
        .map(({ phase, retryNumber, capMs, delays }) => {
          const sorted = [...delays].sort((left, right) => left - right);
          const histogram = Object.fromEntries(
            [...new Set(sorted)].map((delay) => [
              String(delay),
              sorted.filter((value) => value === delay).length,
            ]),
          );
          return {
            ...(phase ? { phase } : {}),
            retryNumber,
            capMs,
            count: sorted.length,
            minMs: sorted[0] ?? null,
            maxMs: sorted.at(-1) ?? null,
            meanMs:
              sorted.length === 0
                ? null
                : Number(
                    (sorted.reduce((sum, delay) => sum + delay, 0) / sorted.length).toFixed(2),
                  ),
            p50Ms: percentile(sorted, 0.5),
            p95Ms: percentile(sorted, 0.95),
            histogramByDelayMs: histogram,
          };
        });
    };
    return {
      runSeed: this.runSeed,
      scheduledRetryCount: this.events.length,
      requestScheduledWaitMs: summarize(this.invocationWaitTotalsMs),
      requestScheduledWaitMsByPhase: {
        preflight_read: summarize(this.invocationPhaseWaitTotalsMs.preflight_read),
        write_transaction: summarize(this.invocationPhaseWaitTotalsMs.write_transaction),
        recovery_read: summarize(this.invocationPhaseWaitTotalsMs.recovery_read),
      },
      byRetryNumberAndCap: aggregate(false),
      byPhaseAndRetryNumberAndCap: aggregate(true),
    };
  },
}));
const clientRetryHarness = vi.hoisted(() => ({
  seed: 0,
  randomState: 0,
  events: [] as Array<{ retryNumber: number; capMs: number; delayMs: number }>,
  reset(seed: number) {
    this.seed = seed;
    this.randomState = seed >>> 0 || 1;
    this.events = [];
  },
  random() {
    // Keep client jitter on an independent deterministic stream from server retries.
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 0x1_0000_0000;
  },
  record(retryNumber: number, capMs: number, delayMs: number) {
    this.events.push({ retryNumber, capMs, delayMs });
  },
  snapshot(policy: "fixed" | "equal-jitter") {
    const groups = new Map<string, { retryNumber: number; capMs: number; delays: number[] }>();
    for (const event of this.events) {
      const key = `${event.retryNumber}:${event.capMs}`;
      const group = groups.get(key) ?? {
        retryNumber: event.retryNumber,
        capMs: event.capMs,
        delays: [],
      };
      group.delays.push(event.delayMs);
      groups.set(key, group);
    }
    const percentile = (sorted: number[], fraction: number) =>
      sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
    return {
      policy,
      clientSeed: this.seed,
      scheduledDelayCount: this.events.length,
      byRetryNumberAndCap: [...groups.values()]
        .sort((left, right) => left.retryNumber - right.retryNumber)
        .map(({ retryNumber, capMs, delays }) => {
          const sorted = [...delays].sort((left, right) => left - right);
          return {
            retryNumber,
            capMs,
            count: sorted.length,
            minMs: sorted[0] ?? null,
            maxMs: sorted.at(-1) ?? null,
            meanMs:
              sorted.length === 0
                ? null
                : Number(
                    (sorted.reduce((sum, delay) => sum + delay, 0) / sorted.length).toFixed(2),
                  ),
            p50Ms: percentile(sorted, 0.5),
            p95Ms: percentile(sorted, 0.95),
            histogramByDelayMs: Object.fromEntries(
              [...new Set(sorted)].map((delay) => [
                String(delay),
                sorted.filter((value) => value === delay).length,
              ]),
            ),
          };
        }),
    };
  },
}));

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

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

vi.mock("@/lib/db/repository/answer-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/repository/answer-repository")>();
  return {
    ...actual,
    saveAnswerSubmission: async (input: Parameters<typeof actual.saveAnswerSubmission>[0]) => {
      let totalWaitMs = 0;
      const phaseWaitMs = {
        preflight_read: 0,
        write_transaction: 0,
        recovery_read: 0,
      };
      try {
        return await actual.saveAnswerSubmission(input, {
          random: () => retryHarness.random(),
          onRetryScheduled: (event) => {
            if (retryHarness.record(event)) {
              totalWaitMs += event.delayMs;
              phaseWaitMs[event.phase] += event.delayMs;
            }
          },
        });
      } finally {
        retryHarness.recordInvocation(totalWaitMs, phaseWaitMs);
      }
    },
  };
});

vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: (request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  requestHasValidOrigin: (request: Request) =>
    request.headers.get("origin") === new URL(request.url).origin,
  verifyParticipantSession: (token?: string) => {
    const match = token?.match(/^local-burst-(\d+)$/);
    return match ? { id: Number(match[1]), expiresAt: new Date("2030-01-01") } : null;
  },
}));

import { POST } from "@/app/api/answers/batch/route";

const PARTICIPANT_COUNT = 60;
const FIRST_PARTICIPANT_ID = 10_000;
const QUESTION_IDS = [1, 2, 3, 4, 5];
const COMPRESSED_UNIFORM_INTERVAL_MS = 1_000;
const NOMINAL_UNIFORM_INTERVAL_MS = 30_000;
const NOMINAL_ARRIVAL_SPAN_MS = (PARTICIPANT_COUNT - 1) * NOMINAL_UNIFORM_INTERVAL_MS;
const COMPRESSED_ARRIVAL_SPAN_MS = (PARTICIPANT_COUNT - 1) * COMPRESSED_UNIFORM_INTERVAL_MS;
const SCHEDULE_ENV = "ANSWER_BURST_SCHEDULE";
const RANDOM_SEED_ENV = "ANSWER_BURST_RANDOM_SEED";
const DEFAULT_RANDOM_SEED = 83_001;
const CLIENT_RETRY_POLICY_ENV = "ANSWER_BURST_CLIENT_RETRY_POLICY";
const CLIENT_RANDOM_SEED_ENV = "ANSWER_BURST_CLIENT_RANDOM_SEED";
const DEFAULT_CLIENT_RANDOM_SEED = 83_002;
const CLIENT_EQUAL_JITTER_CAPS_MS = [250, 500, 1_000] as const;

type ClientRetryPolicy = "fixed" | "equal-jitter";

function getClientRetryPolicy(): ClientRetryPolicy {
  const configured = process.env[CLIENT_RETRY_POLICY_ENV] ?? "fixed";
  if (configured === "fixed" || configured === "equal-jitter") return configured;
  throw new Error(`${CLIENT_RETRY_POLICY_ENV} must be "fixed" or "equal-jitter"`);
}

// Set ANSWER_BURST_SCHEDULE=uniform-60-over-30m-compressed-30x to map the
// nominal 30-second cadence to 1-second intervals (30x compression, 59s span).

type ArrivalSchedule =
  | { name: "simultaneous-local"; offsetMs: (index: number) => number }
  | {
      name: "uniform-60-over-30m-compressed-30x-local";
      offsetMs: (index: number) => number;
    };

function getArrivalSchedule(): ArrivalSchedule {
  const configured = process.env[SCHEDULE_ENV];
  if (!configured || configured === "simultaneous") {
    return { name: "simultaneous-local", offsetMs: () => 0 };
  }
  if (configured === "uniform-60-over-30m-compressed-30x") {
    return {
      name: "uniform-60-over-30m-compressed-30x-local",
      offsetMs: (index) => index * COMPRESSED_UNIFORM_INTERVAL_MS,
    };
  }
  throw new Error(`${SCHEDULE_ENV} must be "simultaneous" or "uniform-60-over-30m-compressed-30x"`);
}

type BurstResult = {
  participantId: number;
  submissionId: string;
  operationId: string;
  body: string;
  response: Response;
};

function idFor(participantId: number, kind: "submission" | "operation") {
  const suffix = String(participantId).padStart(12, "0");
  return kind === "submission"
    ? `00000000-0000-4000-8000-${suffix}`
    : `10000000-0000-4000-8000-${suffix}`;
}

function makeRequest(participantId: number, body: string) {
  return new Request("http://localhost/api/answers/batch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      Cookie: `stcirt_participant_session=local-burst-${participantId}`,
    },
    body,
  });
}

describe("60-participant answer burst (isolated local SQLite diagnostic)", () => {
  let testDb: TestDb;
  let routeConsoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let diagnosticResult: Record<string, unknown> | null;

  beforeEach(async () => {
    diagnosticResult = null;
    const configuredSeed = Number(process.env[RANDOM_SEED_ENV] ?? DEFAULT_RANDOM_SEED);
    if (!Number.isSafeInteger(configuredSeed) || configuredSeed < 0) {
      throw new Error(`${RANDOM_SEED_ENV} must be a non-negative integer`);
    }
    retryHarness.reset(configuredSeed);
    const configuredClientSeed = Number(
      process.env[CLIENT_RANDOM_SEED_ENV] ?? DEFAULT_CLIENT_RANDOM_SEED,
    );
    if (!Number.isSafeInteger(configuredClientSeed) || configuredClientSeed < 0) {
      throw new Error(`${CLIENT_RANDOM_SEED_ENV} must be a non-negative integer`);
    }
    clientRetryHarness.reset(configuredClientSeed);
    getClientRetryPolicy();
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.insert(schema.examParticipants).values(
      Array.from({ length: PARTICIPANT_COUNT }, (_, index) => {
        const id = FIRST_PARTICIPANT_ID + index;
        return {
          id,
          normalizedName: `local-burst-${id}`,
          displayName: `Local burst ${index + 1}`,
        };
      }),
    );
    // createTestDb migrations seed exam questions 1–5; reuse those fixture rows.
    routeConsoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    routeConsoleErrorSpy?.mockRestore();
    const metricsPath = process.env.ANSWER_BURST_METRICS_FILE;
    if (metricsPath) {
      const result = diagnosticResult ?? {
        harness:
          "local SQLite integrity diagnostic only; does not simulate Turso service limits or production load",
        arrivalSchedule: { name: getArrivalSchedule().name },
        runSeed: retryHarness.runSeed,
        serverRetryDelayDistribution: retryHarness.snapshot(),
        clientRetryDelayDistribution: clientRetryHarness.snapshot(getClientRetryPolicy()),
        outcome: "incomplete",
        database: testDb?.metrics.snapshot() ?? null,
      };
      mkdirSync(dirname(metricsPath), { recursive: true });
      writeFileSync(metricsPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    dbRef.db = null;
    await testDb.cleanup();
  });

  it(
    "persists one unique five-answer submission per participant and replays idempotently",
    async () => {
      const arrivalSchedule = getArrivalSchedule();
      const submissions: Omit<BurstResult, "response">[] = Array.from(
        { length: PARTICIPANT_COUNT },
        (_, index) => {
          const participantId = FIRST_PARTICIPANT_ID + index;
          const submissionId = idFor(participantId, "submission");
          const operationId = idFor(participantId, "operation");
          return {
            participantId,
            submissionId,
            operationId,
            body: JSON.stringify({
              submissionId,
              operationId,
              expectedRevision: 0,
              answers: QUESTION_IDS.map((questionId) =>
                questionId === 5
                  ? { questionId, freeText: `Local burst response ${participantId}` }
                  : { questionId, selectedIndex: (index + questionId) % 4 },
              ),
            }),
          };
        },
      );

      // Both schedules exercise only this local SQLite harness, never a Turso deployment.
      const burstStartedAt = performance.now();
      const dbMetricsBeforeBurst = testDb.metrics.snapshot();
      const initialBurst = await Promise.all(
        submissions.map(async (submission) => {
          const scheduledArrivalOffsetMs = arrivalSchedule.offsetMs(
            submission.participantId - FIRST_PARTICIPANT_ID,
          );
          if (scheduledArrivalOffsetMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, scheduledArrivalOffsetMs));
          }
          const arrivedAt = performance.now();
          const response = await POST(makeRequest(submission.participantId, submission.body));
          return {
            ...submission,
            scheduledArrivalOffsetMs,
            arrivedAt,
            responseDurationMs: Number((performance.now() - arrivedAt).toFixed(2)),
            response,
          };
        }),
      );
      const burstDurationMs = Number((performance.now() - burstStartedAt).toFixed(2));
      const initialStatusCounts = initialBurst.reduce<Record<string, number>>((counts, result) => {
        counts[result.response.status] = (counts[result.response.status] ?? 0) + 1;
        return counts;
      }, {});
      const responseBodies = await Promise.all(
        initialBurst.map((result) =>
          result.response
            .clone()
            .json()
            .catch(() => null),
        ),
      );
      const initialDatabaseLockedCount = responseBodies.filter(
        (body, index) =>
          initialBurst[index]?.response.status === 503 &&
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          body.error === "DATABASE_LOCKED",
      ).length;
      const allowedInitialResponses = initialBurst.every(
        (entry, index) =>
          entry.response.status === 200 ||
          (entry.response.status === 503 &&
            responseBodies[index] !== null &&
            typeof responseBodies[index] === "object" &&
            "error" in responseBodies[index] &&
            responseBodies[index].error === "DATABASE_LOCKED"),
      );
      const retryCounts = new Map(submissions.map((submission) => [submission.participantId, 0]));
      const clientRetryPolicy = getClientRetryPolicy();
      const finalResponses = await Promise.all(
        initialBurst.map(async (entry, index) => {
          let response = entry.response;
          let body = responseBodies[index];
          for (let retry = 0; retry < 3; retry += 1) {
            const isDatabaseLocked =
              response.status === 503 &&
              body !== null &&
              typeof body === "object" &&
              "error" in body &&
              body.error === "DATABASE_LOCKED";
            if (!isDatabaseLocked) break;
            retryCounts.set(entry.participantId, (retryCounts.get(entry.participantId) ?? 0) + 1);
            const retryNumber = retry + 1;
            const capMs =
              clientRetryPolicy === "fixed"
                ? 25 * retryNumber
                : CLIENT_EQUAL_JITTER_CAPS_MS[retry]!;
            const delayMs =
              clientRetryPolicy === "fixed"
                ? capMs
                : Math.ceil(capMs / 2) +
                  Math.floor(clientRetryHarness.random() * (capMs - Math.ceil(capMs / 2) + 1));
            clientRetryHarness.record(retryNumber, capMs, delayMs);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            response = await POST(makeRequest(entry.participantId, entry.body));
            body = await response
              .clone()
              .json()
              .catch(() => null);
          }
          return {
            ...entry,
            response,
            responseBody: body,
            totalLatencyMs: Number((performance.now() - entry.arrivedAt).toFixed(2)),
          };
        }),
      );
      const dbMetricsAfterBurst = testDb.metrics.snapshot();
      const presentationSessionStatements = Object.fromEntries(
        Object.keys(dbMetricsAfterBurst.presentationSessionStatements).map((category) => [
          category,
          dbMetricsAfterBurst.presentationSessionStatements[
            category as keyof typeof dbMetricsAfterBurst.presentationSessionStatements
          ] -
            dbMetricsBeforeBurst.presentationSessionStatements[
              category as keyof typeof dbMetricsBeforeBurst.presentationSessionStatements
            ],
        ]),
      );
      const finalStatusCounts = finalResponses.reduce<Record<string, number>>((counts, result) => {
        counts[result.response.status] = (counts[result.response.status] ?? 0) + 1;
        return counts;
      }, {});
      const invalidInitialResponseCount = initialBurst.filter((entry, index) => {
        const body = responseBodies[index];
        const allowed =
          entry.response.status === 200 ||
          (entry.response.status === 503 &&
            body !== null &&
            typeof body === "object" &&
            "error" in body &&
            body.error === "DATABASE_LOCKED");
        return !allowed;
      }).length;
      const allowedFinalResponses = finalResponses.every(
        (entry) =>
          entry.response.status === 200 ||
          (entry.response.status === 503 &&
            entry.responseBody !== null &&
            typeof entry.responseBody === "object" &&
            "error" in entry.responseBody &&
            entry.responseBody.error === "DATABASE_LOCKED"),
      );
      const invalidFinalResponseCount = finalResponses.filter((entry) => {
        const allowed =
          entry.response.status === 200 ||
          (entry.response.status === 503 &&
            entry.responseBody !== null &&
            typeof entry.responseBody === "object" &&
            "error" in entry.responseBody &&
            entry.responseBody.error === "DATABASE_LOCKED");
        return !allowed;
      }).length;
      const finalDatabaseLockedCount = finalResponses.filter(
        (entry) =>
          entry.response.status === 503 &&
          entry.responseBody !== null &&
          typeof entry.responseBody === "object" &&
          "error" in entry.responseBody &&
          entry.responseBody.error === "DATABASE_LOCKED",
      ).length;
      const finalSuccessCount = finalResponses.filter(
        (entry) => entry.response.status === 200,
      ).length;
      const serverRetryDelayDistribution = retryHarness.snapshot();
      expect(finalSuccessCount).toBeGreaterThan(0);
      const confirmed = finalResponses.find((entry) => entry.response.status === 200)!;

      const persisted = await testDb.db.select().from(schema.examAnswerSubmissions);
      const operations = await testDb.db.select().from(schema.examSubmissionOperations);
      const answers = await testDb.db.select().from(schema.examSubmissionAnswers);
      const participantIds = persisted.map((row) => row.participantId);
      const persistedBySubmissionId = new Map(persisted.map((row) => [row.id, row]));
      const expectedBySubmissionId = new Map(
        submissions.map((submission) => [submission.submissionId, submission]),
      );
      const expectedByOperationId = new Map(
        submissions.map((submission) => [submission.operationId, submission]),
      );
      const answersPerSubmission = new Map<
        string,
        Map<number, { selectedIndex: number | null; freeText: string | null }>
      >();
      const answerRowCountBySubmission = new Map<string, number>();
      for (const answer of answers) {
        answerRowCountBySubmission.set(
          answer.submissionId,
          (answerRowCountBySubmission.get(answer.submissionId) ?? 0) + 1,
        );
        const selectedAnswers =
          answersPerSubmission.get(answer.submissionId) ??
          new Map<number, { selectedIndex: number | null; freeText: string | null }>();
        selectedAnswers.set(answer.questionId, {
          selectedIndex: answer.selectedIndex,
          freeText: answer.freeText,
        });
        answersPerSubmission.set(answer.submissionId, selectedAnswers);
      }
      const operationsPerSubmission = new Map<string, number>();
      for (const operation of operations) {
        operationsPerSubmission.set(
          operation.submissionId,
          (operationsPerSubmission.get(operation.submissionId) ?? 0) + 1,
        );
      }
      const submissionParticipantLinksMatch = persisted.every(
        (row) => expectedBySubmissionId.get(row.id)?.participantId === row.participantId,
      );
      const operationLinksMatch =
        operations.length === persisted.length &&
        new Set(operations.map((row) => row.operationId)).size === operations.length &&
        persisted.every((row) => operationsPerSubmission.get(row.id) === 1) &&
        operations.every((row) => {
          const expected = expectedByOperationId.get(row.operationId);
          return (
            expected?.submissionId === row.submissionId &&
            expected?.participantId ===
              expectedBySubmissionId.get(row.submissionId)?.participantId &&
            persistedBySubmissionId.has(row.submissionId)
          );
        });
      const submissionIsFullyCommitted = (submission: Omit<BurstResult, "response">) => {
        const stored = persistedBySubmissionId.get(submission.submissionId);
        const actualAnswers = answersPerSubmission.get(submission.submissionId);
        const operation = operations.find((row) => row.operationId === submission.operationId);
        return (
          stored?.participantId === submission.participantId &&
          operationsPerSubmission.get(submission.submissionId) === 1 &&
          operation?.submissionId === submission.submissionId &&
          answerRowCountBySubmission.get(submission.submissionId) === QUESTION_IDS.length &&
          actualAnswers?.size === QUESTION_IDS.length &&
          QUESTION_IDS.slice(0, 4).every(
            (questionId) =>
              actualAnswers.get(questionId)?.selectedIndex ===
                (submission.participantId - FIRST_PARTICIPANT_ID + questionId) % 4 &&
              actualAnswers.get(questionId)?.freeText === null,
          ) &&
          actualAnswers.get(5)?.selectedIndex === null &&
          actualAnswers.get(5)?.freeText === `Local burst response ${submission.participantId}`
        );
      };
      const selectedIndicesMatchExpected = persisted.every((row) => {
        const submission = expectedBySubmissionId.get(row.id);
        const actualAnswers = answersPerSubmission.get(row.id);
        return (
          submission !== undefined &&
          QUESTION_IDS.slice(0, 4).every(
            (questionId) =>
              actualAnswers?.get(questionId)?.selectedIndex ===
              (submission.participantId - FIRST_PARTICIPANT_ID + questionId) % 4,
          )
        );
      });
      const freeTextMatchesExpected = persisted.every((row) => {
        const submission = expectedBySubmissionId.get(row.id);
        const q5 = answersPerSubmission.get(row.id)?.get(5);
        return (
          submission !== undefined &&
          q5?.selectedIndex === null &&
          q5.freeText === `Local burst response ${submission.participantId}`
        );
      });
      const persistedSubmissionIntegrityMatches =
        submissions.every((submission) => {
          const hasSubmission = persistedBySubmissionId.has(submission.submissionId);
          const operationCount = operationsPerSubmission.get(submission.submissionId) ?? 0;
          const answerCount = answerRowCountBySubmission.get(submission.submissionId) ?? 0;
          if (!hasSubmission) return operationCount === 0 && answerCount === 0;
          return submissionIsFullyCommitted(submission);
        }) && answers.every((answer) => persistedBySubmissionId.has(answer.submissionId));
      const final503OutcomesMatch = finalResponses
        .filter((entry) => entry.response.status === 503)
        .every((entry) => {
          if (!persistedBySubmissionId.has(entry.submissionId)) {
            return (
              (operationsPerSubmission.get(entry.submissionId) ?? 0) === 0 &&
              (answerRowCountBySubmission.get(entry.submissionId) ?? 0) === 0
            );
          }
          const submission = expectedBySubmissionId.get(entry.submissionId);
          return submission !== undefined && submissionIsFullyCommitted(submission);
        });
      const committedFinal503Count = finalResponses.filter(
        (entry) =>
          entry.response.status === 503 &&
          expectedBySubmissionId.has(entry.submissionId) &&
          submissionIsFullyCommitted(expectedBySubmissionId.get(entry.submissionId)!),
      ).length;
      const successfulSubmissionsPersisted = finalResponses
        .filter((entry) => entry.response.status === 200)
        .every((entry) => {
          const submission = expectedBySubmissionId.get(entry.submissionId);
          return submission !== undefined && submissionIsFullyCommitted(submission);
        });

      const rowCountsBeforeReplay = {
        submissions: persisted.length,
        operations: operations.length,
        answers: answers.length,
      };
      const operationRevisionBeforeReplay = operations.find(
        (row) => row.operationId === confirmed.operationId,
      )?.revision;
      const replayStartedAt = performance.now();
      const dbMetricsBeforeReplay = testDb.metrics.snapshot();
      const replayResponse = await POST(makeRequest(confirmed.participantId, confirmed.body));
      const replayDurationMs = Number((performance.now() - replayStartedAt).toFixed(2));
      const dbMetricsAfterReplay = testDb.metrics.snapshot();
      const replayBody = await replayResponse.json();
      const rowCountsAfterReplay = {
        submissions: (await testDb.db.select().from(schema.examAnswerSubmissions)).length,
        operations: (await testDb.db.select().from(schema.examSubmissionOperations)).length,
        answers: (await testDb.db.select().from(schema.examSubmissionAnswers)).length,
      };
      const operationRevisionAfterReplay = (
        await testDb.db.select().from(schema.examSubmissionOperations)
      ).find((row) => row.operationId === confirmed.operationId)?.revision;
      const result = {
        harness:
          "local SQLite integrity diagnostic only; does not simulate Turso service limits or production load",
        runSeed: serverRetryDelayDistribution.runSeed,
        clientRetryDelayDistribution: clientRetryHarness.snapshot(clientRetryPolicy),
        arrivalSchedule: {
          name: arrivalSchedule.name,
          participantCount: PARTICIPANT_COUNT,
          nominalDescription:
            arrivalSchedule.name === "simultaneous-local"
              ? "all 60 requests released together"
              : "60 arrivals spaced 30 seconds apart (59 gaps = 29.5 minutes), compressed 30x to 1-second gaps (59 seconds total)",
          nominalIntervalMs:
            arrivalSchedule.name === "simultaneous-local" ? 0 : NOMINAL_UNIFORM_INTERVAL_MS,
          scheduledIntervalMs:
            arrivalSchedule.name === "simultaneous-local" ? 0 : COMPRESSED_UNIFORM_INTERVAL_MS,
          compressionFactor: arrivalSchedule.name === "simultaneous-local" ? null : 30,
          nominalSpanMs:
            arrivalSchedule.name === "simultaneous-local" ? 0 : NOMINAL_ARRIVAL_SPAN_MS,
          scheduledSpanMs:
            arrivalSchedule.name === "simultaneous-local" ? 0 : COMPRESSED_ARRIVAL_SPAN_MS,
        },
        serverRetryDelayDistribution,
        metricNotes: [
          "beginToFirstDmlProxyMs measures from libsql transaction-handle readiness to first DML; it is not SQLite lock-acquisition time",
          "firstDmlToTransactionCompletionProxyMs is an application-side proxy, not SQLite lock duration",
          "sqliteBusyOrLockedFailures counts surfaced SQLITE_BUSY/SQLITE_LOCKED failures only",
          "presentationSessionStatements counts sanitized SQL categories for the presentation_sessions table only",
          "serverRetryDelayDistribution contains only aggregate retry-number/cap/delay timing counts; runSeed makes the deterministic RNG reproducible",
          "clientRetryDelayDistribution reports selected scheduled delays (policy and independent clientSeed included), not measured elapsed wait times",
          "output excludes SQL text, bound values, request content, error messages, and identifiers",
        ],
        participants: PARTICIPANT_COUNT,
        burstDurationMs,
        replayDurationMs,
        initialRequestLatencyMs: initialBurst.map((entry) => entry.responseDurationMs),
        totalRequestLatencyMs: finalResponses.map((entry) => entry.totalLatencyMs),
        initialStatusCounts,
        finalStatusCounts,
        initialDatabaseLockedCount,
        finalDatabaseLockedCount,
        finalSuccessCount,
        ambiguousCommit503Count: committedFinal503Count,
        clientRetryCounts: {
          total: [...retryCounts.values()].reduce((sum, count) => sum + count, 0),
          requestsWithRetry: [...retryCounts.values()].filter((count) => count > 0).length,
        },
        database: {
          transactionAttempts:
            dbMetricsAfterBurst.transactionAttempts - dbMetricsBeforeBurst.transactionAttempts,
          committedTransactions:
            dbMetricsAfterBurst.committedTransactions - dbMetricsBeforeBurst.committedTransactions,
          rollbackAttempts:
            dbMetricsAfterBurst.rollbackAttempts - dbMetricsBeforeBurst.rollbackAttempts,
          transactionFailures:
            dbMetricsAfterBurst.transactionFailures - dbMetricsBeforeBurst.transactionFailures,
          transactionDurationsMs: dbMetricsAfterBurst.transactionDurationsMs
            .slice(dbMetricsBeforeBurst.transactionDurationsMs.length)
            .map((duration) => Number(duration.toFixed(2))),
          beginToFirstDmlProxyMs: dbMetricsAfterBurst.beginToFirstDmlProxyMs
            .slice(dbMetricsBeforeBurst.beginToFirstDmlProxyMs.length)
            .map((duration) => Number(duration.toFixed(2))),
          firstDmlToTransactionCompletionProxyMs: dbMetricsAfterBurst.firstDmlToCompletionProxyMs
            .slice(dbMetricsBeforeBurst.firstDmlToCompletionProxyMs.length)
            .map((duration) => Number(duration.toFixed(2))),
          dmlStatementCounts: Object.fromEntries(
            Object.keys(dbMetricsAfterBurst.dmlStatementCounts).map((category) => [
              category,
              dbMetricsAfterBurst.dmlStatementCounts[category]! -
                dbMetricsBeforeBurst.dmlStatementCounts[category]!,
            ]),
          ),
          sqliteBusyOrLockedFailures:
            dbMetricsAfterBurst.busyLockFailures - dbMetricsBeforeBurst.busyLockFailures,
          presentationSessionStatements,
          replayTransactionAttempts:
            dbMetricsAfterReplay.transactionAttempts - dbMetricsBeforeReplay.transactionAttempts,
          retryExhaustedRequests: finalDatabaseLockedCount,
        },
        invalidInitialResponseCount,
        invalidFinalResponseCount,
        persistedSubmissionCount: persisted.length,
        persistedOperationCount: operations.length,
        persistedAnswerCount: answers.length,
        uniqueParticipantCount: new Set(participantIds).size,
        submissionParticipantLinksMatch,
        operationLinksMatch,
        submissionsWithFiveUniqueAnswers: [...answersPerSubmission.values()].filter(
          (selectedAnswers) => selectedAnswers.size === QUESTION_IDS.length,
        ).length,
        selectedIndicesMatchExpected,
        freeTextMatchesExpected,
        persistedSubmissionIntegrityMatches,
        successfulSubmissionsPersisted,
        final503OutcomesMatch,
        replayStatus: replayResponse.status,
        replayRowCountsBefore: rowCountsBeforeReplay,
        replayRowCountsAfter: rowCountsAfterReplay,
      };
      diagnosticResult = result;

      expect(initialBurst).toHaveLength(PARTICIPANT_COUNT);
      expect(allowedInitialResponses).toBe(true);
      expect(allowedFinalResponses).toBe(true);
      expect(finalResponses).toHaveLength(PARTICIPANT_COUNT);
      expect(finalSuccessCount).toBeGreaterThan(0);
      expect(finalSuccessCount + finalDatabaseLockedCount).toBe(PARTICIPANT_COUNT);
      expect(presentationSessionStatements).toEqual({ insert: 0, update: 0, select: 0 });
      expect(persisted.length).toBeLessThanOrEqual(PARTICIPANT_COUNT);
      expect(new Set(persisted.map((row) => row.id)).size).toBe(persisted.length);
      expect(new Set(participantIds).size).toBe(persisted.length);
      expect(submissionParticipantLinksMatch).toBe(true);
      expect(operationLinksMatch).toBe(true);
      expect(persistedSubmissionIntegrityMatches).toBe(true);
      expect(successfulSubmissionsPersisted).toBe(true);
      expect(final503OutcomesMatch).toBe(true);
      expect(selectedIndicesMatchExpected).toBe(true);
      expect(freeTextMatchesExpected).toBe(true);
      expect(replayResponse.status).toBe(200);
      expect(operationRevisionBeforeReplay).toBeDefined();
      expect(operationRevisionAfterReplay).toBe(operationRevisionBeforeReplay);
      expect(replayBody).toEqual({
        submissionId: confirmed.submissionId,
        revision: operationRevisionBeforeReplay,
      });
      expect(rowCountsAfterReplay).toEqual(rowCountsBeforeReplay);
    },
    process.env.ANSWER_BURST_SCHEDULE === "uniform-60-over-30m-compressed-30x" ? 90_000 : 30_000,
  );
});
