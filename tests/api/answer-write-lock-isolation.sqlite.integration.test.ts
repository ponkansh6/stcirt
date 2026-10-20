import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { createRequire } from "node:module";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";

const dbRef = vi.hoisted(() => ({ db: null as TestDb["db"] | null }));
const retryEvents = vi.hoisted(() => ({
  events: [] as Array<{
    phase: "preflight_read" | "write_transaction" | "recovery_read";
    retryNumber: number;
    capMs: number;
    delayMs: number;
  }>,
  invocations: [] as Array<{
    operationId: string;
    phaseCounts: Record<"preflight_read" | "write_transaction" | "recovery_read", number>;
  }>,
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
      const phaseCounts = {
        preflight_read: 0,
        write_transaction: 0,
        recovery_read: 0,
      };
      try {
        return await actual.saveAnswerSubmission(input, {
          random: () => 0.5,
          onRetryScheduled: (event) => {
            retryEvents.events.push(event);
            phaseCounts[event.phase] += 1;
          },
        });
      } finally {
        retryEvents.invocations.push({ operationId: input.operationId, phaseCounts });
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
    const match = token?.match(/^write-lock-(\d+)$/);
    return match ? { id: Number(match[1]), expiresAt: new Date("2030-01-01") } : null;
  },
}));

import { POST } from "@/app/api/answers/batch/route";

const PARTICIPANTS = [21_001, 21_002] as const;
const submissions = PARTICIPANTS.map((participantId, index) => {
  const suffix = String(index + 1).padStart(12, "0");
  const submissionId = `00000000-0000-4000-8000-${suffix}`;
  const operationId = `10000000-0000-4000-8000-${suffix}`;
  const payload = {
    submissionId,
    operationId,
    expectedRevision: 0,
    answers: [
      { questionId: 1, selectedIndex: index },
      { questionId: 2, selectedIndex: index + 1 },
      { questionId: 3, selectedIndex: index + 2 },
      { questionId: 4, selectedIndex: (index + 3) % 4 },
      { questionId: 5, freeText: `Lock isolation answer ${index + 1}` },
    ],
  };
  return { participantId, submissionId, operationId, payload };
});

function post(participantId: number, payload: unknown) {
  return POST(
    new Request("http://localhost/api/answers/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        Cookie: `stcirt_participant_session=write-lock-${participantId}`,
      },
      body: JSON.stringify(payload),
    }),
  );
}

function retryStats() {
  return Object.fromEntries(
    (["preflight_read", "write_transaction", "recovery_read"] as const).map((phase) => [
      phase,
      retryEvents.events.filter((event) => event.phase === phase).length,
    ]),
  );
}

function retryStatsForOperation(operationId: string) {
  const phaseCounts = {
    preflight_read: 0,
    write_transaction: 0,
    recovery_read: 0,
  };
  for (const invocation of retryEvents.invocations) {
    if (invocation.operationId !== operationId) continue;
    for (const phase of Object.keys(phaseCounts) as Array<keyof typeof phaseCounts>) {
      phaseCounts[phase] += invocation.phaseCounts[phase];
    }
  }
  return phaseCounts;
}

type CapturedResponse = {
  status: number;
  body: unknown;
  retryDelta: ReturnType<typeof retryStatsForOperation>;
};

async function capturePost(submission: {
  participantId: number;
  operationId: string;
  payload: unknown;
}): Promise<CapturedResponse> {
  const before = retryStatsForOperation(submission.operationId);
  const response = await post(submission.participantId, submission.payload);
  const after = retryStatsForOperation(submission.operationId);
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    retryDelta: {
      preflight_read: after.preflight_read - before.preflight_read,
      write_transaction: after.write_transaction - before.write_transaction,
      recovery_read: after.recovery_read - before.recovery_read,
    },
  };
}

function isDatabaseLocked(response: CapturedResponse) {
  return (
    response.status === 503 &&
    response.body !== null &&
    typeof response.body === "object" &&
    "error" in response.body &&
    response.body.error === "DATABASE_LOCKED"
  );
}

function describeResponse(response: CapturedResponse) {
  const error =
    response.body && typeof response.body === "object" && "error" in response.body
      ? response.body.error
      : null;
  const body =
    response.body && typeof response.body === "object"
      ? {
          error,
          message: "message" in response.body ? response.body.message : undefined,
          revision: "revision" in response.body ? response.body.revision : undefined,
        }
      : response.body;
  return { status: response.status, body, retryDelta: response.retryDelta };
}

function describeSubmissionResponse(
  submission: (typeof submissions)[number],
  response: CapturedResponse,
) {
  return { operationId: submission.operationId, ...describeResponse(response) };
}

function isRecognizedHttpResponse(response: CapturedResponse) {
  return Number.isInteger(response.status) && response.status >= 100 && response.status <= 599;
}

function describeDatabaseError(error: unknown) {
  const details: Array<{ code?: string; extendedCode?: string; message?: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && details.length < 5) {
    seen.add(current);
    if (typeof current !== "object") break;
    const value = current as {
      code?: unknown;
      extendedCode?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    details.push({
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.extendedCode === "string" ? { extendedCode: value.extendedCode } : {}),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    });
    current = value.cause;
  }
  return details;
}

async function probeFileBackedWrite(databaseUrl: string) {
  const client = createClient({ url: databaseUrl });
  let transaction: Awaited<ReturnType<typeof client.transaction>> | null = null;
  const completedStages: Array<"begin" | "execute" | "commit"> = [];
  let stage: "begin" | "execute" | "commit" = "begin";
  let pragmas: { journalMode: unknown; busyTimeout: unknown } | { error: unknown } | undefined =
    undefined;
  try {
    const [journalMode, busyTimeout] = await Promise.all([
      client.execute("PRAGMA journal_mode"),
      client.execute("PRAGMA busy_timeout"),
    ]);
    pragmas = {
      journalMode: journalMode.rows[0]?.journal_mode ?? null,
      busyTimeout: busyTimeout.rows[0]?.timeout ?? null,
    };
    transaction = await client.transaction("write");
    completedStages.push("begin");
    stage = "execute";
    await transaction.execute(
      "UPDATE exam_questions SET correct_index = correct_index WHERE id = 1",
    );
    completedStages.push("execute");
    stage = "commit";
    await transaction.commit();
    completedStages.push("commit");
    transaction = null;
    return { ok: true as const, completedStages, pragmas };
  } catch (error) {
    return {
      ok: false as const,
      failedStage: stage,
      completedStages,
      pragmas: pragmas ?? { error: describeDatabaseError(error) },
      error: describeDatabaseError(error),
    };
  } finally {
    try {
      if (transaction) await transaction.rollback();
    } catch {
      // The probe result preserves the original failure; closing the fresh client releases it.
    } finally {
      client.close();
    }
  }
}

async function probeWriteTimeline(databaseUrl: string) {
  const results = [];
  for (const waitMs of [0, 100, 1_000]) {
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    results.push({ waitMs, ...(await probeFileBackedWrite(databaseUrl)) });
  }
  return results;
}

type CapturedLibSqlTransaction = Awaited<
  ReturnType<ReturnType<typeof createClient>["transaction"]>
>;

type CapturedTransactionHandle = {
  id: string;
  reference: WeakRef<CapturedLibSqlTransaction>;
  capturedAt: number;
};

