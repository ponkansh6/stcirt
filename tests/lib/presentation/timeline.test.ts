import { describe, expect, it } from "vitest";
import { hasUniqueTimelineAnswerMarkers, parseTimeline } from "@/lib/presentation/timeline";

describe("parseTimeline", () => {
  it("parses the current Q5 itinerary as all eight ordered entries", () => {
    const question = [
      "舜基は珠美の1年間の香港滞在中、3回香港に訪問した。3回目の旅程に関して以下を埋めてください。",
      "2/27 昼 マンダリンオリエンタルホテルのスコーンを食べる",
      "2/27 夜 香港で評価の高いフォカッチャパニーニを食べる",
      "2/28 朝 ローカルシーフードレストランでAを食べる",
      "2/28 昼 アバディーンでボートツアー＆ボートヌードル",
      "2/28 夜 地元で人気なローストグースを食べる",
      "3/1 朝 地元の少しリッチな飲茶を食べる",
      "3/1 昼夜 香港ディズニーランドを楽しむ",
      "3/2 朝 Bを食べる",
    ].join("\n");

    expect(parseTimeline(question)).toMatchObject({
      entries: [
        { date: "2/27", time: "昼", activity: "マンダリンオリエンタルホテルのスコーンを食べる" },
        { date: "2/27", time: "夜", activity: "香港で評価の高いフォカッチャパニーニを食べる" },
        {
          date: "2/28",
          time: "朝",
          activity: "ローカルシーフードレストランでAを食べる",
          answerPart: "a",
          answerPrefix: "ローカルシーフードレストランで",
          answerSuffix: "を食べる",
        },
        { date: "2/28", time: "昼", activity: "アバディーンでボートツアー＆ボートヌードル" },
        { date: "2/28", time: "夜", activity: "地元で人気なローストグースを食べる" },
        { date: "3/1", time: "朝", activity: "地元の少しリッチな飲茶を食べる" },
        { date: "3/1", time: "昼夜", activity: "香港ディズニーランドを楽しむ" },
        {
          date: "3/2",
          time: "朝",
          activity: "Bを食べる",
          answerPart: "b",
          answerPrefix: "",
          answerSuffix: "を食べる",
        },
      ],
    });
    expect(parseTimeline(question)?.entries).toHaveLength(8);
    expect(hasUniqueTimelineAnswerMarkers(parseTimeline(question)!.entries)).toBe(true);
  });

  it("ignores blank lines and retains legacy marker-only and embedded-marker rows", () => {
    expect(
      parseTimeline("旅程です。\n\n2/28 朝 A\n3/2 朝 B\n3/3 昼 食事Aを楽しむ")?.entries,
    ).toEqual([
      { date: "2/28", time: "朝", activity: "A", answerPart: "a" },
      { date: "3/2", time: "朝", activity: "B", answerPart: "b" },
      {
        date: "3/3",
        time: "昼",
        activity: "食事Aを楽しむ",
        answerPart: "a",
        answerPrefix: "食事",
        answerSuffix: "を楽しむ",
      },
    ]);
  });

  it("rejects a timeline when any non-empty row cannot be parsed", () => {
    expect(parseTimeline("旅程です。\n2/28 朝 食事\n不正な行")).toBeNull();
  });

  it("rejects repeated markers within one activity even when the parser finds its first marker", () => {
    const parsed = parseTimeline("旅程です。\n2/28 朝 Aを食べるAを食べる\n3/2 朝 Bを食べる");

    expect(parsed).not.toBeNull();
    expect(parsed?.entries[0]).toMatchObject({ answerPart: "a" });
    expect(hasUniqueTimelineAnswerMarkers(parsed!.entries)).toBe(false);
  });
});
