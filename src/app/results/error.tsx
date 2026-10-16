"use client";

export default function ResultsError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
      <section className="rounded-2xl border border-border bg-surface p-7 shadow-sm sm:p-10">
        <h1 className="text-3xl font-bold tracking-tight">結果を読み込めませんでした</h1>
        <p className="mt-4 text-muted" role="alert">
          一時的な問題が発生しました。もう一度お試しください。
        </p>
        <button
          type="button"
          className="mt-8 inline-flex rounded-lg border border-border px-4 py-2 font-semibold text-primary"
          onClick={retry}
        >
          再試行
        </button>
      </section>
    </main>
  );
}