function capturePostTransactionHandles(testDb: TestDb, handles: CapturedTransactionHandle[]) {
  const db = testDb.db as unknown as {
    transaction: (...args: unknown[]) => Promise<unknown>;
  };
  const originalTransaction = db.transaction.bind(testDb.db);
  let nextId = 1;
  db.transaction = ((callback: unknown, ...args: unknown[]) =>
    originalTransaction(
      async (drizzleTransaction: unknown) => {
        const session = Reflect.get(drizzleTransaction as object, "session");
        const transaction = session && Reflect.get(session, "tx");
        if (transaction && typeof transaction === "object") {
          handles.push({
            id: `post-tx-${nextId++}`,
            reference: new WeakRef(transaction as CapturedLibSqlTransaction),
            capturedAt: performance.now(),
          });
        }
        if (typeof callback !== "function") throw new TypeError("transaction callback is missing");
        return callback(drizzleTransaction);
      },
      ...args,
    )) as typeof db.transaction;

  return () => {
    db.transaction = originalTransaction;
  };
}

function inspectCapturedHandle(handle: CapturedTransactionHandle) {
  const transaction = handle.reference.deref();
  if (!transaction) {
    return {
      id: handle.id,
      capturedAtMs: handle.capturedAt,
      dereferenced: false,
      closed: null,
    };
  }
  return {
    id: handle.id,
    capturedAtMs: handle.capturedAt,
    dereferenced: true,
    closed: transaction.closed,
  };
}

async function runForcedGcAndWaitImmediate() {
  let gc: unknown;
  let exposeGcRequested = false;
  let exposeGcError: ReturnType<typeof describeDatabaseError> | null = null;
  let gcCalled = false;
  let gcError: ReturnType<typeof describeDatabaseError> | null = null;
  try {
    setFlagsFromString("--expose_gc");
    exposeGcRequested = true;
    gc = runInNewContext("gc");
  } catch (error) {
    exposeGcError = describeDatabaseError(error);
  }
  const preGcWaitStartedAtMs = performance.now();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const preGcWaitCompletedAtMs = performance.now();
  if (typeof gc === "function") {
    try {
      Reflect.apply(gc, undefined, []);
      gcCalled = true;
    } catch (error) {
      gcError = describeDatabaseError(error);
    }
  }
  const immediateStartedAtMs = performance.now();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    exposeGcRequested,
    exposeGcError,
    gcAvailable: typeof gc === "function",
    gcCalled,
    gcError,
    preGcWaitStartedAtMs,
    preGcWaitCompletedAtMs,
    immediateStartedAtMs,
    immediateCompletedAtMs: performance.now(),
  };
}

