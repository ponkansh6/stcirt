export interface OrderedChoices {
  choices: string[];
  choiceIndices: number[]; // choiceIndices[displayedIdx] = source idx
}

/** Preserve the persisted choice order and provide the identity index mapping. */
export function preserveChoiceOrder(choices: string[]): OrderedChoices {
  return {
    choices: [...choices],
    choiceIndices: choices.map((_, index) => index),
  };
}
