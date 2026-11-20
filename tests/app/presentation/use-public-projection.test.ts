import { describe, expect, it } from "vitest";
import { isProjectionData } from "@/app/presentation/use-public-projection";

const validQuestion = {
  id: 1,
  ordinal: 1,
  total: 2,
  question: "Which option?",
  choices: ["A", "B"],
};

function statisticsProjection(statistics: unknown, question: unknown = validQuestion) {
  return { state: "statistics", question, statistics };
}

const selectedStatistics = {
  kind: "selected",
  multiple: false,
  participantCount: 2,
  validRespondentCount: 2,
  uncountableCount: 0,
  choices: [{ label: "A", count: 2 }],
};

const freeTextStatistics = {
  kind: "freeText",
  participantCount: 2,
  gradedCount: 1,
  ungradedCount: 1,
  uncountableCount: 0,
  ranges: [{ label: "0–1", count: 2 }],
};

describe("isProjectionData statistics payloads", () => {
  it.each([
    ["a selected summary", selectedStatistics],
    ["a selected summary with unknown multiplicity", { ...selectedStatistics, multiple: null }],
    ["a free-text summary", freeTextStatistics],
  ])("accepts %s", (_label, statistics) => {
    expect(isProjectionData(statisticsProjection(statistics))).toBe(true);
  });

  it.each([
    ["a missing question", null, selectedStatistics],
    ["a non-object question", "question", selectedStatistics],
    ["missing statistics", validQuestion, null],
    ["non-object statistics", validQuestion, "statistics"],
    ["a question without a valid id", { ...validQuestion, id: {} }, selectedStatistics],
    [
      "a question without an integer ordinal",
      { ...validQuestion, ordinal: 1.5 },
      selectedStatistics,
    ],
    ["a question without an integer total", { ...validQuestion, total: "2" }, selectedStatistics],
    [
      "a question without a string prompt",
      { ...validQuestion, question: null },
      selectedStatistics,
    ],
    ["a question without a choices array", { ...validQuestion, choices: "A" }, selectedStatistics],
    [
      "a question with a non-string choice",
      { ...validQuestion, choices: ["A", 2] },
      selectedStatistics,
    ],
    [
      "a non-integer participant count",
      validQuestion,
      { ...selectedStatistics, participantCount: "2" },
    ],
    [
      "a negative participant count",
      validQuestion,
      { ...selectedStatistics, participantCount: -1 },
    ],
    ["an unknown statistics kind", validQuestion, { ...selectedStatistics, kind: "other" }],
    [
      "a selected summary without an integer respondent count",
      validQuestion,
      { ...selectedStatistics, validRespondentCount: null },
    ],
    [
      "a selected summary with a negative uncountable count",
      validQuestion,
      { ...selectedStatistics, uncountableCount: -1 },
    ],
    [
      "a selected summary with an invalid multiple flag",
      validQuestion,
      { ...selectedStatistics, multiple: "yes" },
    ],
    [
      "a selected summary without a choices array",
      validQuestion,
      { ...selectedStatistics, choices: null },
    ],
    [
      "a free-text summary without a ranges array",
      validQuestion,
      { ...freeTextStatistics, ranges: null },
    ],
    [
      "a count item that is not an object",
      validQuestion,
      { ...selectedStatistics, choices: ["A"] },
    ],
    ["a null count item", validQuestion, { ...selectedStatistics, choices: [null] }],
    [
      "a count item without a string label",
      validQuestion,
      { ...selectedStatistics, choices: [{ label: 1, count: 1 }] },
    ],
    [
      "a count item without an integer count",
      validQuestion,
      { ...selectedStatistics, choices: [{ label: "A", count: 1.5 }] },
    ],
    [
      "a count item with a negative count",
      validQuestion,
      { ...selectedStatistics, choices: [{ label: "A", count: -1 }] },
    ],
  ])("rejects %s", (_label, question, statistics) => {
    expect(isProjectionData(statisticsProjection(statistics, question))).toBe(false);
  });

  it("accepts string question ids and an empty collection of counts", () => {
    const projection = statisticsProjection(
      { ...selectedStatistics, choices: [] },
      { ...validQuestion, id: "question-1" },
    );

    expect(isProjectionData(projection)).toBe(true);
  });

  it.each([
    ["a null legacy correct index", { correctIndex: null, correctIndices: null }],
    ["an explicit empty correct-index list", { correctIndex: null, correctIndices: [] }],
  ])("accepts statistics with %s", (_label, correctness) => {
    expect(
      isProjectionData(
        statisticsProjection(selectedStatistics, { ...validQuestion, ...correctness }),
      ),
    ).toBe(true);
  });
});
