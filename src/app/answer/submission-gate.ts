export function runIfSubmissionAllowed<T>(
  canSubmit: boolean,
  submissionBlocked: boolean,
  action: () => T,
): T | undefined {
  if (!canSubmit || submissionBlocked) return undefined;
  return action();
}
