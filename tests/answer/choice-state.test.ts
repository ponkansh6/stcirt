import { describe, it, expect } from "vitest";
import { choiceVariant } from "@/app/answer/choice-state";

describe("choiceVariant", () => {
  it("returns idle when not pending and not graded", () => {
    expect(choiceVariant({ isPending: false, isGraded: false, index: 0 })).toBe("idle");
  });

  it("handles pending state correctly", () => {
    expect(choiceVariant({ isPending: true, isGraded: false, index: 1, selectedIndex: 1 })).toBe(
      "selected",
    );
    expect(choiceVariant({ isPending: true, isGraded: false, index: 0, selectedIndex: 1 })).toBe(
      "muted",
    );
  });

  it("handles graded state correctly when correctShuffledIndex is defined", () => {
    // Correct index match
    expect(
      choiceVariant({
        isPending: false,
        isGraded: true,
        index: 2,
        selectedIndex: 0,
        correctShuffledIndex: 2,
      }),
    ).toBe("correct");

    // Selected wrong match
    expect(
      choiceVariant({
        isPending: false,
        isGraded: true,
        index: 0,
        selectedIndex: 0,
        correctShuffledIndex: 2,
      }),
    ).toBe("selectedWrong");

    // Muted for other indices
    expect(
      choiceVariant({
        isPending: false,
        isGraded: true,
        index: 1,
        selectedIndex: 0,
        correctShuffledIndex: 2,
      }),
    ).toBe("muted");
  });

  it("returns idle when graded but correctShuffledIndex is undefined", () => {
    expect(
      choiceVariant({
        isPending: false,
        isGraded: true,
        index: 0,
        correctShuffledIndex: undefined,
      }),
    ).toBe("idle");
  });
});