describe("answer write lock isolation with local SQLite", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    retryEvents.events = [];
    retryEvents.invocations = [];
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.insert(schema.examParticipants).values(
      PARTICIPANTS.map((id) => ({
        id,
        normalizedName: `write-lock-${id}`,
        displayName: `Write lock ${id}`,
      })),
    );
    testDb.metrics.reset();
  });

  afterEach(async () => {
    dbRef.db = null;
    await testDb.cleanup();
  });

  it("control: records concurrent saves, fresh-write probes, and same-payload retries", async () => {
    const initial = await Promise.all(
      submissions.map(async (submission) => ({
        submission,
        outcome: await capturePost(submission),
      })),
    );
    const initialSummary = initial.map(({ submission, outcome }) =>
      describeSubmissionResponse(submission, outcome),
    );
    const probeTimeline = await probeWriteTimeline(testDb.databaseUrl);

    const recovery = await Promise.all(
      initial
        .filter(({ outcome }) => outcome.status !== 200)
        .map(async ({ submission }) => ({
          submission,
          outcome: await capturePost(submission),
        })),
    );
    const finalStatusByOperation = new Map(
      initial.map(({ submission, outcome }) => [submission.operationId, outcome.status]),
    );
    for (const { submission, outcome } of recovery) {
      finalStatusByOperation.set(submission.operationId, outcome.status);
    }
    const recoverySummary = recovery.map(({ submission, outcome }) => ({
      operationId: submission.operationId,
      ...describeResponse(outcome),
    }));
    const metricsAfterRouteRetries = testDb.metrics.snapshot();
    const classifiedLockErrorCount =
      metricsAfterRouteRetries.sqliteBusyFailures +
      metricsAfterRouteRetries.sqliteLockedFailures +
      metricsAfterRouteRetries.unclassifiedLockFailures;
    const allRecognizedResponses = [
      ...initial.map(({ outcome }) => outcome),
      ...recovery.map(({ outcome }) => outcome),
    ].every(isRecognizedHttpResponse);
    const persisted = await testDb.db.select().from(schema.examAnswerSubmissions);
    const operations = await testDb.db.select().from(schema.examSubmissionOperations);
    const answers = await testDb.db.select().from(schema.examSubmissionAnswers);
    const diagnostic = {
      initial: initialSummary,
      fileWriteProbeTimeline: probeTimeline,
      samePayloadRouteRetries: recoverySummary,
      finalStatusByOperation: [...finalStatusByOperation.values()],
      retryPhaseTotals: retryStats(),
      sqliteErrorCounts: {
        busy: metricsAfterRouteRetries.sqliteBusyFailures,
        locked: metricsAfterRouteRetries.sqliteLockedFailures,
        unclassified: metricsAfterRouteRetries.unclassifiedLockFailures,
        total: metricsAfterRouteRetries.busyLockFailures,
        classifiedTotal: classifiedLockErrorCount,
        byStage: metricsAfterRouteRetries.lockErrorStages,
      },
      transactionMetrics: metricsAfterRouteRetries,
      persistedRows: {
        submissions: persisted.length,
        operations: operations.length,
        answers: answers.length,
      },
    };
    console.info("answer_write_lock_control_diagnostic", JSON.stringify(diagnostic));
    expect(
      allRecognizedResponses,
      `unlocked concurrent HTTP responses: ${JSON.stringify(diagnostic)}`,
    ).toBe(true);

    if (initial.some(({ outcome }) => outcome.status === 503)) {
      const beforeSharedClientClose = await probeFileBackedWrite(testDb.databaseUrl);
      testDb.closeClient();
      const afterSharedClientClose = await probeFileBackedWrite(testDb.databaseUrl);
      console.info(
        "answer_write_lock_shared_client_close_comparison",
        JSON.stringify({
          initial: initialSummary,
          beforeSharedClientClose,
          afterSharedClientClose,
          helperMetrics: testDb.metrics.snapshot(),
        }),
      );
    }
  });

  it("control: records sequential saves as a contention comparison", async () => {
    const sequential = [];
    for (const submission of submissions) {
      sequential.push({ submission, outcome: await capturePost(submission) });
    }
    const diagnostic = {
      sequential: sequential.map(({ submission, outcome }) =>
        describeSubmissionResponse(submission, outcome),
      ),
      retryPhaseTotals: retryStats(),
      transactionMetrics: testDb.metrics.snapshot(),
    };
    console.info("answer_write_lock_sequential_control_diagnostic", JSON.stringify(diagnostic));
    expect(
      sequential.every(({ outcome }) => isRecognizedHttpResponse(outcome)),
      `sequential HTTP responses: ${JSON.stringify(diagnostic)}`,
    ).toBe(true);
  });

  it("diagnostic: launches 60 POSTs 10ms apart without waiting for earlier responses", async () => {
    const burstSubmissions = Array.from({ length: 60 }, (_, index) => {
      const participantId = 22_001 + index;
      const suffix = String(index + 101).padStart(12, "0");
      const submissionId = `20000000-0000-4000-8000-${suffix}`;
      const operationId = `30000000-0000-4000-8000-${suffix}`;
      return {
        participantId,
        submissionId,
        operationId,
        payload: {
          submissionId,
          operationId,
          expectedRevision: 0,
          answers: [
            { questionId: 1, selectedIndex: index % 4 },
            { questionId: 2, selectedIndex: (index + 1) % 4 },
            { questionId: 3, selectedIndex: (index + 2) % 4 },
            { questionId: 4, selectedIndex: (index + 3) % 4 },
            { questionId: 5, freeText: `10ms burst answer ${index + 1}` },
          ],
        },
      };
    });
    await testDb.db.insert(schema.examParticipants).values(
      burstSubmissions.map(({ participantId }) => ({
        id: participantId,
        normalizedName: `write-lock-${participantId}`,
        displayName: `Write lock ${participantId}`,
      })),
    );

    type BurstResult = {
      index: number;
      operationId: string;
      startAtMs: number;
      completedAtMs: number;
      durationMs: number;
      status: number | null;
      databaseLocked: boolean;
      retryDelta: ReturnType<typeof retryStatsForOperation>;
      rejection: ReturnType<typeof describeDatabaseError> | null;
    };
    const launchOriginMs = performance.now();
    const starts: number[] = [];
    const resultPromises: Array<Promise<BurstResult>> = [];
    const rows: BurstResult[] = [];
    let inFlight = 0;
    let peakInFlight = 0;

    for (const [index, submission] of burstSubmissions.entries()) {
      const targetAtMs = launchOriginMs + index * 10;
      const waitMs = targetAtMs - performance.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      const startAtMs = performance.now();
      starts.push(startAtMs);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const task = capturePost(submission)
        .then((response): BurstResult => {
          const completedAtMs = performance.now();
          return {
            index,
            operationId: submission.operationId,
            startAtMs,
            completedAtMs,
            durationMs: completedAtMs - startAtMs,
            status: response.status,
            databaseLocked: isDatabaseLocked(response),
            retryDelta: response.retryDelta,
            rejection: null,
          };
        })
        .catch((error): BurstResult => {
          const completedAtMs = performance.now();
          return {
            index,
            operationId: submission.operationId,
            startAtMs,
            completedAtMs,
            durationMs: completedAtMs - startAtMs,
            status: null,
            databaseLocked: false,
            retryDelta: retryStatsForOperation(submission.operationId),
            rejection: describeDatabaseError(error),
          };
        })
        .then((result) => {
          inFlight -= 1;
          rows.push(result);
          return result;
        });
      resultPromises.push(task);
    }

    const settled = await Promise.allSettled(resultPromises);
    const completedAtMs = performance.now();
    const orderedRows = [...rows].sort((left, right) => left.index - right.index);
    const startGapsMs = starts.slice(1).map((startAtMs, index) => startAtMs - starts[index]);
    const sortedGaps = [...startGapsMs].sort((left, right) => left - right);
    const percentile = (values: number[], fraction: number) =>
      values.length === 0 ? null : values[Math.ceil(values.length * fraction) - 1];
    const statusCounts = orderedRows.reduce<Record<string, number>>((counts, row) => {
      const key = row.status === null ? "rejected" : String(row.status);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const retryTotals = orderedRows.reduce(
      (totals, row) => ({
        preflight_read: totals.preflight_read + row.retryDelta.preflight_read,
        write_transaction: totals.write_transaction + row.retryDelta.write_transaction,
        recovery_read: totals.recovery_read + row.retryDelta.recovery_read,
      }),
      { preflight_read: 0, write_transaction: 0, recovery_read: 0 },
    );
    const lockMetrics = testDb.metrics.snapshot();
    const persistedSubmissions = await testDb.db.select().from(schema.examAnswerSubmissions);
    const persistedOperations = await testDb.db.select().from(schema.examSubmissionOperations);
    const persistedAnswers = await testDb.db.select().from(schema.examSubmissionAnswers);
    const diagnostic = {
      launchCount: burstSubmissions.length,
      launchIntervalTargetMs: 10,
      launchSchedule: "absolute performance.now offsets; no response awaited before next launch",
      actualStartGapMs: {
        count: startGapsMs.length,
        min: sortedGaps[0] ?? null,
        median: percentile(sortedGaps, 0.5),
        p95: percentile(sortedGaps, 0.95),
        max: sortedGaps.at(-1) ?? null,
      },
      startGapBucketsMs: {
        under5: startGapsMs.filter((gap) => gap < 5).length,
        from5ToUnder10: startGapsMs.filter((gap) => gap >= 5 && gap < 10).length,
        from10ToUnder15: startGapsMs.filter((gap) => gap >= 10 && gap < 15).length,
        from15ToUnder25: startGapsMs.filter((gap) => gap >= 15 && gap < 25).length,
        atLeast25: startGapsMs.filter((gap) => gap >= 25).length,
      },
      completion: {
        settledCount: settled.length,
        responseRows: orderedRows.length,
        totalElapsedMs: completedAtMs - launchOriginMs,
        peakInFlight,
        inFlightAfterSettlement: inFlight,
        responseDurationMs: {
          median: percentile(
            orderedRows.map((row) => row.durationMs).sort((a, b) => a - b),
            0.5,
          ),
          p95: percentile(
            orderedRows.map((row) => row.durationMs).sort((a, b) => a - b),
            0.95,
          ),
          max: Math.max(...orderedRows.map((row) => row.durationMs)),
        },
      },
      httpStatusCounts: statusCounts,
      databaseLockedResponses: orderedRows.filter((row) => row.databaseLocked).length,
      retryTotals,
      sqliteErrors: {
        busy: lockMetrics.sqliteBusyFailures,
        locked: lockMetrics.sqliteLockedFailures,
        unclassified: lockMetrics.unclassifiedLockFailures,
        total: lockMetrics.busyLockFailures,
        byStage: lockMetrics.lockErrorStages,
      },
      persistedRows: {
        submissions: persistedSubmissions.length,
        operations: persistedOperations.length,
        answers: persistedAnswers.length,
      },
      requests: orderedRows,
    };
    console.info("answer_write_60_post_10ms_burst_diagnostic", JSON.stringify(diagnostic));
    expect(
      settled.length === 60 && orderedRows.length === 60,
      `all launched requests should be represented in the observation: ${JSON.stringify(diagnostic)}`,
    ).toBe(true);
  }, 120_000);

  it("diagnostic: launches 60 POSTs 100ms apart without waiting for earlier responses", async () => {
    const burstSubmissions = Array.from({ length: 60 }, (_, index) => {
      const participantId = 23_001 + index;
      const suffix = String(index + 201).padStart(12, "0");
      const submissionId = `40000000-0000-4000-8000-${suffix}`;
      const operationId = `50000000-0000-4000-8000-${suffix}`;
      return {
        participantId,
        submissionId,
        operationId,
        payload: {
          submissionId,
          operationId,
          expectedRevision: 0,
          answers: [
            { questionId: 1, selectedIndex: index % 4 },
            { questionId: 2, selectedIndex: (index + 1) % 4 },
            { questionId: 3, selectedIndex: (index + 2) % 4 },
            { questionId: 4, selectedIndex: (index + 3) % 4 },
            { questionId: 5, freeText: `100ms burst answer ${index + 1}` },
          ],
        },
      };
    });
    await testDb.db.insert(schema.examParticipants).values(
      burstSubmissions.map(({ participantId }) => ({
        id: participantId,
        normalizedName: `write-lock-${participantId}`,
        displayName: `Write lock ${participantId}`,
      })),
    );

    type BurstResult = {
      index: number;
      operationId: string;
      startAtMs: number;
      completedAtMs: number;
      durationMs: number;
      status: number | null;
      databaseLocked: boolean;
      retryDelta: ReturnType<typeof retryStatsForOperation>;
      rejection: ReturnType<typeof describeDatabaseError> | null;
    };
    const launchOriginMs = performance.now();
    const starts: number[] = [];
    const resultPromises: Array<Promise<BurstResult>> = [];
    const rows: BurstResult[] = [];
    let inFlight = 0;
    let peakInFlight = 0;

    for (const [index, submission] of burstSubmissions.entries()) {
      const targetAtMs = launchOriginMs + index * 100;
      const waitMs = targetAtMs - performance.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      const startAtMs = performance.now();
      starts.push(startAtMs);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const task = capturePost(submission)
        .then((response): BurstResult => {
          const completedAtMs = performance.now();
          return {
            index,
            operationId: submission.operationId,
            startAtMs,
            completedAtMs,
            durationMs: completedAtMs - startAtMs,
            status: response.status,
            databaseLocked: isDatabaseLocked(response),
            retryDelta: response.retryDelta,
            rejection: null,
          };
        })
        .catch((error): BurstResult => {
          const completedAtMs = performance.now();
          return {
            index,
            operationId: submission.operationId,
            startAtMs,
            completedAtMs,
            durationMs: completedAtMs - startAtMs,
            status: null,
            databaseLocked: false,
            retryDelta: retryStatsForOperation(submission.operationId),
            rejection: describeDatabaseError(error),
          };
        })
        .then((result) => {
          inFlight -= 1;
          rows.push(result);
          return result;
        });
      resultPromises.push(task);
    }

    // Collection starts only after request 60 has been launched; no earlier response gates a launch.
    const settled = await Promise.allSettled(resultPromises);
    const completedAtMs = performance.now();
    const orderedRows = [...rows].sort((left, right) => left.index - right.index);
    const startGapsMs = starts.slice(1).map((startAtMs, index) => startAtMs - starts[index]);
    const sortedGaps = [...startGapsMs].sort((left, right) => left - right);
    const percentile = (values: number[], fraction: number) =>
      values.length === 0 ? null : values[Math.ceil(values.length * fraction) - 1];
    const statusCounts = orderedRows.reduce<Record<string, number>>((counts, row) => {
      const key = row.status === null ? "rejected" : String(row.status);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const retryTotals = orderedRows.reduce(
      (totals, row) => ({
        preflight_read: totals.preflight_read + row.retryDelta.preflight_read,
        write_transaction: totals.write_transaction + row.retryDelta.write_transaction,
        recovery_read: totals.recovery_read + row.retryDelta.recovery_read,
      }),
      { preflight_read: 0, write_transaction: 0, recovery_read: 0 },
    );
    const lockMetrics = testDb.metrics.snapshot();
    const persistedSubmissions = await testDb.db.select().from(schema.examAnswerSubmissions);
    const persistedOperations = await testDb.db.select().from(schema.examSubmissionOperations);
    const persistedAnswers = await testDb.db.select().from(schema.examSubmissionAnswers);
    const diagnostic = {
      launchCount: burstSubmissions.length,
      launchIntervalTargetMs: 100,
      launchSchedule: "absolute performance.now offsets; no response awaited before next launch",
      actualStartGapMs: {
        count: startGapsMs.length,
        min: sortedGaps[0] ?? null,
        median: percentile(sortedGaps, 0.5),
        p95: percentile(sortedGaps, 0.95),
        max: sortedGaps.at(-1) ?? null,
      },
      startGapBucketsMs: {
        under50: startGapsMs.filter((gap) => gap < 50).length,
        from50ToUnder100: startGapsMs.filter((gap) => gap >= 50 && gap < 100).length,
        from100ToUnder125: startGapsMs.filter((gap) => gap >= 100 && gap < 125).length,
        from125ToUnder150: startGapsMs.filter((gap) => gap >= 125 && gap < 150).length,
        atLeast150: startGapsMs.filter((gap) => gap >= 150).length,
      },
      completion: {
        settledCount: settled.length,
        responseRows: orderedRows.length,
        totalElapsedMs: completedAtMs - launchOriginMs,
        peakInFlight,
        inFlightAfterSettlement: inFlight,
        responseDurationMs: {
          median: percentile(
            orderedRows.map((row) => row.durationMs).sort((a, b) => a - b),
            0.5,
          ),
          p95: percentile(
            orderedRows.map((row) => row.durationMs).sort((a, b) => a - b),
            0.95,
          ),
          max: Math.max(...orderedRows.map((row) => row.durationMs)),
        },
      },
      httpStatusCounts: statusCounts,
      databaseLockedResponses: orderedRows.filter((row) => row.databaseLocked).length,
      retryTotals,
      sqliteErrors: {
        busy: lockMetrics.sqliteBusyFailures,
        locked: lockMetrics.sqliteLockedFailures,
        unclassified: lockMetrics.unclassifiedLockFailures,
        total: lockMetrics.busyLockFailures,
        byStage: lockMetrics.lockErrorStages,
      },
      persistedRows: {
        submissions: persistedSubmissions.length,
        operations: persistedOperations.length,
        answers: persistedAnswers.length,
      },
      requests: orderedRows,
    };
    console.info("answer_write_60_post_100ms_burst_diagnostic", JSON.stringify(diagnostic));
    expect(
      settled.length === 60 && orderedRows.length === 60,
      `all launched requests should be represented in the observation: ${JSON.stringify(diagnostic)}`,
    ).toBe(true);
  }, 180_000);

  it("diagnostic: identifies whether a POST transaction handle remains open after contention", async () => {
    const handles: CapturedTransactionHandle[] = [];
    const restoreTransactionCapture = capturePostTransactionHandles(testDb, handles);
    try {
      const initial = await Promise.all(
        submissions.map(async (submission) => ({
          submission,
          outcome: await capturePost(submission),
        })),
      );
      const handleObservations = handles.map(inspectCapturedHandle);
      const beforeGcProbeStartedAtMs = performance.now();
      const beforeGcFreshProbe = await probeFileBackedWrite(testDb.databaseUrl);
      const beforeGcProbeCompletedAtMs = performance.now();
      const forcedGcAndWait = await runForcedGcAndWaitImmediate();
      const afterGcProbeStartedAtMs = performance.now();
      const afterGcFreshProbe = await probeFileBackedWrite(testDb.databaseUrl);
      const afterGcProbeCompletedAtMs = performance.now();
      const diagnostic = {
        initial: initial.map(({ submission, outcome }) =>
          describeSubmissionResponse(submission, outcome),
        ),
        transactionHandles: handleObservations,
        beforeGcFreshProbe: {
          startedAtMs: beforeGcProbeStartedAtMs,
          completedAtMs: beforeGcProbeCompletedAtMs,
          ...beforeGcFreshProbe,
        },
        forcedGcAndWait,
        afterGcFreshProbe: {
          startedAtMs: afterGcProbeStartedAtMs,
          completedAtMs: afterGcProbeCompletedAtMs,
          ...afterGcFreshProbe,
        },
      };
      console.info("answer_write_post_transaction_handle_diagnostic", JSON.stringify(diagnostic));
      expect(
        initial.every(({ outcome }) => isRecognizedHttpResponse(outcome)),
        `POST outcomes: ${JSON.stringify(diagnostic)}`,
      ).toBe(true);
    } finally {
      restoreTransactionCapture();
    }
  });

  it("diagnostic control: factors reader release, writer retry, and GC before a fresh probe", async () => {
    const scenarios = [
      { id: "no_retry_no_gc", retryWriterCommit: false, forceGcBeforeProbe: false },
      { id: "retry_no_gc", retryWriterCommit: true, forceGcBeforeProbe: false },
      { id: "no_retry_gc", retryWriterCommit: false, forceGcBeforeProbe: true },
      ...([1, 2, 3] as const).map((repetition) => ({
        id: `retry_gc_handles_referenced_r${repetition}`,
        repetition,
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: false,
      })),
      {
        id: "retry_gc_handles_nulled",
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: true,
      },
      {
        id: "retry_gc_reader_select_retained",
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: false,
        retainReaderSelectStatement: true,
      },
      {
        id: "retry_gc_reader_begin_retained",
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: false,
        retainStatementPhase: "reader_begin_started",
      },
      {
        id: "retry_gc_reader_rollback_retained",
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: false,
        retainStatementPhase: "reader_rollback_started",
      },
      {
        id: "retry_gc_writer_update_retained",
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: false,
        retainStatementPhase: "writer_update_started",
      },
      ...([1, 2, 3] as const).map((repetition) => ({
        id: `retry_gc_first_commit_retained_r${repetition}`,
        repetition,
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: false,
        retainStatementPhase: "first_commit_started",
      })),
      {
        id: "retry_gc_retry_commit_retained",
        retryWriterCommit: true,
        forceGcBeforeProbe: true,
        nullHandlesBeforeGc: false,
        retainStatementPhase: "same_writer_commit_retry_started",
      },
    ] as const;
    type StatementLike = object;
    type DatabasePrototype = {
      prepare: (this: object, sql: string) => unknown;
    };
    type StatementObservation = {
      sequence: number;
      scenarioId: string;
      phase: string;
      sql: string;
      reference: WeakRef<StatementLike>;
    };
    type TransactionHandleObservation = {
      name: "reader" | "writer";
      reference: WeakRef<object>;
    };
    const localRequire = createRequire(import.meta.url);
    const libsqlPath = localRequire.resolve("libsql", {
      paths: [localRequire.resolve("@libsql/client")],
    });
    const LibSqlDatabase = localRequire(libsqlPath) as { prototype: DatabasePrototype };
    const databasePrototype = LibSqlDatabase.prototype;
    const originalPrepare = databasePrototype.prepare;
    const statementObservations: StatementObservation[] = [];
    const retainedStatementWrappers: Array<{
      scenarioId: string;
      phase: string;
      sql: string;
      statement: StatementLike;
    }> = [];
    const statementRetentionTargets = new Map<string, { phase: string; sql?: string }>([
      [
        "retry_gc_reader_select_retained",
        { phase: "reader_select_started", sql: "SELECT id FROM exam_questions WHERE id = 1" },
      ],
      ["retry_gc_reader_begin_retained", { phase: "reader_begin_started" }],
      ["retry_gc_reader_rollback_retained", { phase: "reader_rollback_started" }],
      ["retry_gc_writer_update_retained", { phase: "writer_update_started" }],
      ["retry_gc_first_commit_retained", { phase: "first_commit_started" }],
      ["retry_gc_retry_commit_retained", { phase: "same_writer_commit_retry_started" }],
      ...scenarios
        .filter((scenario) => scenario.id.startsWith("retry_gc_first_commit_retained_r"))
        .map((scenario) => [scenario.id, { phase: "first_commit_started" }] as const),
    ]);
    const statementSnapshotPhases = new Set([
      "first_commit_completed",
      "same_writer_commit_retry_completed",
      "forced_gc_completed",
      "fresh_write_probe_completed",
    ]);
    let activeScenarioId = "setup";
    let activePhase = "setup";
    databasePrototype.prepare = function (this: object, sql: string) {
      const statement = Reflect.apply(originalPrepare, this, [sql]) as StatementLike;
      statementObservations.push({
        sequence: statementObservations.length + 1,
        scenarioId: activeScenarioId,
        phase: activePhase,
        sql,
        reference: new WeakRef(statement),
      });
      const retentionTarget = statementRetentionTargets.get(activeScenarioId);
      if (
        retentionTarget?.phase === activePhase &&
        (retentionTarget.sql === undefined || retentionTarget.sql === sql) &&
        !retainedStatementWrappers.some((entry) => entry.scenarioId === activeScenarioId)
      ) {
        retainedStatementWrappers.push({
          scenarioId: activeScenarioId,
          phase: activePhase,
          sql,
          statement,
        });
      }
      return statement;
    };

    const snapshotStatements = (scenarioId: string) => {
      const statements = statementObservations.filter(
        (observation) => observation.scenarioId === scenarioId,
      );
      const bySql = new Map<string, { count: number; aliveCount: number }>();
      const commitStatements = [];
      for (const { reference, ...observation } of statements) {
        const alive = reference.deref() !== undefined;
        const summary = bySql.get(observation.sql) ?? { count: 0, aliveCount: 0 };
        summary.count += 1;
        if (alive) summary.aliveCount += 1;
        bySql.set(observation.sql, summary);
        if (/^\s*COMMIT\b/i.test(observation.sql)) {
          commitStatements.push({
            sequence: observation.sequence,
            phase: observation.phase,
            sql: observation.sql,
            alive,
          });
        }
      }
      return {
        statementCount: statements.length,
        bySql: Object.fromEntries(bySql),
        commitStatements,
      };
    };

    const runScenario = async (scenario: (typeof scenarios)[number]) => {
      const databaseUrl = testDb.databaseUrl;
      const readerClient = createClient({ url: databaseUrl });
      const writerClient = createClient({ url: databaseUrl });
      let reader: Awaited<ReturnType<typeof readerClient.transaction>> | null = null;
      let writer: Awaited<ReturnType<typeof writerClient.transaction>> | null = null;
      let readerHandleObservation: TransactionHandleObservation | null = null;
      let writerHandleObservation: TransactionHandleObservation | null = null;
      let readerSelectStatementAliveAfterGc: boolean | null = null;
      let readerSelectStatementAliveAfterProbe: boolean | null = null;
      let readerSelectStatementRetained: boolean | null = null;
      let retainedStatementAliveAfterGc: boolean | null = null;
      let retainedStatementAliveAfterProbe: boolean | null = null;
      const timeline: Array<{ phase: string; atMs: number; details?: unknown }> = [];
      let freshWriteProbe: Awaited<ReturnType<typeof probeFileBackedWrite>> | null = null;
      const transactionHandleLiveness = () =>
        [readerHandleObservation, writerHandleObservation].flatMap((observation) => {
          if (!observation) return [];
          const transaction = observation.reference.deref() as { closed?: boolean } | undefined;
          return [
            {
              name: observation.name,
              alive: transaction !== undefined,
              closed: transaction?.closed ?? null,
            },
          ];
        });
      const record = (phase: string, details?: unknown) => {
        activePhase = phase;
        timeline.push({
          phase,
          atMs: performance.now(),
          ...(details === undefined ? {} : { details }),
          ...(statementSnapshotPhases.has(phase)
            ? { statements: snapshotStatements(scenario.id) }
            : {}),
          ...(phase === "forced_gc_started"
            ? {}
            : { transactionHandles: transactionHandleLiveness() }),
        });
      };

      try {
        record("baseline_probe_started");
        const baselineFreshWrite = await probeFileBackedWrite(databaseUrl);
        record("baseline_probe_completed", baselineFreshWrite);

        record("reader_begin_started");
        reader = await readerClient.transaction("read");
        readerHandleObservation = { name: "reader", reference: new WeakRef(reader) };
        record("reader_select_started");
        await reader.execute("SELECT id FROM exam_questions WHERE id = 1");
        record("reader_select_completed", { closed: reader.closed });

        writer = await writerClient.transaction("write");
        writerHandleObservation = { name: "writer", reference: new WeakRef(writer) };
        record("writer_update_started");
        await writer.execute(
          "UPDATE exam_questions SET correct_index = correct_index WHERE id = 1",
        );
        record("writer_update_completed", { closed: writer.closed });
        let firstCommitError: ReturnType<typeof describeDatabaseError> | null = null;
        record("first_commit_started");
        try {
          await writer.commit();
        } catch (error) {
          firstCommitError = describeDatabaseError(error);
        }
        record("first_commit_completed", {
          ok: firstCommitError === null,
          error: firstCommitError,
          writerClosed: writer.closed,
        });

        record("reader_release_started");
        let readerReleaseError: ReturnType<typeof describeDatabaseError> | null = null;
        let readerCloseError: ReturnType<typeof describeDatabaseError> | null = null;
        record("reader_rollback_started");
        try {
          await reader.rollback();
        } catch (error) {
          readerReleaseError = describeDatabaseError(error);
        }
        try {
          reader.close();
        } catch (error) {
          readerCloseError = describeDatabaseError(error);
        }
        const readerClosedAfterRelease = reader.closed;
        readerClient.close();
        record("reader_release_completed", {
          rollbackError: readerReleaseError,
          closeError: readerCloseError,
          closed: readerClosedAfterRelease,
        });

        let retryCommitSucceeded: boolean | null = null;
        if (scenario.retryWriterCommit) {
          record("same_writer_commit_retry_started");
          let retryCommitError: ReturnType<typeof describeDatabaseError> | null = null;
          try {
            await writer.commit();
          } catch (error) {
            retryCommitError = describeDatabaseError(error);
          }
          retryCommitSucceeded = retryCommitError === null;
          record("same_writer_commit_retry_completed", {
            ok: retryCommitSucceeded,
            error: retryCommitError,
            writerClosed: writer.closed,
          });
        } else {
          record("same_writer_commit_retry_skipped");
        }

        if (scenario.forceGcBeforeProbe) {
          if (
            "nullHandlesBeforeGc" in scenario &&
            scenario.nullHandlesBeforeGc &&
            retryCommitSucceeded === true
          ) {
            record("transaction_handle_liveness_before_nulling", {
              retryCommitSucceeded,
            });
            reader = null;
            writer = null;
            record("transaction_handles_nulled", transactionHandleLiveness());
          } else if ("nullHandlesBeforeGc" in scenario && scenario.nullHandlesBeforeGc) {
            record("transaction_handles_not_nulled", { retryCommitSucceeded });
          }
          record("forced_gc_started");
          const forcedGcAndWait = await runForcedGcAndWaitImmediate();
          const retentionTarget = statementRetentionTargets.get(scenario.id);
          const retainedStatementObservation = retainedStatementWrappers.find(
            (observation) => observation.scenarioId === scenario.id,
          );
          const retainedStatementWeakRef = retentionTarget
            ? statementObservations.find(
                (observation) =>
                  observation.scenarioId === scenario.id &&
                  observation.phase === retentionTarget.phase &&
                  (retentionTarget.sql === undefined || observation.sql === retentionTarget.sql),
              )
            : undefined;
          retainedStatementAliveAfterGc = retainedStatementWeakRef?.reference.deref() !== undefined;
          if (retainedStatementObservation?.phase === "reader_select_started") {
            readerSelectStatementRetained = true;
          }
          const readerSelectStatementObservation = statementObservations.find(
            (observation) =>
              observation.scenarioId === scenario.id &&
              observation.phase === "reader_select_started" &&
              observation.sql === "SELECT id FROM exam_questions WHERE id = 1",
          );
          readerSelectStatementAliveAfterGc =
            readerSelectStatementObservation?.reference.deref() !== undefined;
          record("forced_gc_completed", forcedGcAndWait);
        }

        record("fresh_write_probe_started", {
          writerReferenced: writer !== null,
          retryWriterCommit: scenario.retryWriterCommit,
          forceGcBeforeProbe: scenario.forceGcBeforeProbe,
        });
        freshWriteProbe = await probeFileBackedWrite(databaseUrl);
        const readerSelectStatementObservation = statementObservations.find(
          (observation) =>
            observation.scenarioId === scenario.id &&
            observation.phase === "reader_select_started" &&
            observation.sql === "SELECT id FROM exam_questions WHERE id = 1",
        );
        readerSelectStatementAliveAfterProbe =
          readerSelectStatementObservation?.reference.deref() !== undefined;
        const retentionTarget = statementRetentionTargets.get(scenario.id);
        const retainedStatementWeakRef = retentionTarget
          ? statementObservations.find(
              (observation) =>
                observation.scenarioId === scenario.id &&
                observation.phase === retentionTarget.phase &&
                (retentionTarget.sql === undefined || observation.sql === retentionTarget.sql),
            )
          : undefined;
        retainedStatementAliveAfterProbe =
          retainedStatementWeakRef?.reference.deref() !== undefined;
        record("fresh_write_probe_completed", freshWriteProbe);
      } catch (error) {
        record("scenario_error", describeDatabaseError(error));
      } finally {
        record("transaction_cleanup_started");
        let readerCleanupError: ReturnType<typeof describeDatabaseError> | null = null;
        let writerCleanupError: ReturnType<typeof describeDatabaseError> | null = null;
        if (reader) {
          try {
            if (!reader.closed) await reader.rollback();
          } catch (error) {
            readerCleanupError = describeDatabaseError(error);
          }
          try {
            if (!reader.closed) reader.close();
          } catch (error) {
            readerCleanupError ??= describeDatabaseError(error);
          }
          reader = null;
        }
        if (writer) {
          try {
            if (!writer.closed) await writer.rollback();
          } catch (error) {
            writerCleanupError = describeDatabaseError(error);
          }
          try {
            if (!writer.closed) writer.close();
          } catch (error) {
            writerCleanupError ??= describeDatabaseError(error);
          }
          record("writer_cleanup_completed", { closed: writer.closed, error: writerCleanupError });
          writer = null;
        }
        readerClient.close();
        writerClient.close();
        for (let index = retainedStatementWrappers.length - 1; index >= 0; index -= 1) {
          if (retainedStatementWrappers[index]?.scenarioId === scenario.id) {
            retainedStatementWrappers.splice(index, 1);
          }
        }
        record("transaction_cleanup_finished", { readerCleanupError });
      }

      return {
        scenario,
        timeline,
        freshWriteProbe,
        readerSelectStatement: {
          retained: readerSelectStatementRetained,
          weakRefAliveAfterGc: readerSelectStatementAliveAfterGc,
          weakRefAliveAfterProbe: readerSelectStatementAliveAfterProbe,
        },
        retainedStatement: {
          phase: statementRetentionTargets.get(scenario.id)?.phase,
          sql: statementObservations.find(
            (observation) =>
              observation.scenarioId === scenario.id &&
              observation.phase === statementRetentionTargets.get(scenario.id)?.phase,
          )?.sql,
          aliveAfterGc: retainedStatementAliveAfterGc,
          aliveAfterProbe: retainedStatementAliveAfterProbe,
        },
      };
    };

    const results: Array<Awaited<ReturnType<typeof runScenario>>> = [];
    try {
      for (const [index, scenario] of scenarios.entries()) {
        if (index > 0) {
          activeScenarioId = `setup_${scenario.id}`;
          activePhase = "database_setup";
          await testDb.cleanup();
          testDb = await createTestDb();
        }
        activeScenarioId = scenario.id;
        activePhase = "scenario_start";
        results.push(await runScenario(scenario));
      }
      console.info(
        "answer_write_delete_journal_reader_lock_factorial_summary",
        JSON.stringify(
          results.map((result) => ({
            scenario: result.scenario.id,
            probe: result.freshWriteProbe && {
              ok: result.freshWriteProbe.ok,
              stage: result.freshWriteProbe.ok ? "completed" : result.freshWriteProbe.failedStage,
              error: result.freshWriteProbe.ok ? null : result.freshWriteProbe.error,
            },
            retainedReaderSelectStatementAlive: {
              strongReferenceHeld: result.readerSelectStatement.retained,
              afterGc:
                result.readerSelectStatement.retained &&
                result.readerSelectStatement.weakRefAliveAfterGc,
              afterProbe:
                result.readerSelectStatement.retained &&
                result.readerSelectStatement.weakRefAliveAfterProbe,
            },
            retainedStatement: result.retainedStatement,
            readerSelectWeakRef: {
              afterGc: result.readerSelectStatement.weakRefAliveAfterGc,
              afterProbe: result.readerSelectStatement.weakRefAliveAfterProbe,
            },
          })),
        ),
      );
      const repeatedComparison = [
        "retry_gc_handles_referenced",
        "retry_gc_first_commit_retained",
      ].map((scenarioPrefix) => {
        const trials = results
          .filter((result) => result.scenario.id.startsWith(`${scenarioPrefix}_r`))
          .map((result) => {
            const probe = result.freshWriteProbe;
            return {
              repetition: Number(result.scenario.id.slice(`${scenarioPrefix}_r`.length)),
              probeStage: !probe ? "not_recorded" : probe.ok ? "completed" : probe.failedStage,
              probeError: probe && !probe.ok ? probe.error : null,
              strongReferenceHeld: result.retainedStatement.phase !== undefined,
              retainedStatementAliveAfterGc: result.retainedStatement.aliveAfterGc,
            };
          });
        const byProbeStage = new Map<string, number>();
        for (const trial of trials) {
          byProbeStage.set(trial.probeStage, (byProbeStage.get(trial.probeStage) ?? 0) + 1);
        }
        return {
          scenario: scenarioPrefix,
          trials,
          aggregate: { total: trials.length, byProbeStage: Object.fromEntries(byProbeStage) },
        };
      });
      console.info(
        "answer_write_delete_journal_repeated_statement_retention_comparison",
        JSON.stringify(repeatedComparison),
      );
      expect(results).toHaveLength(scenarios.length);
    } finally {
      databasePrototype.prepare = originalPrepare;
    }
  });

  it("diagnostic: measures sequential response delays and overlap in request start gaps", async () => {
    await testDb.cleanup();

    const prepareTrialDb = async () => {
      retryEvents.events = [];
      retryEvents.invocations = [];
      testDb = await createTestDb();
      dbRef.db = testDb.db;
      await testDb.db.insert(schema.examParticipants).values(
        PARTICIPANTS.map((id) => ({
          id,
          normalizedName: `write-lock-${id}`,
          displayName: `Write lock ${id}`,
        })),
      );
      testDb.metrics.reset();
    };
    const waitUntil = async (targetAt: number) => {
      const remainingMs = targetAt - performance.now();
      if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
    };

    const responseCompletionTrials = [];
    for (const extraDelayMs of [0, 1, 5, 10, 25]) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        await prepareTrialDb();
        try {
          const firstStartAt = performance.now();
          const firstOutcome = await capturePost(submissions[0]);
          const firstCompletedAt = performance.now();
          if (extraDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, extraDelayMs));
          }
          const secondStartAt = performance.now();
          const secondOutcome = await capturePost(submissions[1]);
          const secondCompletedAt = performance.now();
          responseCompletionTrials.push({
            extraDelayMs,
            repetition,
            first: {
              durationMs: firstCompletedAt - firstStartAt,
              ...describeSubmissionResponse(submissions[0], firstOutcome),
            },
            second: {
              startGapFromFirstStartMs: secondStartAt - firstStartAt,
              responseToStartGapMs: secondStartAt - firstCompletedAt,
              durationMs: secondCompletedAt - secondStartAt,
              ...describeSubmissionResponse(submissions[1], secondOutcome),
            },
          });
        } finally {
          dbRef.db = null;
          await testDb.cleanup();
        }
      }
    }

    const startGapTrials = [];
    for (const targetStartGapMs of [0, 1, 2, 5, 10, 20, 50, 100]) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        await prepareTrialDb();
        try {
          const firstStartAt = performance.now();
          const firstPromise = capturePost(submissions[0]).then((outcome) => ({
            outcome,
            completedAt: performance.now(),
          }));
          await waitUntil(firstStartAt + targetStartGapMs);
          const secondStartAt = performance.now();
          const secondPromise = capturePost(submissions[1]);
          const [firstResult, secondOutcome] = await Promise.all([firstPromise, secondPromise]);
          const completedAt = performance.now();
          const secondStartRelativeToFirstCompletionMs = secondStartAt - firstResult.completedAt;
          startGapTrials.push({
            targetStartGapMs,
            repetition,
            actualStartGapMs: secondStartAt - firstStartAt,
            firstResponseDurationMs: firstResult.completedAt - firstStartAt,
            secondStartedBeforeFirstResponseCompleted: secondStartRelativeToFirstCompletionMs < 0,
            secondStartRelativeToFirstCompletionMs,
            first: describeSubmissionResponse(submissions[0], firstResult.outcome),
            second: describeSubmissionResponse(submissions[1], secondOutcome),
            pairCompletedAfterFirstStartMs: completedAt - firstStartAt,
          });
        } finally {
          dbRef.db = null;
          await testDb.cleanup();
        }
      }
    }

    const retryAfterFailureTrials = [];
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      await prepareTrialDb();
      try {
        const initial = await Promise.all(
          submissions.map(async (submission) => ({
            submission,
            outcome: await capturePost(submission),
          })),
        );
        const failed = initial.filter(({ outcome }) => outcome.status === 503);
        const waitStartedAt = performance.now();
        if (failed.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
        const retryStartedAt = performance.now();
        const retries = await Promise.all(
          failed.map(async ({ submission }) => ({
            submission,
            outcome: await capturePost(submission),
          })),
        );
        retryAfterFailureTrials.push({
          repetition,
          initial: initial.map(({ submission, outcome }) =>
            describeSubmissionResponse(submission, outcome),
          ),
          databaseLockedOperations: failed.map(({ submission }) => submission.operationId),
          retryWaitRequestedMs: failed.length > 0 ? 3 : null,
          retryWaitActualMs: failed.length > 0 ? retryStartedAt - waitStartedAt : null,
          retries: retries.map(({ submission, outcome }) =>
            describeSubmissionResponse(submission, outcome),
          ),
          noDatabaseLockedResponses: failed.length === 0,
        });
      } finally {
        dbRef.db = null;
        await testDb.cleanup();
      }
    }

    const diagnostic = { responseCompletionTrials, startGapTrials, retryAfterFailureTrials };
    console.info("answer_write_sequential_spacing_diagnostic", JSON.stringify(diagnostic));
    expect(
      [...responseCompletionTrials, ...startGapTrials].every(
        (trial) => "first" in trial && "second" in trial,
      ),
      `sequential spacing response observations: ${JSON.stringify(diagnostic)}`,
    ).toBe(true);
  }, 60_000);

  it("diagnostic: compares concurrent saves and raw file write with transaction proxy instrumentation disabled", async () => {
    await testDb.cleanup();
    testDb = await createTestDb({ instrumentTransactions: false });
    dbRef.db = testDb.db;
    await testDb.db.insert(schema.examParticipants).values(
      PARTICIPANTS.map((id) => ({
        id,
        normalizedName: `write-lock-${id}`,
        displayName: `Write lock ${id}`,
      })),
    );
    testDb.metrics.reset();

    const initial = await Promise.all(
      submissions.map(async (submission) => ({
        submission,
        outcome: await capturePost(submission),
      })),
    );
    const probeTimeline = await probeWriteTimeline(testDb.databaseUrl);
    const diagnostic = {
      instrumentation: false,
      initial: initial.map(({ submission, outcome }) =>
        describeSubmissionResponse(submission, outcome),
      ),
      fileWriteProbeTimeline: probeTimeline,
      retryPhaseTotals: retryStats(),
      helperMetrics: testDb.metrics.snapshot(),
    };
    console.info("answer_write_lock_uninstrumented_diagnostic", JSON.stringify(diagnostic));
    expect(
      initial.every(({ outcome }) => isRecognizedHttpResponse(outcome)),
      `un-instrumented route outcomes: ${JSON.stringify(diagnostic)}`,
    ).toBe(true);
  }, 20_000);

  it("records external-writer outcomes, manual re-posts, and post-release recovery observations", async () => {
    const blockerClient = createClient({ url: testDb.databaseUrl });
    let blocker: Awaited<ReturnType<typeof blockerClient.transaction>> | null = null;
    let blockerClientClosed = false;

    try {
      blocker = await blockerClient.transaction("write");
      await blocker.execute("UPDATE exam_questions SET correct_index = correct_index WHERE id = 1");

      const initial = await Promise.all(
        submissions.map(async (submission) => ({
          submission,
          outcome: await capturePost(submission),
        })),
      );
      const followupsWhileLocked: Array<{
        operationId: string;
        retryNumber: number;
        waitMs: number;
        outcome: CapturedResponse;
      }> = [];
      // These are explicit manual re-POSTs. The 25ms wait is only the first interval
      // used by the local burst diagnostic; it does not model automatic production-browser
      // retries. Production callers retry after failure only when the user submits again.
      for (const item of initial) {
        if (isDatabaseLocked(item.outcome)) {
          const waitMs = 25;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          const outcome = await capturePost(item.submission);
          followupsWhileLocked.push({
            operationId: item.submission.operationId,
            retryNumber: 1,
            waitMs,
            outcome,
          });
        }
      }

      const initialSummary = initial.map(({ submission, outcome }) =>
        describeSubmissionResponse(submission, outcome),
      );
      const followupSummary = followupsWhileLocked.map(
        ({ operationId, retryNumber, waitMs, outcome }) => ({
          operationId,
          retryNumber,
          waitMs,
          ...describeResponse(outcome),
        }),
      );
      const observedResponses = [
        ...initial.map(({ outcome }) => outcome),
        ...followupsWhileLocked.map(({ outcome }) => outcome),
      ];
      const recognizedOutcomes = observedResponses.every(isRecognizedHttpResponse);
      const lockMetrics = testDb.metrics.snapshot();
      const externalWriterBehavior = initial.every(({ outcome }) => outcome.status === 200)
        ? "the held external writer lock did not surface as an HTTP 503 in this local route run"
        : observedResponses.some(isDatabaseLocked)
          ? "the held external writer lock surfaced as a retryable DATABASE_LOCKED response"
          : "the held external writer lock produced a different HTTP behavior; inspect the recorded status/body summaries";
      console.info(
        "answer_write_lock_isolation_observation",
        JSON.stringify({
          externalWriterBehavior,
          initial: initialSummary,
          whileLockedFollowups: followupSummary,
          lockErrors: {
            sqliteBusy: lockMetrics.sqliteBusyFailures,
            sqliteLocked: lockMetrics.sqliteLockedFailures,
            unclassified: lockMetrics.unclassifiedLockFailures,
            total: lockMetrics.busyLockFailures,
            byStage: lockMetrics.lockErrorStages,
          },
        }),
      );
      await blocker.rollback();
      blocker = null;
      blockerClient.close();
      blockerClientClosed = true;

      const rawWriteProbeTimeline = await probeWriteTimeline(testDb.databaseUrl);

      const failedWhileLocked = new Map(
        initial
          .filter(({ outcome }) => outcome.status !== 200)
          .map(({ submission }) => [submission.operationId, submission]),
      );
      for (const item of followupsWhileLocked) {
        if (item.outcome.status !== 200) {
          const submission = submissions.find(
            (candidate) => candidate.operationId === item.operationId,
          );
          if (submission) failedWhileLocked.set(item.operationId, submission);
        } else {
          failedWhileLocked.delete(item.operationId);
        }
      }
      const recoveryOutcomes = await Promise.all(
        [...failedWhileLocked.values()].map(async (submission) => ({
          submission,
          outcome: await capturePost(submission),
        })),
      );
      const metricsAfterRouteRetries = testDb.metrics.snapshot();
      const classifiedLockErrorCount =
        metricsAfterRouteRetries.sqliteBusyFailures +
        metricsAfterRouteRetries.sqliteLockedFailures +
        metricsAfterRouteRetries.unclassifiedLockFailures;
      const recoveryRecognized = recoveryOutcomes.every(({ outcome }) =>
        isRecognizedHttpResponse(outcome),
      );
      const diagnostic = {
        externalWriterBehavior,
        initial: initialSummary,
        whileLockedFollowups: followupSummary,
        rawFileWriteProbeTimeline: rawWriteProbeTimeline,
        postReleaseRouteRetries: recoveryOutcomes.map(({ submission, outcome }) => ({
          operationId: submission.operationId,
          ...describeResponse(outcome),
        })),
        retryPhaseTotals: retryStats(),
        sqliteErrorCounts: {
          busy: metricsAfterRouteRetries.sqliteBusyFailures,
          locked: metricsAfterRouteRetries.sqliteLockedFailures,
          unclassified: metricsAfterRouteRetries.unclassifiedLockFailures,
          total: metricsAfterRouteRetries.busyLockFailures,
          classifiedTotal: classifiedLockErrorCount,
          byStage: metricsAfterRouteRetries.lockErrorStages,
        },
        transactionMetrics: metricsAfterRouteRetries,
      };
      console.info("answer_write_lock_isolation_diagnostic", JSON.stringify(diagnostic));
      expect(
        recognizedOutcomes && recoveryRecognized,
        `external-lock HTTP diagnostic: ${JSON.stringify(diagnostic)}`,
      ).toBe(true);

      const persisted = await testDb.db.select().from(schema.examAnswerSubmissions);
      const operations = await testDb.db.select().from(schema.examSubmissionOperations);
      const answers = await testDb.db.select().from(schema.examSubmissionAnswers);
      const replayOutcomes = await Promise.all(submissions.map(capturePost));
      const persistedAfterReplay = await testDb.db.select().from(schema.examAnswerSubmissions);
      const replaySummary = replayOutcomes.map((outcome, index) =>
        describeSubmissionResponse(submissions[index], outcome),
      );
      const finalDiagnostic = {
        ...diagnostic,
        persistedRows: {
          submissions: persisted.length,
          operations: operations.length,
          answers: answers.length,
          submissionsAfterReplay: persistedAfterReplay.length,
        },
        replayAfterRelease: replaySummary,
        finalTransactionMetrics: testDb.metrics.snapshot(),
      };
      console.info("answer_write_lock_isolation_final_diagnostic", JSON.stringify(finalDiagnostic));
      expect(
        replayOutcomes.every(isRecognizedHttpResponse),
        `post-release replay HTTP responses: ${JSON.stringify(finalDiagnostic)}`,
      ).toBe(true);
    } finally {
      try {
        if (blocker) await blocker.rollback();
      } finally {
        if (!blockerClientClosed) blockerClient.close();
      }
    }
  }, 20_000);
});
