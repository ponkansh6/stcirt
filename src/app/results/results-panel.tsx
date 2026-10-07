"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export type InitialResult =
  | { state: "waiting" }
  | { state: "unavailable" }
  | { state: "unauthenticated" }
  | {
      state: "visible";
      score: number;
      rank: number;
      questions: ResultQuestion[];
    };

type ResultQuestion = {
  position: number;
  question: string;
  answer:
    | { kind: "selected"; value: string; correctness: "correct" | "incorrect" | "unavailable" }
    | { kind: "freeText"; value: string; score: number | null }
    | { kind: "unanswered" }
    | { kind: "legacy" };
};

type PollResult = Exclude<InitialResult, { state: "unauthenticated" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isNormalizedScore = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;

const parsePollResult = (payload: unknown): PollResult => {
  if (!isRecord(payload)) return { state: "unavailable" };
  if (payload.state === "waiting") return { state: "waiting" };
  if (payload.state === "unavailable") return { state: "unavailable" };
  if (
    payload.state !== "visible" ||
    !isPositiveInteger(payload.rank) ||
    !isFiniteNumber(payload.score) ||
    !Array.isArray(payload.questions) ||
    payload.questions.length === 0
  ) {
    return { state: "unavailable" };
  }

  const questions: ResultQuestion[] = [];
  for (const candidate of payload.questions) {
    if (
      !isRecord(candidate) ||
      !isNonNegativeInteger(candidate.position) ||
      typeof candidate.question !== "string" ||
      !isRecord(candidate.answer)
    ) {
      return { state: "unavailable" };
    }

    const answer = candidate.answer;
    if (
      answer.kind === "selected" &&
      typeof answer.value === "string" &&
      (answer.correctness === "correct" ||
        answer.correctness === "incorrect" ||
        answer.correctness === "unavailable")
    ) {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: {
          kind: "selected",
          value: answer.value,
          correctness: answer.correctness,
        },
      });
    } else if (
      answer.kind === "freeText" &&
      typeof answer.value === "string" &&
      (answer.score === null || isNormalizedScore(answer.score))
    ) {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: { kind: "freeText", value: answer.value, score: answer.score },
      });
    } else if (answer.kind === "unanswered") {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: { kind: "unanswered" },
      });
    } else if (answer.kind === "legacy") {
      questions.push({
        position: candidate.position,
        question: candidate.question,
        answer: { kind: "legacy" },
      });
    } else {
      return { state: "unavailable" };
    }
  }

  if (payload.score < 0 || payload.score > questions.length) {
    return { state: "unavailable" };
  }

  return {
    state: "visible",
    score: payload.score,
    rank: payload.rank,
    questions,
  };
};

export default function ResultsPanel({ initial }: { initial: InitialResult }) {
  const [result, setResult] = useState<PollResult>(
    initial.state === "unauthenticated" ? { state: "waiting" } : parsePollResult(initial),
  );
  const [authorized, setAuthorized] = useState(initial.state !== "unauthenticated");

  const answerStatus = (correctness: "correct" | "incorrect" | "unavailable") => {
    if (correctness === "correct") {
      return {
        label: "正解",
        icon: "✓",
        className: "text-success",
      };
    }
    if (correctness === "incorrect") {
      return {
        label: "不正解",
        icon: "×",
        className: "text-error",
      };
    }
    return {
      label: "判定できません",
      icon: "？",
      className: "text-muted",
    };
  };

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/participants/results", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!active) return;
        if (response.status === 401) {
          setAuthorized(false);
          setResult({ state: "waiting" });
          return;
        }
        if (!response.ok) return;
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          setAuthorized(true);
          setResult({ state: "unavailable" });
          return;
        }
        setAuthorized(true);
        setResult(parsePollResult(payload));
      } catch {
        // Keep the last server-confirmed state until the next no-store poll.
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
      <section className="rounded-2xl border border-border bg-surface p-7 shadow-sm sm:p-10">
        <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
        {!authorized ? (
          <>
            <h1 className="text-3xl font-bold tracking-tight">参加者セッションを確認できません</h1>
            <p className="mt-4 text-muted">回答画面からもう一度参加してください。</p>
            <Link className="mt-8 inline-flex font-semibold text-primary underline" href="/answer">
              回答画面へ戻る
            </Link>
          </>
        ) : result.state === "visible" ? (
          <>
            <h1 className="text-3xl font-bold tracking-tight">あなたの結果</h1>
            <dl className="mt-8 grid grid-cols-2 gap-4">
              <div className="rounded-xl bg-surface-2 p-5">
                <dt className="text-sm text-muted">順位</dt>
                <dd className="mt-1 text-3xl font-bold">{result.rank}位</dd>
              </div>
              <div className="rounded-xl bg-surface-2 p-5">
                <dt className="text-sm text-muted">得点</dt>
                <dd className="mt-1 text-3xl font-bold">{result.score}点</dd>
              </div>
            </dl>
            <section className="mt-10" aria-labelledby="answer-details-heading">
              <h2 id="answer-details-heading" className="text-xl font-bold tracking-tight">
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
                      {item.answer.kind === "selected" &&
                      item.answer.correctness === "unavailable" ? (
                        <p className="text-sm font-medium text-muted">回答を確認できません</p>
                      ) : item.answer.kind === "selected" ? (
                        <>
                          <p className="text-xs font-semibold tracking-wide text-muted">
                            あなたの回答
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                            {item.answer.value}
                          </p>
                          {(() => {
                            const status = answerStatus(item.answer.correctness);
                            return (
                              <p
                                className={`mt-3 inline-flex items-center gap-2 text-sm font-semibold ${status.className}`}
                              >
                                <span aria-hidden="true" className="text-base leading-none">
                                  {status.icon}
                                </span>
                                <span>{status.label}</span>
                              </p>
                            );
                          })()}
                        </>
                      ) : item.answer.kind === "freeText" ? (
                        <>
                          <p className="text-xs font-semibold tracking-wide text-muted">
                            あなたの回答
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                            {item.answer.value}
                          </p>
                          {typeof item.answer.score === "number" ? (
                            <p className="mt-3 text-sm text-muted">
                              記録済みスコア:{" "}
                              <span className="font-semibold text-text">{item.answer.score}</span>
                            </p>
                          ) : (
                            <p className="mt-3 text-sm text-muted">
                              設問別スコアは記録されていません
                            </p>
                          )}
                        </>
                      ) : item.answer.kind === "unanswered" ? (
                        <p className="text-sm font-medium text-muted">未回答</p>
                      ) : (
                        <p className="text-sm font-medium text-muted">
                          この回答の詳細は確認できません
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <Link className="mt-8 inline-flex font-semibold text-primary underline" href="/answer">
              回答画面へ戻る
            </Link>
          </>
        ) : result.state === "unavailable" ? (
          <>
            <h1 className="text-3xl font-bold tracking-tight">結果を確認できません</h1>
            <p className="mt-4 text-muted">あなたの結果はまだ準備されていません。</p>
          </>
        ) : (
          <h1 className="text-3xl font-bold tracking-tight" role="status" aria-live="polite">
            回答中
          </h1>
        )}
      </section>
    </main>
  );
}
