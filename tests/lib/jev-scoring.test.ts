import { describe, expect, it } from "vitest";
import { scoreQ5 } from "@/lib/jev/scoring";

describe("Q5 independent A/B score", () => {
  it("awards a full point for a keyword hit on the matching part", () => {
    expect(scoreQ5({ a: "ローカルな朝飲茶", b: "店で食事" }, { a: 0, b: 0 })).toBe(1);
    expect(scoreQ5({ a: "ヤムチャ", b: "ローカルなシーフードレストラン" }, { a: 0, b: 0 })).toBe(2);
  });

  it("does not let a keyword in one answer affect the other part", () => {
    expect(scoreQ5({ a: "シーフード", b: "不明" }, { a: 0, b: 0 })).toBe(0);
    expect(scoreQ5({ a: "不明", b: "飲茶" }, { a: 0, b: 0 })).toBe(0);
    expect(scoreQ5({ a: "飲茶", b: "不明" }, { a: 0, b: 5.4 })).toBe(1.6);
  });

  it("rounds each JEV part to two decimal places and sums out of two", () => {
    expect(scoreQ5({ a: "曖昧な回答", b: "曖昧な回答" }, { a: 4.5, b: 6.3 })).toBe(1.2);
    expect(scoreQ5({ a: "曖昧な回答", b: "曖昧な回答" }, { a: 4, b: 5 })).toBe(1);
  });

  it("clamps invalid JEV scores to the 0–1 range per part", () => {
    expect(scoreQ5({ a: "回答", b: "回答" }, { a: -1, b: 10 })).toBe(1);
  });

  it("treats an ungraded keyword override as zero JEV score for the other part", () => {
    expect(scoreQ5({ a: "飲茶", b: "回答" }, { a: null, b: null })).toBe(1);
    expect(scoreQ5({ a: "回答", b: "回答" }, { a: null, b: null })).toBe(0);
  });

  it("recognizes the requested Japanese variants after Unicode normalization", () => {
    expect(scoreQ5({ a: "ヤムチャです", b: "シーフード店" }, { a: 0, b: 0 })).toBe(2);
  });
});
