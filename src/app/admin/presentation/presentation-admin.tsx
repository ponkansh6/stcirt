"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./presentation-admin.module.css";

type AdminState = {
  state: string;
  snapshotRevision: number;
  questionIndex: number;
  questionCount: number;
  projectionHidden: boolean;
  participantResultsVisible: boolean;
  participantResultsReady: boolean;
};
type ApiError = Error & { status?: number };
const POLL_TIMEOUT_MS = 8_000;

async function requestSession(
  method: "GET" | "POST",
  body?: { pin: string },
  signal?: AbortSignal,
) {
  const response = await fetch("/api/admin/session", {
    method,
    cache: "no-store",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
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

async function getAdminState(signal: AbortSignal): Promise<AdminState> {
  const response = await fetch("/api/admin/presentation", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    const error = new Error("管理状態を取得できませんでした。") as ApiError;
    error.status = response.status;
    throw error;
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (
    typeof data.snapshotRevision !== "number" ||
    !Number.isInteger(data.snapshotRevision) ||
    data.snapshotRevision < 0 ||
    typeof data.questionIndex !== "number" ||
    !Number.isInteger(data.questionIndex) ||
    data.questionIndex < 0 ||
    typeof data.questionCount !== "number" ||
    !Number.isInteger(data.questionCount) ||
    data.questionCount < 0 ||
    typeof data.projectionHidden !== "boolean" ||
    typeof data.participantResultsVisible !== "boolean" ||
    typeof data.participantResultsReady !== "boolean"
  )
    throw new Error("管理状態を取得できませんでした。");
  return {
    state: typeof data.state === "string" ? data.state : "not_started",
    snapshotRevision: data.snapshotRevision,
    questionIndex: data.questionIndex,
    questionCount: data.questionCount,
    projectionHidden: data.projectionHidden === true,
    participantResultsVisible: data.participantResultsVisible === true,
    participantResultsReady: data.participantResultsReady === true,
  };
}

async function postAction(action: "start" | "hide" | "show" | "aggregate" | "reset") {
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
  opening: "進行中：オープニング",
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const authenticatedRef = useRef(false);
  const [adminState, setAdminState] = useState<AdminState | null>(null);
  const refreshSequence = useRef(0);
  const pollAbortController = useRef<AbortController | null>(null);
  const refreshFlight = useRef<Promise<boolean | null> | null>(null);
  const externalOperationInFlight = useRef(false);
  const loginInFlightRef = useRef(false);
  const updateAuthenticated = useCallback((value: boolean) => {
    authenticatedRef.current = value;
    setAuthenticated(value);
  }, []);

  const performRefresh = useCallback(
    async (checkSession = false): Promise<boolean | null> => {
      const sequence = ++refreshSequence.current;
      const controller = new AbortController();
      pollAbortController.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      try {
        if (checkSession) {
          const session = await requestSession("GET", undefined, controller.signal);
          if (sequence !== refreshSequence.current) return null;
          if (session?.authenticated === false) {
            if (authenticatedRef.current)
              setMessage("管理者セッションの有効期限が切れました。PIN を入力してください。");
            updateAuthenticated(false);
            setAdminState(null);
            return false;
          }
          if (session?.authenticated !== true) {
            setMessage("管理状態を取得できませんでした。自動で再試行しています。");
            return null;
          }
          updateAuthenticated(true);
        }
        // An unchecked refresh only starts from an authenticated poll; a checked refresh sets this ref before reaching here.
        /* v8 ignore if */
        if (!authenticatedRef.current) return false;
        const current = await getAdminState(controller.signal);
        if (sequence === refreshSequence.current) {
          setAdminState(current);
          setMessage(null);
          return true;
        }
        return null;
      } catch (error) {
        if (sequence !== refreshSequence.current) return null;
        if ((error as ApiError).status === 401) {
          updateAuthenticated(false);
          setAdminState(null);
          setMessage("管理者セッションの有効期限が切れました。PIN を入力してください。");
          return false;
        } else {
          setMessage("管理状態を取得できませんでした。自動で再試行しています。");
        }
        return null;
      } finally {
        window.clearTimeout(timeout);
        // Single-flight keeps this invocation as the current controller until it finishes.
        /* v8 ignore else */
        if (pollAbortController.current === controller) pollAbortController.current = null;
      }
    },
    [updateAuthenticated],
  );

  const refresh = useCallback(
    (checkSession = false): Promise<boolean | null> => {
      if (refreshFlight.current) {
        const current = refreshFlight.current;
        return checkSession ? current.then(() => refresh(true)) : current;
      }
      const pending = performRefresh(checkSession);
      refreshFlight.current = pending;
      const clearFlight = () => {
        // Single-flight keeps this promise in the slot until its cleanup runs.
        /* v8 ignore else */
        if (refreshFlight.current === pending) refreshFlight.current = null;
      };
      void pending.then(clearFlight, clearFlight);
      return pending;
    },
    [performRefresh],
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") void refresh(true);
    };
    void refresh(true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      refreshSequence.current += 1;
      pollAbortController.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (!authenticated) return;

    let active = true;
    let timer: number | undefined;
    async function poll() {
      if (!active || document.visibilityState === "hidden") return;
      if (!authenticatedRef.current) return;
      if (externalOperationInFlight.current) {
        schedulePoll();
        return;
      }
      await refresh();
      schedulePoll();
    }
    function schedulePoll() {
      if (!active || document.visibilityState === "hidden" || !authenticatedRef.current) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void poll();
      }, 2500);
    }
    function scheduleAfterCurrentRefresh() {
      const currentRefresh = refreshFlight.current;
      if (currentRefresh) void currentRefresh.then(schedulePoll, schedulePoll);
      else schedulePoll();
    }
    const onVisibilityChange = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (document.visibilityState !== "hidden") scheduleAfterCurrentRefresh();
    };
    scheduleAfterCurrentRefresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [authenticated, refresh]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginInFlightRef.current || pin.length === 0) return;
    loginInFlightRef.current = true;
    externalOperationInFlight.current = true;
    setBusy(true);
    setBusyAction("login");
    setMessage(null);
    try {
      await refreshFlight.current;
      const session = await requestSession("POST", { pin });
      setPin("");
      if (session?.authenticated === true) {
        updateAuthenticated(true);
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
      externalOperationInFlight.current = false;
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function runAction(
    action: "start" | "hide" | "show" | "publish" | "hideResults" | "aggregate" | "reset",
  ) {
    externalOperationInFlight.current = true;
    setBusy(true);
    setBusyAction(action);
    setMessage(null);
    try {
      await refreshFlight.current;
      if (!authenticatedRef.current) return;
      if (action === "publish") await setResultsVisibility(true);
      else if (action === "hideResults") await setResultsVisibility(false);
      else await postAction(action);
      await refresh();
    } catch (error) {
      if ((error as ApiError).status === 401) {
        refreshSequence.current += 1;
        pollAbortController.current?.abort();
        updateAuthenticated(false);
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
      externalOperationInFlight.current = false;
      setBusy(false);
      setBusyAction(null);
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
          <p className={styles.detail}>
            {adminState.snapshotRevision === 0
              ? "まだ集計されていません。開始・結果公開の前に集計してください。"
              : adminState.participantResultsReady
                ? `集計済み（第 ${adminState.snapshotRevision} 世代）`
                : "質問がないため、参加者結果を公開できません。"}
          </p>
          {adminState.state === "question" || adminState.state === "answer" ? (
            <p className={styles.detail}>
              問題 {adminState.questionIndex + 1} / {adminState.questionCount}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={busy}
              onClick={() => void runAction("aggregate")}
            >
              {busyAction === "aggregate" ? "集計しています…" : "集計"}
            </button>
            {adminState.state === "not_started" && (
              <button
                className={styles.primaryButton}
                type="button"
                disabled={busy || adminState.snapshotRevision === 0}
                onClick={() => void runAction("start")}
              >
                {busyAction === "start" ? "開始しています…" : "発表を開始"}
              </button>
            )}
            {adminState.state !== "not_started" && (
              <>
                <button className={styles.primaryButton} type="button" onClick={openProjection}>
                  投影画面を開く / 投影タブへ戻る
                </button>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={busy}
                  onClick={() => void runAction("reset")}
                >
                  {busyAction === "reset" ? "戻しています…" : "最初に戻る"}
                </button>
              </>
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
                  {busyAction === "publish" ? "公開しています…" : "参加者結果を公開"}
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
