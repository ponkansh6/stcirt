"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import styles from "./reference-participants-settings.module.css";

const maxNames = 500;
const maxNameLength = 120;
const maxInputLength = maxNames * (maxNameLength + 2);
const endpoint = "/api/admin/presentation/reference-participants";
const authenticationMessage =
  "管理者認証が必要です。管理画面を別タブで開いてPIN認証を行い、この画面に戻って認証状態を再確認してください。入力内容はこの画面内に保持されます。";

type AccessState = "loading" | "ready" | "unauthenticated" | "load-error";
type Message = { kind: "success" | "error"; text: string } | null;

export default function ReferenceParticipantsSettings() {
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [access, setAccess] = useState<AccessState>("loading");
  const [recoveryFrom, setRecoveryFrom] = useState<"auth" | "load-error" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recoveryButtonRef = useRef<HTMLButtonElement>(null);
  const restoreInputFocus = useRef(false);
  const hasInitializedDraft = useRef(false);
  const requestSequence = useRef(0);
  const getInFlight = useRef(false);
  const getController = useRef<AbortController | null>(null);
  const hasChanges = text !== savedText;
  const canEdit = access === "ready" && !busy;

  const loadSettings = useCallback(async (recovery?: "auth" | "load-error") => {
    if (getInFlight.current) return;

    getInFlight.current = true;
    if (recovery) {
      setRecoveryFrom(recovery);
      setAccess("loading");
      setMessage(null);
    }
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    getController.current = controller;

    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });

      if (sequence !== requestSequence.current) return;
      if (response.status === 401) {
        setAccess("unauthenticated");
        setRecoveryFrom("auth");
        setMessage({ kind: "error", text: authenticationMessage });
        return;
      }
      if (!response.ok) {
        setAccess("load-error");
        setRecoveryFrom("load-error");
        setMessage({
          kind: "error",
          text: "設定を読み込めませんでした。時間をおいて再試行してください。",
        });
        return;
      }

      const payload = (await response.json().catch(() => null)) as {
        names?: unknown;
      } | null;
      if (sequence !== requestSequence.current) return;
      if (
        !Array.isArray(payload?.names) ||
        !payload.names.every((name) => typeof name === "string")
      ) {
        setAccess("load-error");
        setRecoveryFrom("load-error");
        setMessage({ kind: "error", text: "設定の形式を確認できませんでした。" });
        return;
      }

      setAccess("ready");
      setRecoveryFrom(null);
      setMessage(null);
      restoreInputFocus.current = document.activeElement === recoveryButtonRef.current;
      if (!hasInitializedDraft.current) {
        const loaded = payload.names.join("\n");
        setText(loaded);
        setSavedText(loaded);
        hasInitializedDraft.current = true;
      }
    } catch {
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setAccess("load-error");
        setRecoveryFrom("load-error");
        setMessage({
          kind: "error",
          text: "設定を読み込めませんでした。通信状態を確認して再試行してください。",
        });
      }
    } finally {
      if (sequence === requestSequence.current) {
        getInFlight.current = false;
        getController.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    getInFlight.current = true;
    getController.current = controller;

    void (async () => {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (sequence !== requestSequence.current) return;
        if (response.status === 401) {
          setAccess("unauthenticated");
          setRecoveryFrom("auth");
          setMessage({ kind: "error", text: authenticationMessage });
          return;
        }
        if (!response.ok) {
          setAccess("load-error");
          setRecoveryFrom("load-error");
          setMessage({
            kind: "error",
            text: "設定を読み込めませんでした。時間をおいて再試行してください。",
          });
          return;
        }

        const payload = (await response.json().catch(() => null)) as {
          names?: unknown;
        } | null;
        if (sequence !== requestSequence.current) return;
        if (
          !Array.isArray(payload?.names) ||
          !payload.names.every((name) => typeof name === "string")
        ) {
          setAccess("load-error");
          setRecoveryFrom("load-error");
          setMessage({ kind: "error", text: "設定の形式を確認できませんでした。" });
          return;
        }

        setAccess("ready");
        setMessage(null);
        if (!hasInitializedDraft.current) {
          const loaded = payload.names.join("\n");
          setText(loaded);
          setSavedText(loaded);
          hasInitializedDraft.current = true;
        }
      } catch {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setAccess("load-error");
          setRecoveryFrom("load-error");
          setMessage({
            kind: "error",
            text: "設定を読み込めませんでした。通信状態を確認して再試行してください。",
          });
        }
      } finally {
        if (sequence === requestSequence.current) {
          getInFlight.current = false;
          getController.current = null;
        }
      }
    })();

    return () => {
      requestSequence.current += 1;
      controller.abort();
      getController.current = null;
      getInFlight.current = false;
    };
  }, []);

  useEffect(() => {
    if (access === "ready" && restoreInputFocus.current) {
      textareaRef.current?.focus();
      restoreInputFocus.current = false;
    }
  }, [access]);

  async function save() {
    if (access !== "ready" || busy || getInFlight.current) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namesText: text }),
      });
      if (response.status === 401) {
        setAccess("unauthenticated");
        setRecoveryFrom("auth");
        setMessage({ kind: "error", text: authenticationMessage });
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        names?: unknown;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.error ?? "設定を保存できませんでした。");
      if (
        !Array.isArray(payload?.names) ||
        !payload.names.every((name) => typeof name === "string")
      )
        throw new Error("保存結果の形式を確認できませんでした。");
      const saved = payload.names.join("\n");
      setText(saved);
      setSavedText(saved);
      setMessage({
        kind: "success",
        text: "参考対象氏名を保存しました。管理画面へ戻り、集計を実行してください。",
      });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "設定を保存できませんでした。",
      });
    } finally {
      setBusy(false);
    }
  }

  function returnToAdmin(event: MouseEvent<HTMLAnchorElement>) {
    if (!hasChanges) return;
    if (!window.confirm("保存していない変更は破棄されます。管理画面へ戻りますか？")) {
      event.preventDefault();
    }
  }

  const recoveryKind =
    access === "unauthenticated" ? "auth" : access === "load-error" ? "load-error" : recoveryFrom;
  const showRecovery = recoveryKind !== null;

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="reference-title">
        <h1 id="reference-title">参考対象氏名</h1>
        <p className={styles.intro}>
          1行に1名ずつ入力します。参加者の表示名と完全一致した有効な提出者は、通常順位と表彰から除外され、本人の結果に「位相当」を表示します。
        </p>
        <p className={styles.note}>
          前後の空白を含め、入力した名前は加工せず照合します。空行と空白だけの行は無視されます。最大
          {maxNames}名、1行{maxNameLength}文字までです。
        </p>
        <label className={styles.label} htmlFor="reference-names">
          参考対象の表示名（改行区切り）
        </label>
        <textarea
          id="reference-names"
          ref={textareaRef}
          className={styles.textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={12}
          maxLength={maxInputLength}
          disabled={!canEdit}
          aria-describedby="reference-guidance"
        />
        <p id="reference-guidance" className={styles.note}>
          保存後、管理画面へ戻って「集計」を実行すると保存済みの氏名一覧が反映されます。入力を変更しただけでは公開結果は変わりません。
        </p>
        {access === "loading" && !showRecovery ? (
          <p className={styles.note} role="status" aria-live="polite">
            設定を読み込んでいます…
          </p>
        ) : showRecovery ? (
          <div className={styles.guidance}>
            {access === "loading" ? (
              <p className={styles.note} role="status" aria-live="polite">
                {recoveryKind === "auth"
                  ? "認証状態を再確認しています…"
                  : "設定を再読み込みしています…"}
              </p>
            ) : (
              <p className={styles.error} role="alert">
                {recoveryKind === "auth"
                  ? authenticationMessage
                  : message?.kind === "error"
                    ? message.text
                    : "設定を読み込めませんでした。"}
              </p>
            )}
            <div className={styles.recoveryActions}>
              <button
                className={styles.secondaryButton}
                type="button"
                ref={recoveryButtonRef}
                aria-disabled={busy || access === "loading"}
                onClick={() => {
                  if (busy || getInFlight.current) return;
                  void loadSettings(recoveryKind ?? "load-error");
                }}
              >
                {recoveryKind === "auth" ? "認証状態を再確認" : "設定を再読み込み"}
              </button>
              {recoveryKind === "auth" ? (
                <a
                  className={styles.secondaryButton}
                  href="/admin/presentation"
                  target="_blank"
                  rel="noreferrer"
                >
                  管理画面でPIN認証
                </a>
              ) : null}
            </div>
          </div>
        ) : message ? (
          <p className={message.kind === "success" ? styles.success : styles.error} role="status">
            {message.text}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="button"
            disabled={!canEdit}
            onClick={() => void save()}
          >
            {busy ? "保存しています…" : "氏名一覧を保存"}
          </button>
          <Link
            className={styles.secondaryButton}
            href="/admin/presentation"
            onClick={returnToAdmin}
          >
            管理画面へ戻る
          </Link>
        </div>
      </section>
    </main>
  );
}
