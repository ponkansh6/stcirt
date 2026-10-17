"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import styles from "./presentation-admin.module.css";

type AdminState = {
  state: string;
  snapshotRevision: number;
  questionIndex: number;
  questionCount: number;
  participantResultsVisible: boolean;
  participantResultsReady: boolean;
};
type ApiError = Error & { status?: number };
type AggregationSummary = {
  snapshotUpdated: boolean;
  includedSubmissionCount: number;
  excludedSubmissionCount: number;
  excludedReasonCounts: {
    questionVersionMismatch: number;
    q5AssessmentVersionMismatch: number;
  };
};
const POLL_TIMEOUT_MS = 8_000;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function requestSession(body: { pin: string }) {
  const response = await fetch("/api/admin/session", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

async function getSessionStatus(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/admin/session", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const payload = (await response.json().catch(() => null)) as {
    authenticated?: unknown;
  } | null;
  if (!response.ok || typeof payload?.authenticated !== "boolean") {
    const error = new Error("管理者セッションを確認できませんでした。") as ApiError;
    error.status = response.status;
    throw error;
  }
  return payload.authenticated;
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
    typeof data.participantResultsVisible !== "boolean" ||
    typeof data.participantResultsReady !== "boolean"
  )
    throw new Error("管理状態を取得できませんでした。");
  return {
    state: typeof data.state === "string" ? data.state : "not_started",
    snapshotRevision: data.snapshotRevision,
    questionIndex: data.questionIndex,
    questionCount: data.questionCount,
    participantResultsVisible: data.participantResultsVisible === true,
    participantResultsReady: data.participantResultsReady === true,
  };
}

