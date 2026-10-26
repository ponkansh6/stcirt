"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/Button";
import ShareManager from "./share-manager";
import ParticipantResultDetails from "./participant-result-details";
import { parseParticipantResult, type ParticipantResult } from "@/lib/participant-results-contract";

export type InitialResult = ParticipantResult | { state: "unauthenticated" };
type PollResult = ParticipantResult;

export default function ResultsPanel({
  initial,
  participantName,
  scope = "owner",
  hasAssistedSubmission = false,
}: {
  initial: InitialResult;
  participantName?: string;
  scope?: "owner" | "assisted" | null;
  hasAssistedSubmission?: boolean;
}) {
  const [result, setResult] = useState<PollResult>(
    initial.state === "unauthenticated"
      ? { state: "waiting" }
      : (parseParticipantResult(initial) ?? { state: "unavailable" }),
  );
  const [authorized, setAuthorized] = useState(initial.state !== "unauthenticated");
  const [manuallyRefreshing, setManuallyRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const pendingRef = useRef(false);
  const queuedRef = useRef(false);
  const requestRevisionRef = useRef(0);
  const requestIdRef = useRef(0);
  const inFlightRequestRef = useRef<number | null>(null);
  const currentStatusKey = authorized ? result.state : "session-expired";
  const previousStatusKeyRef = useRef(currentStatusKey);
  const pendingStatusAnnouncementRef = useRef<string | null>(null);
  const waitingNoticeIssuedRef = useRef(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");

  const refresh = useCallback((activeScope: NonNullable<typeof scope>, manual = false) => {
    const poll = async (): Promise<void> => {
      if (pendingRef.current) {
        queuedRef.current = true;
        requestRevisionRef.current += 1;
        return;
      }
      pendingRef.current = true;
      if (manual) {
        setStatusAnnouncement("");
        setManuallyRefreshing(true);
      }
      const currentRevision = ++requestRevisionRef.current;
      const requestId = ++requestIdRef.current;
      inFlightRequestRef.current = requestId;
      try {
        const response = await fetch(
          activeScope === "assisted"
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
        if (manual && parsed.state === "waiting" && !waitingNoticeIssuedRef.current) {
          waitingNoticeIssuedRef.current = true;
          pendingStatusAnnouncementRef.current = "集計期間中です。結果は公開後に確認できます。";
        }
        setRefreshError(false);
      } catch {
        if (currentRevision === requestRevisionRef.current) setRefreshError(true);
      } finally {
        if (inFlightRequestRef.current === requestId) {
          inFlightRequestRef.current = null;
          pendingRef.current = false;
          if (manual) setManuallyRefreshing(false);
          if (queuedRef.current) {
            queuedRef.current = false;
            void poll();
          }
        }
      }
    };

    void poll();
  }, []);

  useEffect(() => {
    if (scope === null) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh(scope);
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

  useEffect(() => {
    if (currentStatusKey !== previousStatusKeyRef.current) {
      previousStatusKeyRef.current = currentStatusKey;
      if (authorized && result.state !== "waiting") {
        waitingNoticeIssuedRef.current = false;
      }
      if (!authorized) {
        pendingStatusAnnouncementRef.current =
          "参加者セッションを確認できません。回答画面からもう一度参加してください。";
      } else if (result.state === "waiting") {
        if (!waitingNoticeIssuedRef.current) {
          waitingNoticeIssuedRef.current = true;
          pendingStatusAnnouncementRef.current = "集計期間中です。結果は公開後に確認できます。";
        }
      } else {
        pendingStatusAnnouncementRef.current =
          result.state === "unavailable"
            ? "あなたの結果を確認できません。時間をおいて再読み込みしてください。"
            : "結果を表示しました。";
      }
    }

    if (!manuallyRefreshing && pendingStatusAnnouncementRef.current) {
      setStatusAnnouncement(pendingStatusAnnouncementRef.current);
      pendingStatusAnnouncementRef.current = null;
    }
  }, [authorized, currentStatusKey, manuallyRefreshing, result.state]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
      <section className="rounded-2xl border border-border bg-surface p-7 shadow-sm sm:p-10">
        <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
        {!authorized ? (
          <>
            <h1 className="text-3xl font-bold tracking-tight text-balance">
              参加者セッションを確認できません
            </h1>
            <p className="mt-4 text-muted text-pretty">回答画面からもう一度参加してください。</p>
            <Link className="mt-8 inline-flex font-semibold text-primary underline" href="/answer">
              回答画面へ戻る
            </Link>
          </>
        ) : result.state === "visible" ? (
          <>
            <h1 className="text-3xl font-bold tracking-tight text-balance">
              {scope === "assisted" ? "代理回答の結果" : "あなたの結果"}
            </h1>
            <ParticipantResultDetails result={result} name={participantName} />
            <Link className="mt-8 inline-flex font-semibold text-primary underline" href="/answer">
              回答画面へ戻る
            </Link>
          </>
        ) : result.state === "waiting" ? null : (
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-balance">結果を確認できません</h1>
            <p className="mt-4 rounded-xl border border-border bg-surface-2 p-4 text-sm text-muted text-pretty">
              あなたの結果を確認できません。時間をおいて再読み込みしてください。
            </p>
          </div>
        )}
        {refreshError ? (
          <p role="alert" className="mt-4 text-sm text-error text-pretty">
            結果を更新できませんでした。通信状況を確認して、もう一度お試しください。
          </p>
        ) : null}
        {scope !== null && authorized && (
          <nav aria-label="結果の切り替え" className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
            {scope === "assisted" ? (
              <Link className="font-semibold text-primary underline" href="/results">
                自分の結果を見る
              </Link>
            ) : hasAssistedSubmission ? (
              <Link className="font-semibold text-primary underline" href="/results?scope=assisted">
                代理回答の結果を見る
              </Link>
            ) : null}
          </nav>
        )}
        {scope === "assisted" && authorized && hasAssistedSubmission ? (
          <ShareManager canIssue={result.state === "visible"} />
        ) : null}
        {scope !== null ? (
          <Button
            variant="outline"
            onClick={() => void refresh(scope, true)}
            loading={manuallyRefreshing}
            disabled={manuallyRefreshing}
            aria-label="結果を再読み込み"
            className="mt-6 self-start"
          >
            {manuallyRefreshing ? "更新中…" : "結果を再読み込み"}
          </Button>
        ) : null}
      </section>
      {statusAnnouncement ? (
        <p role="status" aria-live="polite" className="sr-only">
          {statusAnnouncement}
        </p>
      ) : null}
      {manuallyRefreshing ? (
        <p role="status" aria-live="polite" className="sr-only">
          更新中…
        </p>
      ) : null}
    </main>
  );
}
