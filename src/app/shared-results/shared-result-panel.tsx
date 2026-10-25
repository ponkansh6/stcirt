"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseParticipantResult, type ParticipantResult } from "@/lib/participant-results-contract";
import ParticipantResultDetails from "../results/participant-result-details";

export default function SharedResultPanel({
  token,
  initial,
}: {
  token: string;
  initial: ParticipantResult;
}) {
  const [result, setResult] = useState<ParticipantResult | null>(initial);
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const generation = ++requestGeneration.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/shared-results/${encodeURIComponent(token)}`, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      if (generation !== requestGeneration.current) return;
      if (response.status === 404) {
        setResult(null);
        setRevoked(true);
        setError(false);
        return;
      }
      if (!response.ok) throw new Error("refresh failed");
      const parsed = parseParticipantResult(await response.json());
      if (generation !== requestGeneration.current) return;
      if (!parsed) throw new Error("invalid result");
      setResult(parsed);
      setRevoked(false);
      setError(false);
    } catch {
      if (generation === requestGeneration.current && !controller.signal.aborted) setError(true);
    } finally {
      if (generation === requestGeneration.current) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }, [token]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      requestGeneration.current += 1;
      activeRequest.current?.abort();
    };
  }, [refresh]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
      <section className="rounded-2xl border border-border bg-surface p-7 shadow-sm sm:p-10">
        <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
        <h1 className="text-3xl font-bold tracking-tight">共有された代理回答の結果</h1>
        <p className="mt-3 text-sm text-muted">このページはログイン不要の閲覧専用です。</p>
        {revoked || result === null ? (
          <p className="mt-6 rounded-xl bg-surface-2 p-4 text-muted">
            この共有URLは無効か、期限が切れています。
          </p>
        ) : result.state === "waiting" ? (
          <p className="mt-6 rounded-xl bg-surface-2 p-4 text-muted">
            結果は現在公開されていません。
          </p>
        ) : result.state === "unavailable" ? (
          <p className="mt-6 rounded-xl bg-surface-2 p-4 text-muted">この結果を確認できません。</p>
        ) : (
          <>
            <ParticipantResultDetails result={result} />
          </>
        )}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-error">
            結果を更新できませんでした。通信状況を確認して、もう一度お試しください。
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="mt-6 rounded-lg border border-border px-4 py-2 font-semibold disabled:opacity-60"
        >
          {busy ? "更新中…" : "結果を再読み込み"}
        </button>
      </section>
    </main>
  );
}
