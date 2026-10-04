export type ChoiceVariant = "idle" | "correct" | "selectedWrong" | "muted" | "selected";

export interface ChoiceVariantInput {
  isPending: boolean;
  isGraded: boolean;
  index: number;
  selectedIndex?: number;
  correctShuffledIndex?: number;
}

export function choiceVariant(input: ChoiceVariantInput): ChoiceVariant {
  if (input.isPending) {
    return input.index === input.selectedIndex ? "selected" : "muted";
  }
  if (input.isGraded && input.correctShuffledIndex !== undefined) {
    if (input.index === input.correctShuffledIndex) return "correct";
    if (input.index === input.selectedIndex) return "selectedWrong";
    return "muted";
  }
  return "idle";
}
