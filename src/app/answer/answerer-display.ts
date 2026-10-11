import type { AnswerMode } from "./use-quiz-session";

export type AnswererDisplay = {
  name: string;
  kind: "本人の回答" | "代理回答";
};

export function resolveAnswererDisplay(
  answerMode: AnswerMode,
  ownerName: string,
  assistedName: string | null | undefined,
): AnswererDisplay {
  return answerMode === "assisted"
    ? { name: assistedName ?? "ほかの人", kind: "代理回答" }
    : { name: ownerName, kind: "本人の回答" };
}