async function postAction(action: "start" | "aggregate" | "reset") {
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
  if (action !== "aggregate") return null;

  const payload = (await response.json().catch(() => null)) as {
    aggregationSummary?: {
      snapshotUpdated?: unknown;
      includedSubmissionCount?: unknown;
      excludedSubmissionCount?: unknown;
      excludedReasonCounts?: {
        questionVersionMismatch?: unknown;
        q5AssessmentVersionMismatch?: unknown;
      };
    };
  } | null;
  const summary = payload?.aggregationSummary;
  const reasonCounts = summary?.excludedReasonCounts;
  if (
    !summary ||
    !reasonCounts ||
    typeof summary.snapshotUpdated !== "boolean" ||
    !isCount(summary.includedSubmissionCount) ||
    !isCount(summary.excludedSubmissionCount) ||
    !isCount(reasonCounts.questionVersionMismatch) ||
    !isCount(reasonCounts.q5AssessmentVersionMismatch)
  )
    return null;

  return {
    snapshotUpdated: summary.snapshotUpdated,
    includedSubmissionCount: summary.includedSubmissionCount,
    excludedSubmissionCount: summary.excludedSubmissionCount,
    excludedReasonCounts: {
      questionVersionMismatch: reasonCounts.questionVersionMismatch,
      q5AssessmentVersionMismatch: reasonCounts.q5AssessmentVersionMismatch,
    },
  } satisfies AggregationSummary;
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
  const [aggregationResult, setAggregationResult] = useState<
    AggregationSummary | "unavailable" | null
  >(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const authenticatedRef = useRef(false);
  const [adminState, setAdminState] = useState<AdminState | null>(null);
  const publishResultsButtonRef = useRef<HTMLButtonElement | null>(null);
  const hideResultsButtonRef = useRef<HTMLButtonElement | null>(null);
  const aggregateButtonRef = useRef<HTMLButtonElement | null>(null);
  const visibilityFocusHandoff = useRef<{
    action: "publish" | "hideResults";
    trigger: HTMLButtonElement;
    mode: "next" | "retry";
    refreshComplete: boolean;
  } | null>(null);
  const refreshSequence = useRef(0);
  const pollAbortController = useRef<AbortController | null>(null);
  const refreshFlight = useRef<Promise<boolean | null> | null>(null);
  const externalOperationInFlight = useRef(false);
  const loginInFlightRef = useRef(false);
  const updateAuthenticated = useCallback((value: boolean) => {
    authenticatedRef.current = value;
    setAuthenticated(value);
  }, []);

  useEffect(() => {
    const cancelFocusHandoffIfFocusMoves = (event: FocusEvent) => {
      const handoff = visibilityFocusHandoff.current;
      if (
        handoff &&
        event.target !== handoff.trigger &&
        event.target !== document.body &&
        event.target !== document.documentElement
      )
        visibilityFocusHandoff.current = null;
    };
    document.addEventListener("focusin", cancelFocusHandoffIfFocusMoves);
    return () => document.removeEventListener("focusin", cancelFocusHandoffIfFocusMoves);
  }, []);

  useLayoutEffect(() => {
    const handoff = visibilityFocusHandoff.current;
    if (!handoff || !handoff.refreshComplete || busy || !adminState) return;

    const shouldBeVisible =
      handoff.mode === "next" ? handoff.action === "publish" : handoff.action === "hideResults";
    if (adminState.participantResultsVisible !== shouldBeVisible) {
      visibilityFocusHandoff.current = null;
      return;
    }

    visibilityFocusHandoff.current = null;
    const targetButton =
      handoff.mode === "retry"
        ? handoff.action === "publish"
          ? publishResultsButtonRef.current
          : hideResultsButtonRef.current
        : shouldBeVisible
          ? hideResultsButtonRef.current
          : publishResultsButtonRef.current;
    if (targetButton && !targetButton.disabled) targetButton.focus({ preventScroll: true });
    else if (
      handoff.mode === "next" &&
      aggregateButtonRef.current &&
      !aggregateButtonRef.current.disabled
    )
      aggregateButtonRef.current.focus({ preventScroll: true });
  }, [adminState, busy]);

  const performRefresh = useCallback(
    async (checkSession = false): Promise<boolean | null> => {
      const sequence = ++refreshSequence.current;
      const controller = new AbortController();
      pollAbortController.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      try {
        // Startup and visible-resume checks can use the protected state read itself to confirm the session.
        if (!checkSession && !authenticatedRef.current) return false;
        const current = await getAdminState(controller.signal);
        if (sequence !== refreshSequence.current) return null;
        if (checkSession) updateAuthenticated(true);
        setAdminState(current);
        setMessage(null);
        return true;
      } catch (error) {
        if (sequence !== refreshSequence.current) return null;
        if ((error as ApiError).status === 401) {
          updateAuthenticated(false);
          setAdminState(null);
          setMessage("管理者セッションの有効期限が切れました。PIN を入力してください。");
          return false;
        } else {
          if (checkSession) {
            try {
              const sessionAuthenticated = await getSessionStatus(controller.signal);
              if (sequence !== refreshSequence.current) return null;
              if (!sessionAuthenticated) {
                const wasAuthenticated = authenticatedRef.current;
                updateAuthenticated(false);
                setAdminState(null);
                setMessage(
                  wasAuthenticated
                    ? "管理者セッションの有効期限が切れました。PIN を入力してください。"
                    : null,
                );
                return false;
              }
              updateAuthenticated(true);
            } catch {
              if (sequence !== refreshSequence.current) return null;
              // An inconclusive fallback must not change the last known authentication state.
            }
          }
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
    if (authenticated === false) return;

    let active = true;
    let timer: number | undefined;
    async function poll() {
      if (!active || document.visibilityState === "hidden") return;
      if (externalOperationInFlight.current) {
        schedulePoll();
        return;
      }
      await refresh(authenticated === null);
      schedulePoll();
    }
    function schedulePoll() {
      if (
        !active ||
        document.visibilityState === "hidden" ||
        (!authenticatedRef.current && authenticated === false)
      )
        return;
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
      const session = await requestSession({ pin });
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
    action: "start" | "publish" | "hideResults" | "aggregate" | "reset",
    trigger?: HTMLButtonElement,
  ) {
    visibilityFocusHandoff.current =
      (action === "publish" || action === "hideResults") &&
      trigger &&
      document.activeElement === trigger
        ? { action, trigger, mode: "next", refreshComplete: false }
        : null;
    externalOperationInFlight.current = true;
    setBusy(true);
    setBusyAction(action);
    setMessage(null);
    setAggregationResult(null);
    try {
      await refreshFlight.current;
      if (!authenticatedRef.current) return;
      if (action === "publish") await setResultsVisibility(true);
      else if (action === "hideResults") await setResultsVisibility(false);
      else {
        const summary = await postAction(action);
        if (action === "aggregate") setAggregationResult(summary ?? "unavailable");
      }
      const refreshed = await refresh();
      if (visibilityFocusHandoff.current) {
        if (refreshed === true) visibilityFocusHandoff.current.refreshComplete = true;
        else visibilityFocusHandoff.current = null;
      }
    } catch (error) {
      if ((error as ApiError).status === 401) {
        visibilityFocusHandoff.current = null;
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
        const handoff = visibilityFocusHandoff.current;
        if (handoff) {
          if (refreshed === true) {
            handoff.mode = "retry";
            handoff.refreshComplete = true;
          } else visibilityFocusHandoff.current = null;
        }
      }
    } finally {
      externalOperationInFlight.current = false;
      setBusy(false);
      setBusyAction(null);
      if (
        visibilityFocusHandoff.current?.action === action &&
        !visibilityFocusHandoff.current.refreshComplete
      )
        visibilityFocusHandoff.current = null;
    }
  }

  function openProjection() {
    window.open("/presentation?presenter=1", "stcirt-presentation");
  }

  if (authenticated !== false && !adminState) {
    return (
      <main className={styles.shell}>
        <section className={styles.console} aria-labelledby="admin-title">
          <p className={styles.eyebrow}>HOST CONSOLE</p>
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
    const aggregationWasNotUpdated =
      aggregationResult !== null &&
      aggregationResult !== "unavailable" &&
      (!aggregationResult.snapshotUpdated || aggregationResult.includedSubmissionCount === 0);
    const aggregationSummaryClassName = aggregationWasNotUpdated
      ? `${styles.aggregateSummary} ${styles.aggregateNotUpdated}`
      : styles.aggregateSummary;
    return (
      <main className={styles.shell}>
        <section className={styles.console} aria-labelledby="admin-title">
          <p className={styles.eyebrow}>HOST CONSOLE</p>
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
              ref={aggregateButtonRef}
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
            {adminState.participantResultsVisible ? (
              <>
                <p className={styles.success} role="status">
                  参加者結果は公開済みです
                </p>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  ref={hideResultsButtonRef}
                  disabled={busy}
                  onClick={(event) => void runAction("hideResults", event.currentTarget)}
                >
                  {busyAction === "hideResults" ? "非公開にしています…" : "参加者結果を非公開"}
                </button>
              </>
            ) : (
              <button
                className={styles.secondaryButton}
                type="button"
                ref={publishResultsButtonRef}
                disabled={busy || !adminState.participantResultsReady}
                onClick={(event) => void runAction("publish", event.currentTarget)}
              >
                {busyAction === "publish" ? "公開しています…" : "参加者結果を公開"}
              </button>
            )}
          </div>
          {message && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
          {aggregationResult && (
            <div className={aggregationSummaryClassName} role="status" aria-live="polite">
              {aggregationResult === "unavailable" ? (
                <p>件数内訳を取得できませんでした。操作状態を再読み込みして確認してください。</p>
              ) : (
                <>
                  {aggregationResult.snapshotUpdated &&
                  aggregationResult.includedSubmissionCount > 0 ? (
                    <p className={styles.aggregateOutcome}>集計スナップショットを更新しました。</p>
                  ) : (
                    <p className={styles.aggregateOutcome}>
                      集計対象となる回答が見つからなかったため、スナップショットは更新していません。既存のスナップショットを保持しています。
                    </p>
                  )}
                  <p className={styles.aggregateCounts}>
                    集計対象 {aggregationResult.includedSubmissionCount.toLocaleString("ja-JP")} 件
                    <span aria-hidden="true"> · </span>
                    除外 {aggregationResult.excludedSubmissionCount.toLocaleString("ja-JP")} 件
                  </p>
                  <p>
                    除外理由別（重複あり）：質問バージョン不一致{" "}
                    {aggregationResult.excludedReasonCounts.questionVersionMismatch.toLocaleString(
                      "ja-JP",
                    )}{" "}
                    件、 Q5 評価バージョン不一致{" "}
                    {aggregationResult.excludedReasonCounts.q5AssessmentVersionMismatch.toLocaleString(
                      "ja-JP",
                    )}{" "}
                    件
                  </p>
                  <p>除外された回答は今回の集計スナップショットに含まれていません。</p>
                </>
              )}
            </div>
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
        <p className={styles.eyebrow}>HOST CONSOLE</p>
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
