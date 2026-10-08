"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./presentation-admin.module.css";

type AdminState = {
  state: string;
  questionIndex: number;
  questionCount: number;
  projectionHidden: boolean;
  participantResultsVisible: boolean;
  participantResultsReady: boolean;
};
type ApiError = Error & { status?: number };

async function requestSession(method: "GET" | "POST", body?: { pin: string }) {
  const response = await fetch("/api/admin/session", {
    method,
    cache: "no-store",
    credentials: "same-origin",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const payload = (await response.json().catch(() => null)) as {
    authenticated?: unknown;
    error?: string;
  } | null;
  if (!response.ok) {
    const error = new Error(payload?.error ?? "ログインできませんでした。") as ApiError;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function getAdminState(): Promise<AdminState> {
  const response = await fetch("/api/admin/presentation", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const error = new Error("管理状態を取得できませんでした。") as ApiError;
    error.status = response.status;
    throw error;
  }
  const data = (await response.json()) as Record<string, unknown>;
  return {
    state: typeof data.state === "string" ? data.state : "not_started",
    questionIndex: typeof data.questionIndex === "number" ? data.questionIndex : 0,
    questionCount: typeof data.questionCount === "number" ? data.questionCount : 0,
    projectionHidden: data.projectionHidden === true,
    participantResultsVisible: data.participantResultsVisible === true,
    participantResultsReady: data.participantResultsReady === true,
  };
}

async function postAction(action: "start" | "hide" | "show") {
  const response = await fetch("/api/admin/presentation", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: crypto.randomUUID(), action }),
  });
  if (!response.ok) {
    const error = new Error("操作を反映できませんでした。") as ApiError;
    error.status = response.status;
    throw error;
  }
}

async function setResultsVisibility(visible: boolean) {
  const response = await fetch("/api/admin/participant-results", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visible }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    const error = new Error(payload?.error ?? "結果を公開できませんでした。") as ApiError;
    error.status = response.status;
    throw error;
  }
}

const stateLabels: Record<string, string> = {
  not_started: "未開始",
  question: "進行中：問題",
  answer: "進行中：解答",
  podium_preview: "進行中：結果発表前",
  third: "進行中：第3位",
  second: "進行中：第2位",
  first: "進行中：第1位",
  finished: "終了",
};

