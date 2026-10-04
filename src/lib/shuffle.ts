export function fisherYatesShuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface ShuffledChoices {
  choices: string[];
  choiceIndices: number[]; // choiceIndices[シャッフル後idx] = 元のidx
}

export function shuffleChoices(choices: string[]): ShuffledChoices {
  const indices = Array.from({ length: choices.length }, (_, i) => i);
  const choiceIndices = fisherYatesShuffle(indices);
  const shuffledChoices = choiceIndices.map((i) => choices[i]);
  return {
    choices: shuffledChoices,
    choiceIndices,
  };
}
