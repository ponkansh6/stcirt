import { sqliteCauseObjects } from "./sqlite-cause-traversal";

export function isSqliteLockContention(error: unknown): boolean {
  return sqliteCauseObjects(error).some((value) => {
    const codes = [value.code, value.extendedCode].filter(
      (code): code is string => typeof code === "string",
    );
    return codes.some(
      (code) => /^SQLITE_BUSY(?:_|$)/.test(code) || /^SQLITE_LOCKED(?:_|$)/.test(code),
    );
  });
}
