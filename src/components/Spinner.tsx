/**
 * Reusable loading spinner. All spinner markup in the app is centralized here.
 * Renders an aria-hidden decorative element (progress is announced via
 * `aria-busy` on the owning button / `role="status"` containers).
 */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
    />
  );
}
