const LOBSTER_ALIASES = ["ロブスター"];
const FRENCH_TOAST_ALIASES = ["フレンチトースト"];

function normalizeForKeywordComparison(answer: string): string {
  return answer
    .normalize("NFKC")
    .replace(/[\u30a1-\u30f6]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .trim();
}

function scorePart(answerText: string, jevRawScore: number, aliases: string[]): number {
  const comparableAnswer = normalizeForKeywordComparison(answerText);
  if (aliases.some((alias) => comparableAnswer.includes(normalizeForKeywordComparison(alias))))
    return 1;
  return Math.round(Math.min(1, Math.max(0, jevRawScore / 9)) * 100) / 100;
}

export function q5KeywordHits(answers: { a: string; b: string }): { a: boolean; b: boolean } {
  return {
    a: LOBSTER_ALIASES.some((alias) =>
      normalizeForKeywordComparison(answers.a).includes(normalizeForKeywordComparison(alias)),
    ),
    b: FRENCH_TOAST_ALIASES.some((alias) =>
      normalizeForKeywordComparison(answers.b).includes(normalizeForKeywordComparison(alias)),
    ),
  };
}

export function scoreQ5(
  answers: { a: string; b: string },
  jevScores: { a: number | null; b: number | null },
): number {
  return (
    scorePart(answers.a, jevScores.a ?? 0, LOBSTER_ALIASES) +
    scorePart(answers.b, jevScores.b ?? 0, FRENCH_TOAST_ALIASES)
  );
}
