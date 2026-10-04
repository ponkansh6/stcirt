import { describe, it, expect } from "vitest";
import { fisherYatesShuffle, shuffleChoices } from "@/lib/shuffle";

describe("fisherYatesShuffle", () => {
  it("shuffles array elements while preserving the set of elements", () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = fisherYatesShuffle(original);

    expect(shuffled).toHaveLength(original.length);
    expect(shuffled.sort()).toEqual([...original].sort());
  });
});

describe("shuffleChoices", () => {
  it("shuffles choices and provides correct index mapping", () => {
    const originalChoices = ["A", "B", "C", "D"];
    const originalCorrectIndex = 1; // "B"

    const { choices, choiceIndices } = shuffleChoices(originalChoices);

    expect(choices).toHaveLength(4);
    expect([...choices].sort()).toEqual(originalChoices.sort());

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
