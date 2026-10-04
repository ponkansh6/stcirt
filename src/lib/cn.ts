/**
 * Joins class names, dropping falsy values.
 * Lightweight replacement for `clsx` + `tailwind-merge`.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