export default function PresentationAdmin() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [adminState, setAdminState] = useState<AdminState | null>(null);
  const refreshSequence = useRef(0);
  const loginInFlightRef = useRef(false);

  const refresh = useCallback(async (): Promise<boolean | null> => {
    const sequence = ++refreshSequence.current;
    try {
      const session = await requestSession("GET");
      if (sequence !== refreshSequence.current) return null;
      if (session?.authenticated !== true) {
        if (authenticated)
          setMessage("管理者セッションの有効期限が切れました。PIN を入力してください。");
        setAuthenticated(false);
        setAdminState(null);
        return false;
      }
      setAuthenticated(true);
      const current = await getAdminState();
      if (sequence === refreshSequence.current) {
        setAdminState(current);
        setMessage(null);
        return true;
      }
      return null;
    } catch (error) {
      if (sequence !== refreshSequence.current) return null;
      if ((error as ApiError).status === 401) {
        setAuthenticated(false);
        setAdminState(null);
        setMessage("管理者セッションの有効期限が切れました。PIN を入力してください。");
        return false;
      } else if (authenticated) {
        setMessage("管理状態を取得できませんでした。自動で再試行しています。");
      }
      return null;
    }
  }, [authenticated]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginInFlightRef.current || pin.length === 0) return;
    loginInFlightRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const session = await requestSession("POST", { pin });
      setPin("");
      if (session?.authenticated === true) {
        setAuthenticated(true);
        setMessage(null);
        await refresh();
      } else setMessage("管理者セッションを確認できませんでした。");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "ログインできませんでした。";
      setMessage(
        errorMessage === "Invalid PIN"
          ? "PIN が一致しません。入力内容をご確認ください。"
          : errorMessage,
      );
    } finally {
      loginInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function runAction(action: "start" | "hide" | "show" | "publish" | "hideResults") {
    setBusy(true);
    setMessage(null);
    try {
      if (action === "publish") await setResultsVisibility(true);
      else if (action === "hideResults") await setResultsVisibility(false);
      else await postAction(action);
      await refresh();
    } catch (error) {
      if ((error as ApiError).status === 401) {
        setAuthenticated(false);
        setAdminState(null);
        setMessage("管理者セッションの有効期限が切れました。PIN を入力してください。");
      } else {
        const failureMessage =
          action === "publish" || action === "hideResults"
            ? "結果の準備または公開に失敗しました。状態を確認して再試行してください。"
            : "操作を反映できませんでした。状態を再確認してから再試行してください。";
        const refreshed = await refresh();
        if (refreshed === true) setMessage(failureMessage);
      }
    } finally {
      setBusy(false);
    }
  }

  function openProjection() {
    window.open("/presentation?presenter=1", "stcirt-presentation");
  }

  if (authenticated && !adminState) {
    return (
      <main className={styles.shell}>
        <section className={styles.console} aria-labelledby="admin-title">
          <p className={styles.eyebrow}>STCIRT · HOST CONSOLE</p>
          <h1 id="admin-title">披露宴 発表操作</h1>
          {message ? (
            <p className={styles.error} role="alert">
              {message}
            </p>
          ) : (
            <p className={styles.state} role="status">
              管理状態を取得しています…
            </p>
          )}
        </section>
      </main>
    );
  }

  if (authenticated && adminState) {
    const label = stateLabels[adminState.state] ?? "状態を確認中";
    return (
      <main className={styles.shell}>
        <section className={styles.console} aria-labelledby="admin-title">
          <p className={styles.eyebrow}>STCIRT · HOST CONSOLE</p>
          <h1 id="admin-title">披露宴 発表操作</h1>
          <p className={styles.state} role="status">
            現在の状態：{label}
          </p>
          {adminState.state === "question" || adminState.state === "answer" ? (
            <p className={styles.detail}>
              問題 {adminState.questionIndex + 1} / {adminState.questionCount}
            </p>
          ) : null}
          <div className={styles.actions}>
            {adminState.state === "not_started" && (
              <button
                className={styles.primaryButton}
                type="button"
                disabled={busy}
                onClick={() => void runAction("start")}
              >
                {busy ? "開始しています…" : "発表を開始"}
              </button>
            )}
            {adminState.state !== "not_started" && (
              <button className={styles.primaryButton} type="button" onClick={openProjection}>
                投影画面を開く / 投影タブへ戻る
              </button>
            )}
            {adminState.state === "finished" &&
              (adminState.participantResultsVisible ? (
                <>
                  <p className={styles.success} role="status">
                    参加者結果は公開済みです
                  </p>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    disabled={busy}
                    onClick={() => void runAction("hideResults")}
                  >
                    参加者結果を非公開
                  </button>
                </>
              ) : (
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={busy || !adminState.participantResultsReady}
                  onClick={() => void runAction("publish")}
                >
                  {busy ? "公開しています…" : "参加者結果を公開"}
                </button>
              ))}
            {adminState.state !== "not_started" && (
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={busy}
                onClick={() => void runAction(adminState.projectionHidden ? "show" : "hide")}
              >
                {adminState.projectionHidden ? "投影を表示" : "投影を一時非表示"}
              </button>
            )}
          </div>
          {message && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
          <p className={styles.loginFoot}>
            投影画面は別タブで開きます。開始・公開操作はこの画面で行います。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <section className={styles.loginCard} aria-labelledby="admin-title">
        <p className={styles.eyebrow}>STCIRT · HOST CONSOLE</p>
        <h1 id="admin-title">披露宴 発表操作</h1>
        <p className={styles.loginIntro}>司会者用 PIN を入力して、発表を管理します。</p>
        <form className={styles.loginForm} onSubmit={handleLogin}>
          <label htmlFor="admin-pin">管理者 PIN</label>
          <input
            id="admin-pin"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            required
            aria-describedby={message ? "admin-message" : undefined}
          />
          <button
            className={styles.primaryButton}
            type="submit"
            disabled={busy || pin.length === 0}
          >
            {busy ? "確認中…" : "管理ページにログイン"}
          </button>
        </form>
        {message && (
          <p id="admin-message" className={styles.error} role="alert">
            {message}
          </p>
        )}
        <p className={styles.loginFoot}>認証後もこの管理ページに留まります。</p>
      </section>
    </main>
  );
}
