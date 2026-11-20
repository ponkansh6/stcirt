import { describe, it, expect } from "vitest";
import { preserveChoiceOrder } from "@/lib/choice-order";

describe("preserveChoiceOrder", () => {
  it("keeps choices in persisted order and maps each displayed index to itself", () => {
    const originalChoices = ["A", "B", "C", "D"];
    const { choices, choiceIndices } = preserveChoiceOrder(originalChoices);

    expect(choices).toEqual(originalChoices);
    expect(choiceIndices).toEqual([0, 1, 2, 3]);
    expect(originalChoices).toEqual(["A", "B", "C", "D"]);
  });
});
