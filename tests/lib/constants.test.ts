import { describe, expect, it } from "vitest";
import { orderExamQuestionsForDisplay } from "@/lib/constants";

describe("orderExamQuestionsForDisplay", () => {
  it("sorts the configured questions and leaves unknown ids after them", () => {
    const questions = [
      { id: 99, label: "unknown first" },
      { id: 5, label: "last configured" },
      { id: 3, label: "first configured" },
      { id: 100, label: "unknown second" },
    ];

    expect(orderExamQuestionsForDisplay(questions)).toEqual([
      { id: 3, label: "first configured" },
      { id: 5, label: "last configured" },
      { id: 99, label: "unknown first" },
      { id: 100, label: "unknown second" },
    ]);
    expect(questions[0]?.id).toBe(99);
  });
});
