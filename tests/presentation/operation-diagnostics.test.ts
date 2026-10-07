import { describe, expect, it } from "vitest";
import {
  getPresentationOperationDiagnostics,
  makePresentationOperationError,
} from "@/lib/presentation/operation-diagnostics";

describe("presentation operation diagnostics", () => {
  it("extracts a whitelisted database code through nested causes", () => {
    const error = makePresentationOperationError("read_visibility", {
      cause: { extendedCode: "SQLITE_BUSY_SNAPSHOT", message: "sensitive detail" },
    });
    expect(getPresentationOperationDiagnostics(error)).toEqual({
      phase: "read_visibility",
      errorKind: "database",
      databaseCode: "SQLITE_BUSY_SNAPSHOT",
    });
  });

  it("discards unrecognized database codes and does not expose error messages", () => {
    const error = makePresentationOperationError("write_visibility", {
      code: "SQLITE_CUSTOM_PRIVATE_VALUE",
      message: "sensitive detail",
    });
    expect(getPresentationOperationDiagnostics(error)).toEqual({
      phase: "write_visibility",
      errorKind: "unknown",
      databaseCode: null,
    });
  });
});
