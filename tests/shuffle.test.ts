import { afterEach, describe, it, expect, vi } from "vitest";
import { fisherYatesShuffle, shuffleChoices } from "@/lib/shuffle";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fisherYatesShuffle", () => {
  it("shuffles array elements while preserving the set of elements", () => {
    const original = [1, 2, 3, 4];
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0);

    const shuffled = fisherYatesShuffle(original);

    expect(shuffled).toEqual([2, 1, 3, 4]);
    expect(original).toEqual([1, 2, 3, 4]);
  });
});

describe("shuffleChoices", () => {
  it("shuffles choices and provides correct index mapping", () => {
    const originalChoices = ["A", "B", "C", "D"];
    const originalCorrectIndex = 1; // "B"
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0);

    const { choices, choiceIndices } = shuffleChoices(originalChoices);

    expect(choices).toEqual(["B", "A", "C", "D"]);
    expect(choiceIndices).toEqual([1, 0, 2, 3]);
    expect(originalChoices).toEqual(["A", "B", "C", "D"]);

    // Verify mapping: choices[shuffledIdx] === originalChoices[choiceIndices[shuffledIdx]]
    choices.forEach((c, idx) => {
      expect(c).toBe(originalChoices[choiceIndices[idx]]);
    });

    // Verify correct answer tracking:
    // The correct answer "B" (index 1) is now at some position in shuffled choices.
    // We need to find which index in `choices` corresponds to index 1.
    const shuffledCorrectIndex = choiceIndices.indexOf(originalCorrectIndex);
    expect(choices[shuffledCorrectIndex]).toBe("B");
  });
});
