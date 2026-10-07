const SAFE_DATABASE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_CONSTRAINT",
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_ERROR",
  "SQLITE_MISMATCH",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_FULL",
  "SQLITE_READONLY",
  "SQLITE_PROTOCOL",
  "SQLITE_NOTADB",
  "SQLITE_CORRUPT",
  "SQLITE_TOOBIG",
  "SQLITE_RANGE",
  "SQLITE_NOMEM",
  "SQLITE_AUTH",
  "SQLITE_PERM",
]);

export type PresentationOperationPhase =
  | "transaction_begin"
  | "transaction_commit"
  | "acquire_session"
  | "read_visibility"
  | "snapshot_probe_question"
  | "snapshot_probe_entry"
  | "source_questions_read"
  | "participants_read"
  | "submissions_read"
  | "answers_read"
  | "assessments_read"
  | "delete_entries"
  | "delete_questions"
  | "insert_questions"
  | "insert_entries"
  | "update_session"
  | "read_session"
  | "write_visibility"
  | "hide_results";

export class PresentationOperationError extends Error {
  constructor(
    readonly phase: PresentationOperationPhase,
    readonly errorKind: "database" | "unknown",
    readonly databaseCode: string | null,
    cause: unknown,
  ) {
    super("Presentation operation failed", { cause });
    this.name = "PresentationOperationError";
  }
}

export function makePresentationOperationError(phase: PresentationOperationPhase, cause: unknown) {
  const databaseCode = findSafeDatabaseCode(cause);
  return new PresentationOperationError(
    phase,
    databaseCode ? "database" : "unknown",
    databaseCode,
    cause,
  );
}

export function getPresentationOperationDiagnostics(error: unknown) {
  if (!(error instanceof PresentationOperationError)) return null;
  return {
    phase: error.phase,
    errorKind: error.errorKind,
    databaseCode: error.databaseCode,
  };
}

function findSafeDatabaseCode(error: unknown) {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 6; depth += 1) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const value = current as {
      code?: unknown;
      extendedCode?: unknown;
      cause?: unknown;
      originalError?: unknown;
      original?: unknown;
      error?: unknown;
    };
    for (const code of [value.code, value.extendedCode]) {
      if (typeof code === "string" && SAFE_DATABASE_CODES.has(code)) return code;
    }
    pending.push(value.cause, value.originalError, value.original, value.error);
  }
  return null;
}
