import type { ParticipantResult } from "@/lib/participant-results-contract";

export default function ParticipantResultDetails({
  result,
}: {
  result: Extract<ParticipantResult, { state: "visible" }>;
}) {
  return (
    <>
      <dl className="mt-8 grid grid-cols-2 gap-2 sm:gap-4">
        <div className="rounded-xl bg-surface-2 p-1.5 sm:p-5">
          <dt className="text-sm text-muted text-balance">順位</dt>
          <dd className="mt-1 flex min-h-10 items-baseline gap-2">
            {result.rank === null ? (
              <span className="text-xl font-bold text-muted">集計対象外</span>
            ) : (
              <span className="text-3xl font-bold sm:text-4xl">{result.rank}位</span>
            )}
            <span className="text-sm font-medium text-muted">/ {result.participantCount}人</span>
          </dd>
        </div>
        <div className="rounded-xl bg-surface-2 p-1.5 sm:p-5">
          <dt className="text-sm text-muted text-balance">得点</dt>
          <dd className="mt-1 flex min-h-10 flex-nowrap items-baseline gap-1 whitespace-nowrap sm:gap-2">
            <span className="text-[clamp(0.75rem,4vw,1.125rem)] font-bold sm:text-4xl">
              {result.score.toFixed(2)}点
            </span>
            <span className="text-[clamp(0.5625rem,2.8vw,0.875rem)] font-medium text-muted">
              / {result.maxScore}点
            </span>
          </dd>
        </div>
      </dl>
      <section className="mt-10" aria-labelledby="answer-details-heading">
        <h2 id="answer-details-heading" className="text-xl font-bold tracking-tight text-balance">
          回答明細
        </h2>
        <ol className="mt-4 space-y-3">
          {result.questions.map((item) => (
            <li
              key={item.position}
              className="min-w-0 rounded-xl border border-border bg-surface-2 p-4 sm:p-5"
            >
              <p className="break-words text-sm font-semibold text-muted [overflow-wrap:anywhere]">
                問題 {item.position + 1}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words font-medium [overflow-wrap:anywhere]">
                {item.question}
              </p>
              <div className="mt-4 border-t border-border/70 pt-3">
                {item.answer.kind === "selected" ? (
                  <>
                    <p className="text-xs font-semibold text-muted">あなたの回答</p>
                    <p className="mt-1 whitespace-pre-wrap break-words">{item.answer.value}</p>
                    <p
                      className={`mt-3 text-sm font-semibold ${item.answer.correctness === "correct" ? "text-success" : item.answer.correctness === "incorrect" ? "text-error" : "text-muted"}`}
                    >
                      {item.answer.correctness === "correct"
                        ? "✓ 正解"
                        : item.answer.correctness === "incorrect"
                          ? "× 不正解"
                          : "回答を確認できません"}
                    </p>
                  </>
                ) : item.answer.kind === "freeText" ? (
                  <>
                    <p className="text-xs font-semibold text-muted">あなたの回答</p>
                    <p className="mt-1 whitespace-pre-wrap break-words">{item.answer.value}</p>
                    <p className="mt-3 text-sm text-muted">
                      {typeof item.answer.score === "number"
                        ? `記録済みスコア: ${item.answer.score.toFixed(2)}`
                        : "設問別スコアは記録されていません"}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted">
                    {item.answer.kind === "unanswered"
                      ? "未回答"
                      : "この回答の詳細は確認できません"}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
