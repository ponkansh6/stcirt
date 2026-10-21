const EGG_ALIASES = ["卵", "玉子", "たまご"];
const SHUNTO_ALIASES = ["春闘", "しゅんとう"];

function normalizeForKeywordComparison(answer: string): string {
  return answer
    .normalize("NFKC")
    .replace(/[\u30a1-\u30f6]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .trim();
}

export function scoreQ5(answerText: string, jevRawScore: number): number {
  const comparableAnswer = normalizeForKeywordComparison(answerText);
  const eggHit = Number(EGG_ALIASES.some((alias) => comparableAnswer.includes(alias)));
  const shuntoHit = Number(SHUNTO_ALIASES.some((alias) => comparableAnswer.includes(alias)));
  return 0.3 * eggHit + 0.3 * shuntoHit + 0.4 * (jevRawScore / 9);
}
