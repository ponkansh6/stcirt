import { describe, it, expect } from "vitest";
import { errorMessage } from "@/lib/error-message";

describe("errorMessage", () => {
  it("returns the Error message when e is an Error", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  it("returns the fallback when e is not an Error", () => {
    expect(errorMessage("string error", "fallback")).toBe("fallback");
    expect(errorMessage(undefined, "fallback")).toBe("fallback");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });
});
