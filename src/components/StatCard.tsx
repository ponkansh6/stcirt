import { ProgressBar } from "@/components/ProgressBar";

interface StatCardProps {
  label: string;
  value: string;
  progress?: number; // 0 .. 1
}

export function StatCard({ label, value, progress }: StatCardProps) {
  const hasProgress = progress !== undefined;

  return (
    <div className="bg-surface shadow-card rounded-card p-3 sm:p-5 flex flex-col items-center justify-center transition duration-200 ease-[var(--ease-out-soft)]">
      <div className="text-2xl sm:text-3xl font-bold tracking-tight">{value}</div>
      <div className="text-xs font-medium text-muted mt-1">{label}</div>
      {hasProgress ? (
        <ProgressBar value={progress} className="mt-3" />
      ) : (
        <div className="h-1.5 mt-3" aria-hidden="true" />
      )}
    </div>
  );
}
