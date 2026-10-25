"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import {
  isAssistedResultShareState,
  type AssistedResultShareState,
} from "@/lib/assisted-result-share-contract";

export default function ShareManager({ canIssue }: { canIssue: boolean }) {
  const [state, setState] = useState<AssistedResultShareState | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pendingRef = useRef(false);

  const load = async () => {
    try {
      const response = await fetch("/api/participants/results/share", { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && isAssistedResultShareState(payload)) setState(payload);
      else setMessage("共有状態を読み込めませんでした。");
    } catch {
      setMessage("共有状態を読み込めませんでした。");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const issue = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setMessage("");
    setShareUrl("");
    try {
      const response = await fetch("/api/participants/results/share", {
        method: "POST",
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || typeof payload.path !== "string") {
        setMessage(
          payload.error === "SHARE_NOT_PUBLISHED"
            ? "結果公開中のみ発行できます。"
            : "共有URLを発行できませんでした。",
        );
      } else {
        setShareUrl(new URL(payload.path, window.location.origin).toString());
        setState({
          exists: true,
          issuedAt: payload.issuedAt,
          expiresAt: payload.expiresAt,
          expired: false,
        });
        setMessage("再発行すると以前のURLは使えなくなります。URLを本人へ共有してください。");
      }
    } catch {
      setMessage("共有URLを発行できませんでした。");
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  };

  const stop = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setMessage("");
    setShareUrl("");
    try {
      const response = await fetch("/api/participants/results/share", {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("stop failed");
      setState({ exists: false, issuedAt: null, expiresAt: null, expired: false });
      setMessage("共有を停止しました。");
    } catch {
      setMessage("共有を停止できませんでした。もう一度お試しください。");
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMessage("共有URLをコピーしました。");
    } catch {
      setMessage("コピーできませんでした。URL欄を選択して手動でコピーしてください。");
    }
  };

  return (
    <section className="mt-8 border-t border-border pt-6" aria-labelledby="share-heading">
      <h2 id="share-heading" className="text-lg font-bold">
        代理回答結果を共有
      </h2>
      <p className="mt-2 text-sm text-muted">
        URLを知っている人はログインなしで閲覧できます。有効期間は発行から30日です。
      </p>
      <p className="mt-1 text-sm text-muted">
        URLを転送すると受け取った人も閲覧できます。共有停止後も、すでに取得・保存された情報は回収できません。
      </p>
      {state?.exists ? (
        <div className="mt-3 text-sm text-muted">
          <p>
            {state.expired ? "共有URLは期限切れです。" : "共有URLを発行済みです。"}
            {state.issuedAt ? ` 発行日: ${new Date(state.issuedAt).toLocaleString("ja-JP")}` : ""}
            {state.expiresAt
              ? ` 有効期限: ${new Date(state.expiresAt).toLocaleString("ja-JP")}`
              : ""}
          </p>
          <p className="mt-1">再発行すると、現在のURLはすぐに無効になります。</p>
        </div>
      ) : null}
      {shareUrl ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            aria-label="共有URL"
            readOnly
            value={shareUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <Button variant="outline" onClick={() => void copy()}>
            URLをコピー
          </Button>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button onClick={() => void issue()} disabled={busy || !canIssue}>
          {busy ? "処理中…" : state?.exists ? "共有URLを再発行" : "共有URLを発行"}
        </Button>
        {state?.exists ? (
          <Button variant="outline" onClick={() => void stop()} disabled={busy}>
            共有を停止
          </Button>
        ) : null}
      </div>
      {!canIssue ? (
        <p className="mt-2 text-sm text-muted">結果が公開されると発行・再発行できます。</p>
      ) : null}
      {message ? (
        <p role="status" className="mt-3 text-sm text-muted">
          {message}
        </p>
      ) : null}
    </section>
  );
}
