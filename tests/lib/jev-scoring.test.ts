import { describe, expect, it } from "vitest";
import { scoreQ5 } from "@/lib/jev/scoring";

describe("Q5 weighted score", () => {
  it.each([
    { answer: "無関係語", expected: 0 },
    { answer: "卵", expected: 0.3 },
    { answer: "春闘", expected: 0.3 },
    { answer: "卵 春闘", expected: 0.6 },
  ])("covers the keyword hit combination for $answer", ({ answer, expected }) => {
    expect(scoreQ5(answer, 0)).toBeCloseTo(expected);
  });

  it.each([
    { alias: "卵", expected: 0.3 },
    { alias: "玉子", expected: 0.3 },
    { alias: "たまご", expected: 0.3 },
    { alias: "タマゴ", expected: 0.3 },
    { alias: "春闘", expected: 0.3 },
    { alias: "しゅんとう", expected: 0.3 },
    { alias: "シュントウ", expected: 0.3 },
    { alias: "ﾀﾏｺﾞ", expected: 0.3 },
    { alias: "ｼｭﾝﾄｳ", expected: 0.3 },
  ])("recognizes alias $alias independently", ({ alias, expected }) => {
    expect(scoreQ5(alias, 0)).toBeCloseTo(expected);
  });

  it.each([
    { answer: "", jevScore: 0, expected: 0 },
    { answer: "卵", jevScore: 0, expected: 0.3 },
    { answer: "春闘", jevScore: 9, expected: 0.7 },
    { answer: "玉子とシュントウ", jevScore: 0, expected: 0.6 },
    { answer: "たまご・しゅんとう", jevScore: 4.5, expected: 0.8 },
    { answer: "ﾀﾏｺﾞとｼｭﾝﾄｳ", jevScore: 9, expected: 1 },
    { answer: "関係のない回答", jevScore: 9, expected: 0.4 },
  ])("scores $answer with JEV $jevScore", ({ answer, jevScore, expected }) => {
    expect(scoreQ5(answer, jevScore)).toBeCloseTo(expected);
  });

  it("counts each keyword family at most once and matches negated or quoted mentions", () => {
    expect(
      scoreQ5("卵、玉子、たまご、タマゴ。卵ではない。『春闘』しゅんとうシュントウｼｭﾝﾄｳ", 0),
    ).toBe(0.6);
  });

  it("does not join internal whitespace and preserves punctuation boundaries", () => {
    expect(scoreQ5("春 闘", 0)).toBe(0);
    expect(scoreQ5("たま ご", 0)).toBe(0);
    expect(scoreQ5("春闘。", 0)).toBe(0.3);
  });
});
