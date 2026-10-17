/** A poll may apply only if no newer local slide intent superseded it. */
export function canApplyPresenterPoll(
  startedAtGeneration: number,
  currentGeneration: number,
  startedWhilePositionPending: boolean,
  recoveringPositionConflict = false,
): boolean {
  return (
    recoveringPositionConflict ||
    (!startedWhilePositionPending && startedAtGeneration === currentGeneration)
  );
}
