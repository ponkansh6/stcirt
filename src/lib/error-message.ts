/** Returns `e.message` when `e` is an `Error`, otherwise the given fallback. */
export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}
