type SqliteCauseValue = {
  code?: unknown;
  extendedCode?: unknown;
  message?: unknown;
  cause?: unknown;
  originalError?: unknown;
  original?: unknown;
  error?: unknown;
};

/** Visit the bounded wrapper graph used by repository SQLite error classifiers. */
export function* sqliteCauseObjects(error: unknown): Generator<SqliteCauseValue> {
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  for (let depth = 0; pending.length > 0 && depth < 6; depth += 1) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    const value = current as SqliteCauseValue;
    yield value;
    pending.push(value.cause, value.originalError, value.original, value.error);
  }
}
