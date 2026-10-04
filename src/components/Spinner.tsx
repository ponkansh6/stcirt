interface SpinnerProps {
  /** Box size. sm = 16px border-2, lg = 32px border-4. */
  size?: "sm" | "lg";
  /** Border color: `current` inherits text color, `primary` uses the brand color. */
  color?: "current" | "primary";
  /** Extra classes (e.g. `ml-auto` for layout). */
  className?: string;
}

/**
 * Reusable loading spinner. All spinner markup in the app is centralized here.
 * Renders an aria-hidden decorative element (progress is announced via
 * `aria-busy` on the owning button / `role="status"` containers).
 */
export function Spinner({ size = "sm", color = "current", className }: SpinnerProps) {
  const sizeClasses = size === "lg" ? "w-8 h-8 border-4" : "w-4 h-4 border-2";
  const colorClasses = color === "primary" ? "border-primary" : "border-current";
  return (
    <span
      aria-hidden="true"
      className={`${sizeClasses} ${colorClasses} border-t-transparent rounded-full animate-spin ${className ?? ""}`}
    />
  );
}
