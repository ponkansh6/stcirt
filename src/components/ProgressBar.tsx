import { cn } from "@/lib/cn";

interface ProgressBarProps {
  /** 0 .. 1 (範囲外はクランプ) */
  value: number;
  className?: string;
}

export function ProgressBar({ value, className }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cn("h-1.5 w-full rounded-full bg-surface-2 overflow-hidden", className)}
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full bg-primary transition-all duration-500 ease-[var(--ease-out-soft)]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
