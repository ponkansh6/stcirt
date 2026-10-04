import { Spinner } from "@/components/Spinner";

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = "読み込み中..." }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center p-8 space-y-4">
      <Spinner size="lg" color="primary" />
      <p className="text-muted font-medium">{label}</p>
    </div>
  );
}
