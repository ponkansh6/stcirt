import type { ParticipantResult } from "@/lib/participant-results-contract";

const scoreAndRankTextSize =
  "text-[calc(clamp(1.25rem,6vw,1.625rem)_+_2pt)] sm:text-[calc(2.25rem_+_2pt)]";

export default function ParticipantResultDetails({
  result,
  name,
}: {
  result: Extract<ParticipantResult, { state: "visible" }>;
  name?: string;
}) {
  return (
    <>
      <dl className="mt-8 grid grid-cols-2 border-y border-border sm:grid-cols-[1fr_1fr]">
        {name !== undefined ? (
          <div className="col-span-2 min-w-0 border-b border-border px-1 py-4 sm:px-3">
            <dt className="text-sm text-muted text-balance">名前</dt>
            <dd className="mt-1 min-w-0 break-words text-lg font-semibold [overflow-wrap:anywhere]">
              {name}
            </dd>
          </div>
        ) : null}
        <div className="min-w-0 border-r border-border px-2 py-4 sm:px-3 sm:py-6">
          <dt className="text-sm text-muted text-balance">順位</dt>
          <dd className="mt-1 flex min-h-10 flex-wrap items-baseline gap-2">
            {result.isReference && result.equivalentRank !== null ? (
              <span
                className={`${scoreAndRankTextSize} [min-inline-size:0] [max-inline-size:100%] [word-break:keep-all] [overflow-wrap:anywhere] font-bold`}
              >
                {result.equivalentRank}位相当
              </span>
            ) : result.rank === null ? (
              <span className="text-xl font-bold text-muted">集計対象外</span>
            ) : (
              <span
                className={`${scoreAndRankTextSize} [min-inline-size:0] [max-inline-size:100%] [word-break:keep-all] [overflow-wrap:anywhere] font-bold`}
              >
                {result.rank}位
              </span>
            )}
            {!result.isReference && result.rank !== null ? (
              <span className="[min-inline-size:0] [max-inline-size:100%] [word-break:keep-all] [overflow-wrap:anywhere] text-sm font-medium text-muted">
                /{"\u00a0"}
                {result.rankParticipantCount}人
              </span>
            ) : null}
          </dd>
        </div>
        <div className="min-w-0 px-2 py-4 sm:px-3 sm:py-6">
          <dt className="text-sm text-muted text-balance">得点</dt>
          <dd className="mt-1 flex min-h-10 min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5 sm:gap-x-2">
            <span
              className={`${scoreAndRankTextSize} min-w-0 max-w-full font-bold [overflow-wrap:anywhere]`}
            >
              {result.score.toFixed(2)}点
            </span>
            <span className="min-w-0 max-w-full text-[clamp(0.5625rem,2.8vw,0.875rem)] font-medium text-muted [overflow-wrap:anywhere]">
              / {result.maxScore}点
            </span>
          </dd>
        </div>
      </dl>
      <section className="mt-10" aria-labelledby="answer-details-heading">
        <h2 id="answer-details-heading" className="text-xl font-bold tracking-tight text-balance">
          回答明細
        </h2>
        <ol className="mt-4 divide-y divide-border border-y border-border">
          {result.questions.map((item) => (
            <li key={item.position} className="min-w-0 py-5 sm:py-6">
              <p className="break-words text-xs font-bold tracking-[0.12em] text-muted [overflow-wrap:anywhere]">
                QUESTION {String(item.position + 1).padStart(2, "0")}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words font-medium [overflow-wrap:anywhere]">
                {item.question}
              </p>
              <div className="mt-4 border-l-2 border-primary/30 pl-4 pt-1">
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
