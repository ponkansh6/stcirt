import { createClient, type TransactionMode } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Logger } from "drizzle-orm/logger";
import * as schema from "@/lib/db/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TestDbMetrics = {
  transactionAttempts: number;
  committedTransactions: number;
  rollbackAttempts: number;
  successfulRollbacks: number;
  failedRollbacks: number;
  rollbackClosedStates: Array<boolean | null>;
  commitErrorClosedStates: Array<boolean | null>;
  transactionFailures: number;
  transactionDurationsMs: number[];
  beginToFirstDmlMs: number[];
  firstDmlToCompletionMs: number[];
  dmlStatementCounts: Record<string, number>;
  presentationSessionStatements: Record<"insert" | "update" | "select", number>;
  busyLockFailures: number;
  sqliteBusyFailures: number;
  sqliteLockedFailures: number;
  unclassifiedLockFailures: number;
  lockErrorStages: Record<"begin" | "execute" | "commit" | "rollback", number>;
};

function createMetrics(): TestDbMetrics {
  return {
    transactionAttempts: 0,
    committedTransactions: 0,
    rollbackAttempts: 0,
    successfulRollbacks: 0,
    failedRollbacks: 0,
    rollbackClosedStates: [],
    commitErrorClosedStates: [],
    transactionFailures: 0,
    transactionDurationsMs: [],
    beginToFirstDmlMs: [],
    firstDmlToCompletionMs: [],
    dmlStatementCounts: { insert: 0, update: 0, delete: 0, other: 0 },
    presentationSessionStatements: { insert: 0, update: 0, select: 0 },
    busyLockFailures: 0,
    sqliteBusyFailures: 0,
    sqliteLockedFailures: 0,
    unclassifiedLockFailures: 0,
    lockErrorStages: { begin: 0, execute: 0, commit: 0, rollback: 0 },
  };
}

function statementCategory(statement: unknown) {
  const sqlText =
    typeof statement === "string"
      ? statement
      : statement && typeof statement === "object" && "sql" in statement
        ? String(statement.sql)
        : "";
  const keyword = sqlText
    .trimStart()
    .match(/^[A-Za-z]+/)?.[0]
    ?.toUpperCase();
  if (keyword === "INSERT" || keyword === "REPLACE") return "insert";
  if (keyword === "UPDATE") return "update";
  if (keyword === "DELETE") return "delete";
  return null;
}

function recordPresentationSessionStatement(metrics: TestDbMetrics, query: string) {
  if (!/\bpresentation_sessions\b/i.test(query)) return;
  const keyword = query
    .trimStart()
    .match(/^[A-Za-z]+/)?.[0]
    ?.toLowerCase();
  if (keyword === "insert" || keyword === "replace") {
    metrics.presentationSessionStatements.insert += 1;
  } else if (keyword === "update") {
    metrics.presentationSessionStatements.update += 1;
  } else if (keyword === "select") {
    metrics.presentationSessionStatements.select += 1;
  }
}

function recordBusyLockError(
  metrics: TestDbMetrics,
  error: unknown,
  stage: keyof TestDbMetrics["lockErrorStages"],
) {
  const record = (classification: "busy" | "locked" | "unclassified") => {
    metrics.busyLockFailures += 1;
    metrics.lockErrorStages[stage] += 1;
    if (classification === "busy") metrics.sqliteBusyFailures += 1;
    else if (classification === "locked") metrics.sqliteLockedFailures += 1;
    else metrics.unclassifiedLockFailures += 1;
  };
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current === "object") {
      const errorRecord = current as { code?: unknown; message?: unknown; cause?: unknown };
      const code = typeof errorRecord.code === "string" ? errorRecord.code : "";
      const message = typeof errorRecord.message === "string" ? errorRecord.message : "";
      const details = `${code} ${message}`;
      if (/SQLITE_BUSY(?:_|\b)/i.test(details)) {
        record("busy");
        return;
      }
      if (/SQLITE_LOCKED(?:_|\b)/i.test(details)) {
        record("locked");
        return;
      }
      if (/database (?:table )?is locked/i.test(message)) {
        record("unclassified");
        return;
      }
      current = errorRecord.cause;
    } else if (typeof current === "string") {
      if (/SQLITE_BUSY(?:_|\b)/i.test(current)) {
        record("busy");
      } else if (/SQLITE_LOCKED(?:_|\b)/i.test(current)) {
        record("locked");
      } else if (/database (?:table )?is locked/i.test(current)) {
        record("unclassified");
      }
      return;
    } else {
      return;
    }
  }
}

