import { describe, it, expect } from "vitest";
import { choiceLabel } from "@/lib/choice-label";

describe("choiceLabel", () => {
  it("should return A. for index 0", () => {
    expect(choiceLabel(0)).toBe("A.");
  });

  it("should return B. for index 1", () => {
    expect(choiceLabel(1)).toBe("B.");
  });

  it("should return C. for index 2", () => {
    expect(choiceLabel(2)).toBe("C.");
  });

  it("should return D. for index 3", () => {
    expect(choiceLabel(3)).toBe("D.");
  });

  it("should support higher indices", () => {
    expect(choiceLabel(25)).toBe("Z.");
  });
});
