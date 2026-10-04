import { NavLink } from "@/components/NavLink";
import { getStats } from "@/lib/db/repository/answer-repository";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { totalQuestions } = await getStats();
  const canStart = totalQuestions >= 5;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-10 px-4 py-10 sm:py-16 motion-safe:animate-rise">
      <header className="space-y-3">
        <p className="text-sm font-bold tracking-[0.2em] text-primary">STCIRT</p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">5問検定</h1>
        <p className="max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          知識を一問ずつ確かめながら、全5問に回答します。
        </p>
      </header>

      <section
        className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-10"
        aria-labelledby="exam-briefing"
      >
        <div
          className="pointer-events-none absolute inset-2 rounded-xl border border-border/70"
          aria-hidden="true"
        />
        <div className="relative">
          <p className="text-xs font-bold tracking-[0.2em] text-primary">EXAM GUIDE</p>
          <h2 id="exam-briefing" className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            受検案内
          </h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-3">
            {["全5問", "順番に出題", "回答を記録します"].map((item, index) => (
              <li
                key={item}
                className="flex min-h-12 items-center gap-3 border-t border-border pt-3 text-sm font-semibold sm:border-t-0 sm:border-l sm:pl-4 sm:pt-0"
              >
                <span className="font-serif text-lg text-primary" aria-hidden="true">
                  0{index + 1}
                </span>
                {item}
              </li>
            ))}
          </ul>

          <div className="mt-8 max-w-sm">
            {canStart ? (
              <NavLink href="/answer" className="tracking-wide">
                検定を開始する
              </NavLink>
            ) : (
              <NavLink
                href="/answer"
                aria-disabled="true"
                tabIndex={-1}
                onClick={(event) => event.preventDefault()}
                className="pointer-events-none cursor-not-allowed opacity-50"
              >
                検定を開始する
              </NavLink>
            )}
            {!canStart && (
              <p className="mt-3 text-sm text-muted" role="status">
                問題は現在{totalQuestions}問です。5問そろうと開始できます。
              </p>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