function instrumentTransactions(client: ReturnType<typeof createClient>, metrics: TestDbMetrics) {
  const originalTransaction = client.transaction.bind(client);
  const replaceableClient = client as unknown as {
    transaction: typeof client.transaction;
  };

  replaceableClient.transaction = async (mode?: TransactionMode) => {
    metrics.transactionAttempts += 1;
    const startedAt = performance.now();
    let firstDmlAt: number | null = null;
    let transactionHandleReadyAt: number | null = null;
    let recorded = false;
    let failed = false;
    const recordCompletion = () => {
      if (recorded) return;
      recorded = true;
      if (failed) metrics.transactionFailures += 1;
      metrics.transactionDurationsMs.push(performance.now() - startedAt);
      if (firstDmlAt !== null) {
        if (transactionHandleReadyAt !== null) {
          metrics.beginToFirstDmlMs.push(firstDmlAt - transactionHandleReadyAt);
        }
        metrics.firstDmlToCompletionMs.push(performance.now() - firstDmlAt);
      }
    };

    try {
      const transaction = await originalTransaction(mode);
      transactionHandleReadyAt = performance.now();
      const readClosedState = () => {
        try {
          const closed = Reflect.get(transaction, "closed", transaction);
          return typeof closed === "boolean" ? closed : null;
        } catch {
          return null;
        }
      };
      return new Proxy(transaction, {
        get(target, property) {
          const original = Reflect.get(target, property, target);
          if (property === "execute" && typeof original === "function") {
            return async (statement: unknown, ...rest: unknown[]) => {
              const category = statementCategory(statement);
              if (category) {
                metrics.dmlStatementCounts[category] += 1;
                firstDmlAt ??= performance.now();
              }
              try {
                return await Reflect.apply(original, target, [statement, ...rest]);
              } catch (error) {
                failed = true;
                recordBusyLockError(metrics, error, "execute");
                throw error;
              }
            };
          }
          if (
            (property === "commit" || property === "rollback") &&
            typeof original === "function"
          ) {
            if (property === "rollback") {
              return async (...methodArgs: unknown[]) => {
                metrics.rollbackAttempts += 1;
                failed = true;
                try {
                  const result = await Reflect.apply(original, target, methodArgs);
                  metrics.successfulRollbacks += 1;
                  return result;
                } catch (error) {
                  failed = true;
                  metrics.failedRollbacks += 1;
                  recordBusyLockError(metrics, error, "rollback");
                  throw error;
                } finally {
                  metrics.rollbackClosedStates.push(readClosedState());
                  recordCompletion();
                }
              };
            }
            return async (...methodArgs: unknown[]) => {
              try {
                const result = await Reflect.apply(original, target, methodArgs);
                metrics.committedTransactions += 1;
                return result;
              } catch (error) {
                failed = true;
                metrics.commitErrorClosedStates.push(readClosedState());
                recordBusyLockError(metrics, error, "commit");
                throw error;
              } finally {
                recordCompletion();
              }
            };
          }
          return typeof original === "function" ? original.bind(target) : original;
        },
      });
    } catch (error) {
      failed = true;
      recordBusyLockError(metrics, error, "begin");
      recordCompletion();
      throw error;
    }
  };
}

/**
 * Creates an isolated, file-backed test database with migrations applied.
 *
 * NOTE: we intentionally use a file-backed DB (not `:memory:`) because libsql
 * opens a *new* connection for `db.transaction()`. With `:memory:` each
 * connection is a separate empty database, so writes inside a transaction
 * would not be visible to subsequent reads on the original connection.
 */
export async function createTestDb(
  options: { logger?: Logger; instrumentTransactions?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "study-test-"));
  const databaseUrl = `file:${dir}/test.db`;
  const client = createClient({ url: databaseUrl });
  let clientClosed = false;
  const closeClient = () => {
    if (clientClosed) return;
    clientClosed = true;
    client.close();
  };
  const metrics = createMetrics();
  if (options.instrumentTransactions ?? true) instrumentTransactions(client, metrics);
  const logger: Logger = {
    logQuery(query, params) {
      recordPresentationSessionStatement(metrics, query);
      options.logger?.logQuery(query, params);
    },
  };
  const db = drizzle({ client, schema, logger });
  await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });
  return {
    db,
    client,
    closeClient,
    databaseUrl,
    metrics: {
      snapshot: () => ({
        transactionAttempts: metrics.transactionAttempts,
        committedTransactions: metrics.committedTransactions,
        rollbackAttempts: metrics.rollbackAttempts,
        successfulRollbacks: metrics.successfulRollbacks,
        failedRollbacks: metrics.failedRollbacks,
        rollbackClosedStates: [...metrics.rollbackClosedStates],
        commitErrorClosedStates: [...metrics.commitErrorClosedStates],
        transactionFailures: metrics.transactionFailures,
        transactionDurationsMs: [...metrics.transactionDurationsMs],
        // The libsql API does not expose the SQLite lock-acquisition timestamp;
        // transaction-handle readiness is used as an application-side begin proxy.
        beginToFirstDmlProxyMs: [...metrics.beginToFirstDmlMs],
        // This is an application-side proxy, not a measurement of SQLite lock time.
        firstDmlToCompletionProxyMs: [...metrics.firstDmlToCompletionMs],
        dmlStatementCounts: { ...metrics.dmlStatementCounts },
        presentationSessionStatements: { ...metrics.presentationSessionStatements },
        busyLockFailures: metrics.busyLockFailures,
        sqliteBusyFailures: metrics.sqliteBusyFailures,
        sqliteLockedFailures: metrics.sqliteLockedFailures,
        unclassifiedLockFailures: metrics.unclassifiedLockFailures,
        lockErrorStages: { ...metrics.lockErrorStages },
      }),
      reset: () => Object.assign(metrics, createMetrics()),
    },
    cleanup: () => {
      closeClient();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;
