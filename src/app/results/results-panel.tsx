"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/Button";
import { parseParticipantResult, type ParticipantResult } from "@/lib/participant-results-contract";

export type InitialResult = ParticipantResult | { state: "unauthenticated" };
type PollResult = ParticipantResult;

export default function ResultsPanel({
  initial,
  scope = "owner",
}: {
  initial: InitialResult;
  scope?: "owner" | "assisted" | null;
}) {
  const [result, setResult] = useState<PollResult>(
    initial.state === "unauthenticated"
      ? { state: "waiting" }
      : (parseParticipantResult(initial) ?? { state: "unavailable" }),
  );
  const [authorized, setAuthorized] = useState(initial.state !== "unauthenticated");
  const [refreshing, setRefreshing] = useState(false);
  const [manuallyRefreshing, setManuallyRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const pendingRef = useRef(false);
  const queuedRef = useRef(false);
  const requestRevisionRef = useRef(0);
  const requestIdRef = useRef(0);
  const inFlightRequestRef = useRef<number | null>(null);

  const answerStatus = (correctness: "correct" | "incorrect") => {
    if (correctness === "correct") {
      return { label: "正解", icon: "✓", className: "text-success" };
    }
    return { label: "不正解", icon: "×", className: "text-error" };
  };

  const refresh = useCallback(
    async (manual = false) => {
      if (scope === null) return;
      if (pendingRef.current) {
        queuedRef.current = true;
        requestRevisionRef.current += 1;
        return;
      }
      pendingRef.current = true;
      setRefreshing(true);
      if (manual) setManuallyRefreshing(true);
      const currentRevision = ++requestRevisionRef.current;
      const requestId = ++requestIdRef.current;
      inFlightRequestRef.current = requestId;
      try {
        const response = await fetch(
          scope === "assisted"
            ? "/api/participants/results?scope=assisted"
            : "/api/participants/results",
          {
            cache: "no-store",
            credentials: "same-origin",
          },
        );
        if (currentRevision !== requestRevisionRef.current) return;
        if (response.status === 401) {
          setAuthorized(false);
          setResult({ state: "waiting" });
          setRefreshError(false);
          return;
        }
        if (!response.ok) {
          setRefreshError(true);
          return;
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          if (currentRevision !== requestRevisionRef.current) return;
          setRefreshError(true);
          return;
        }
        if (currentRevision !== requestRevisionRef.current) return;
        const parsed = parseParticipantResult(payload);
        if (!parsed) {
          setRefreshError(true);
          return;
        }
        setAuthorized(true);
        setResult(parsed);
        setRefreshError(false);
      } catch {
        if (currentRevision === requestRevisionRef.current) setRefreshError(true);
      } finally {
        if (inFlightRequestRef.current === requestId) {
          inFlightRequestRef.current = null;
          pendingRef.current = false;
          setRefreshing(false);
          if (manual) setManuallyRefreshing(false);
          if (queuedRef.current) {
            queuedRef.current = false;
            void refresh();
          }
        }
      }
    },
    [scope],
  );

  useEffect(() => {
    if (scope === null) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      queuedRef.current = false;
      pendingRef.current = false;
      inFlightRequestRef.current = null;
      requestRevisionRef.current += 1;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, scope]);

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
            <h1 className="text-3xl font-bold tracking-tight">
              {scope === "assisted" ? "代理回答者の結果" : "あなたの結果"}
            </h1>
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
                            const status = answerStatus(
                              item.answer.correctness === "correct" ? "correct" : "incorrect",
                            );
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
        ) : (
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {result.state === "waiting" ? "結果はまだ公開されていません" : "結果を確認できません"}
            </h1>
          </div>
        )}
        {refreshError ? (
          <p role="alert" className="mt-4 text-sm text-error">
            結果を更新できませんでした。通信状況を確認して、もう一度お試しください。
          </p>
        ) : null}
        <Button
          variant="outline"
          onClick={() => void refresh(true)}
          disabled={refreshing}
          className="mt-6 self-start"
        >
          結果を再読み込み
        </Button>
      </section>
      {manuallyRefreshing ? (
        <p role="status" aria-live="polite" className="sr-only">
          更新中…
        </p>
      ) : null}
    </main>
  );
}
