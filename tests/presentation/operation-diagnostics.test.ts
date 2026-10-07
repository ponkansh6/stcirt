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
      clientErrorClass: null,
      clientCode: null,
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
      clientErrorClass: null,
      clientCode: null,
    });
  });

  it("records only known libsql and transport error classes and codes", () => {
    const libsqlError = Object.assign(new Error("private detail"), {
      name: "LibsqlError",
      code: "SERVER_ERROR",
    });
    const error = makePresentationOperationError("read_visibility", libsqlError);

    expect(getPresentationOperationDiagnostics(error)).toEqual({
      phase: "read_visibility",
      errorKind: "libsql",
      databaseCode: null,
      clientErrorClass: "LibsqlError",
      clientCode: "SERVER_ERROR",
    });
    expect(JSON.stringify(getPresentationOperationDiagnostics(error))).not.toContain(
      "private detail",
    );

    const transportError = makePresentationOperationError(
      "read_visibility",
      Object.assign(new Error("private detail"), { name: "HttpServerError" }),
    );
    expect(getPresentationOperationDiagnostics(transportError)).toMatchObject({
      errorKind: "transport",
      clientErrorClass: "HttpServerError",
      clientCode: null,
    });
  });

  it("keeps generic runtime errors unclassified", () => {
    const error = makePresentationOperationError(
      "read_visibility",
      new TypeError("private detail"),
    );

    expect(getPresentationOperationDiagnostics(error)).toMatchObject({
      errorKind: "unknown",
      clientErrorClass: null,
      clientCode: null,
    });
  });

  it("discards unknown client classes and codes", () => {
    const cause = Object.assign(new Error("private detail"), {
      name: "PrivateErrorClass",
      code: "PRIVATE_ERROR_CODE",
    });
    const error = makePresentationOperationError("read_visibility", cause);

    expect(getPresentationOperationDiagnostics(error)).toEqual({
      phase: "read_visibility",
      errorKind: "unknown",
      databaseCode: null,
      clientErrorClass: null,
      clientCode: null,
    });
  });
});
