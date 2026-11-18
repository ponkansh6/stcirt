export type TimelineEntry = {
  date: string;
  time: string;
  activity: string;
  answerPart?: "a" | "b";
  answerPrefix?: string;
  answerSuffix?: string;
};

export type ParsedTimeline = {
  title: string;
  description: string;
  entries: TimelineEntry[];
};

export function hasUniqueTimelineAnswerMarkers(entries: TimelineEntry[]): boolean {
  const parsedCounts = { a: 0, b: 0 };
  const textCounts = { a: 0, b: 0 };

  for (const entry of entries) {
    if (entry.answerPart) parsedCounts[entry.answerPart] += 1;
    for (const marker of entry.activity.matchAll(/[AB](?=を|$)/g)) {
      textCounts[marker[0] === "A" ? "a" : "b"] += 1;
    }
  }

  return (
    parsedCounts.a === 1 &&
    parsedCounts.b === 1 &&
    textCounts.a === parsedCounts.a &&
    textCounts.b === parsedCounts.b
  );
}

export function parseTimeline(questionText: string): ParsedTimeline | null {
  const [intro = "", ...rawLines] = questionText.split(/\r?\n/);
  const sentenceBreak = intro.indexOf("。");
  const keepsIntroAsTitle = intro.startsWith("舜基は珠美の1年間の香港滞在中、3回香港に訪問した。");
  const title =
    sentenceBreak >= 0 && !keepsIntroAsTitle ? intro.slice(0, sentenceBreak + 1) : intro;
  const description =
    sentenceBreak >= 0 && !keepsIntroAsTitle ? intro.slice(sentenceBreak + 1).trim() : "";
  const lines = rawLines.filter((line) => line.trim().length > 0);
  const entries = lines
    .map((line): TimelineEntry | null => {
      const trimmedLine = line.trim();
      // Keep supporting legacy marker-only rows such as "朝 A".
      const answerMarker = trimmedLine.match(/^(\S+)\s+(\S+)\s*([AB])$/);
      if (answerMarker) {
        return {
          date: answerMarker[1],
          time: answerMarker[2],
          activity: answerMarker[3],
          answerPart: answerMarker[3] === "A" ? "a" : "b",
        };
      }

      const match = trimmedLine.match(/^(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      const activity = match[3];
      const embeddedAnswerMarker = activity.match(/^(.*?)\s*([AB])(を.*)$/);
      if (embeddedAnswerMarker) {
        return {
          date: match[1],
          time: match[2],
          activity,
          answerPart: embeddedAnswerMarker[2] === "A" ? "a" : "b",
          answerPrefix: embeddedAnswerMarker[1],
          answerSuffix: embeddedAnswerMarker[3],
        };
      }
      return { date: match[1], time: match[2], activity };
    })
    .filter((entry): entry is TimelineEntry => entry !== null);

  if (entries.length === 0 || entries.length !== lines.length) return null;
  return { title, description, entries };
}
