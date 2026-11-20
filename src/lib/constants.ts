// ── Quiz defaults ──
export const QUIZ_CHOICES_PER_QUESTION = 4;
export const MAX_MULTIPLE_CHOICE_OPTIONS = 8;
export const EXAM_QUESTION_COUNT = 7;
export const EXAM_QUESTION_DISPLAY_ORDER = [3, 7, 6, 4, 2, 1, 5] as const;

export function orderExamQuestionsForDisplay<T extends { id: number }>(questions: T[]): T[] {
  const displayPosition = new Map<number, number>(
    EXAM_QUESTION_DISPLAY_ORDER.map((id, index) => [id, index] as const),
  );
  return [...questions].sort(
    (left, right) =>
      (displayPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (displayPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
