import { describe, expect, it } from "vitest";
import { canApplyPresenterPoll } from "@/lib/presentation/presenter-position";

describe("presenter position poll reconciliation", () => {
  it("rejects a poll from an earlier local slide generation", () => {
    expect(canApplyPresenterPoll(4, 5, false)).toBe(false);
  });

  it("rejects a poll that started while a position write was pending, even after it settles", () => {
    expect(canApplyPresenterPoll(5, 5, true)).toBe(false);
  });

  it("allows a current poll after persistence settles", () => {
    expect(canApplyPresenterPoll(5, 5, false)).toBe(true);
  });

  it("allows an explicit conflict reconciliation poll", () => {
    expect(canApplyPresenterPoll(5, 5, true, true)).toBe(true);
  });
});
