import { cn } from "@/lib/cn";
import { Spinner } from "@/components/Spinner";

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

type ButtonProps = React.ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  loading?: boolean;
};

/** Shared design-system classes so NavLink / home links match Button styling. */
export const buttonBaseClasses =
  "w-full py-3 rounded-card font-bold min-h-12 text-center focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none transition duration-200 ease-[var(--ease-out-soft)] disabled:opacity-50 motion-safe:active:scale-[0.98]";

/**
 * `cn()` concatenates without merging, so variants must not repeat a utility
 * the base already sets — the later rule in the stylesheet would win silently.
 * Hence `shadow-sm` lives here per variant rather than in `buttonBaseClasses`.
 */
export const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover shadow-card hover:shadow-raise",
  outline: "border-2 border-primary text-primary hover:bg-primary/10 shadow-sm",
  ghost: "text-muted hover:bg-surface-2 shadow-sm",
  danger: "bg-error text-on-primary hover:bg-error/90 shadow-card hover:shadow-raise",
};

export function Button({
  variant = "primary",
  loading = false,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonBaseClasses, buttonVariants[variant], className)}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      {...props}
    >
      <span className="inline-flex items-center justify-center gap-2">
        {loading && <Spinner />}
        {children}
      </span>
    </button>
  );
}
