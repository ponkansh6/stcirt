import { Button } from "./Button";

interface ErrorMessageProps {
  message: string;
  onRetry?: () => void;
  loading?: boolean;
}

export function ErrorMessage({ message, onRetry, loading }: ErrorMessageProps) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center space-y-4 bg-error/5 ring-1 ring-error/30 rounded-card shadow-card my-auto motion-safe:animate-rise">
      <p className="text-error font-bold text-base">{message}</p>
      {onRetry && (
        <div className="w-48 pt-2">
          <Button variant="outline" onClick={onRetry} loading={loading}>
            再試行
          </Button>
        </div>
      )}
    </div>
  );
}
