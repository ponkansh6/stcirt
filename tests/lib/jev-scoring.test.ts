import { describe, expect, it } from "vitest";
import { scoreQ5 } from "@/lib/jev/scoring";

describe("Q5 independent A/B score", () => {
  it("awards half a point for a keyword hit on each matching part", () => {
    expect(scoreQ5({ a: "新鮮なロブスター", b: "店で食事" }, { a: 0, b: 0 })).toBe(0.5);
    expect(scoreQ5({ a: "不明", b: "フレンチトースト" }, { a: 0, b: 0 })).toBe(0.5);
    expect(scoreQ5({ a: "新鮮なロブスター", b: "フレンチトースト" }, { a: 0, b: 0 })).toBe(1);
  });

  it("does not let a keyword in one answer affect the other part", () => {
    expect(scoreQ5({ a: "フレンチトースト", b: "不明" }, { a: 0, b: 0 })).toBe(0);
    expect(scoreQ5({ a: "不明", b: "ロブスター" }, { a: 0, b: 0 })).toBe(0);
    expect(scoreQ5({ a: "ロブスター", b: "不明" }, { a: 0, b: 5.4 })).toBe(0.8);
  });

  it("normalizes each JEV part to two decimals before weighting it by one half", () => {
    expect(scoreQ5({ a: "曖昧な回答", b: "曖昧な回答" }, { a: 4.5, b: 6.3 })).toBe(0.6);
    expect(scoreQ5({ a: "曖昧な回答", b: "曖昧な回答" }, { a: 4, b: 5 })).toBe(0.5);
    expect(scoreQ5({ a: "曖昧な回答", b: "曖昧な回答" }, { a: 1, b: 0 })).toBe(0.055);
  });

  it("clamps invalid JEV scores to the 0–0.5 range per part", () => {
    expect(scoreQ5({ a: "回答", b: "回答" }, { a: -1, b: 10 })).toBe(0.5);
  });

  it("treats an ungraded keyword override as zero JEV score for the other part", () => {
    expect(scoreQ5({ a: "ロブスター", b: "回答" }, { a: null, b: null })).toBe(0.5);
    expect(scoreQ5({ a: "回答", b: "回答" }, { a: null, b: null })).toBe(0);
  });

  it("recognizes the requested Japanese variants after Unicode normalization", () => {
    expect(scoreQ5({ a: "ロブスターです", b: "フレンチトースト" }, { a: 0, b: 0 })).toBe(1);
  });
});
