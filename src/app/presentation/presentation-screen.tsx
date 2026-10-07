"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./presentation-screen.module.css";

type State =
  | "standby"
  | "not_started"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "finished";

type PublicQuestion = {
  id: string | number;
  ordinal: number;
  total: number;
  question: string;
  choices: string[];
};
type PublicAnswerQuestion = PublicQuestion & {
  correctAnswer?: string;
  correctIndex?: number;
  explanation?: string | null;
  answerType?: "selected" | "freeText";
  expectedAnswer?: string | null;
  responses?: {
    displayName: string;
    answer?: string | null;
    answerKind: "selected" | "freeText" | "legacy" | "unanswered";
    similarity: number | null;
    score: number | null;
  }[];
};

type Winner = { displayName: string; score: number; rank: number };
type ProjectionData =
  | { state: "question"; question?: PublicQuestion }
  | { state: "answer"; question?: PublicAnswerQuestion }
  | { state: Exclude<State, "question" | "answer">; winners?: Winner[] };
type AdminState = Extract<
  State,
  | "not_started"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "finished"
>;
type PresentationMode = "full" | "short";
type AdminControls = {
  state: AdminState;
  questionIndex: number;
  questionCount: number;
  projectionHidden: boolean;
  presentationMode: PresentationMode;
  participantResultsVisible: boolean;
  participantResultsReady: boolean;
};
type AdminAction = "start" | "advance" | "previous" | "hide" | "show" | "setMode";
type ScreenLock = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void, options?: { once?: boolean }) => void;
};
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<ScreenLock> };
};

async function getProjection(): Promise<ProjectionData> {
  const response = await fetch("/api/presentation", { cache: "no-store", credentials: "omit" });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "投影状態を取得できませんでした。";
    throw new Error(detail);
  }
  return payload as ProjectionData;
}

async function getAdminControls(): Promise<AdminControls> {
  const response = await fetch("/api/admin/presentation", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(new Error("管理状態を取得できませんでした。"), { status: response.status });
  if (typeof payload !== "object" || payload === null)
    throw new Error("管理状態を取得できませんでした。");
  const admin = payload as Record<string, unknown>;
  return {
    state: admin.state as AdminState,
    questionIndex: typeof admin.questionIndex === "number" ? admin.questionIndex : 0,
    questionCount: typeof admin.questionCount === "number" ? admin.questionCount : 0,
    projectionHidden: admin.projectionHidden === true,
    presentationMode: admin.presentationMode === "short" ? "short" : "full",
    participantResultsVisible: admin.participantResultsVisible === true,
    participantResultsReady: admin.participantResultsReady === true,
  };
}

async function requestAdminAction(action: AdminAction, mode?: PresentationMode) {
  const response = await fetch("/api/admin/presentation", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      action,
      ...(action === "setMode" ? { mode } : {}),
    }),
  });
  if (!response.ok) {
    const error = new Error("操作を反映できませんでした。") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
}

async function requestParticipantResultsVisibility(visible: boolean) {
  const response = await fetch("/api/admin/participant-results", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visible }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    const error = new Error(payload?.error ?? "操作を反映できませんでした。") as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
}

const rankTitle: Record<string, string> = { third: "第3位", second: "第2位", first: "第1位" };
const NEXT_CONTROL_LABEL: Record<AdminState, string> = {
  not_started: "発表を始める",
  question: "正解を発表する",
  answer: "次へ進む",
  podium_preview: "第3位を発表する",
  third: "第2位を発表する",
  second: "第1位を発表する",
  first: "締めの画面へ進む",
  finished: "発表終了",
};

function announcementKeyFor(state: string, winners: Winner[] = []) {
  const winnerKey = winners
    .map((winner) => [winner.displayName, winner.score] as const)
    .sort(([nameA], [nameB]) => (nameA < nameB ? -1 : nameA > nameB ? 1 : 0));
  return JSON.stringify([state, winnerKey]);
}

function QuestionPrompt({ question }: { question: PublicQuestion }) {
  return (
    <section className={styles.question} aria-labelledby="question-heading">
      <p className={styles.kicker}>LET’S LOOK BACK</p>
      <p className={styles.ordinal}>
        QUESTION <strong>{question.ordinal}</strong>
        <span> / {question.total}</span>
      </p>
      <h1 id="question-heading">{question.question}</h1>
      <ol className={styles.choices}>
        {question.choices.map((choice, index) => (
          <li key={`${index}-${choice}`}>
            <span className={styles.choiceLetter}>{String.fromCharCode(65 + index)}</span>
            <span className={styles.choiceText}>{choice}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AnswerReview({ question }: { question: PublicAnswerQuestion }) {
  if (question.answerType === "freeText") {
    return (
      <section className={styles.question} aria-labelledby="question-heading">
        <p className={styles.kicker}>THE STORY BEHIND IT</p>
        <p className={styles.ordinal}>
          QUESTION <strong>{question.ordinal}</strong>
          <span> / {question.total}</span>
        </p>
        <h1 id="question-heading">{question.question}</h1>
        <h2>模範解答</h2>
        <p>{question.expectedAnswer}</p>
        <ul>
          {question.responses?.map((response) => (
            <li key={response.displayName}>
              {response.displayName}：
              {response.answerKind === "legacy"
                ? "旧選択式回答（再採点なし）"
                : response.answerKind === "unanswered"
                  ? "未回答"
                  : `${response.answer ?? ""} — 類似度 ${response.similarity?.toFixed(2) ?? "—"} / 得点 ${response.score?.toFixed(2) ?? "—"}`}
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const isShortMode = !Object.prototype.hasOwnProperty.call(question, "explanation");
  const hasExplanation =
    typeof question.explanation === "string" && question.explanation.trim().length > 0;
  const correctChoice =
    question.choices[question.correctIndex ?? -1] ?? question.correctAnswer ?? "";

  return (
    <section className={styles.question} aria-labelledby="question-heading">
      <p className={styles.kicker}>THE STORY BEHIND IT</p>
      <p className={styles.ordinal}>
        QUESTION <strong>{question.ordinal}</strong>
        <span> / {question.total}</span>
      </p>
      <h1 id="question-heading">{question.question}</h1>
      {isShortMode && (
        <div className={styles.shortAnswer}>
          <span className={styles.shortAnswerLabel}>正解</span>
          <p>{question.correctAnswer || correctChoice}</p>
        </div>
      )}
      <ol className={`${styles.choices} ${styles.answered}`}>
        {question.choices.map((choice, index) => {
          const isCorrect = index === question.correctIndex;
          return (
            <li key={`${index}-${choice}`} className={isCorrect ? styles.correct : ""}>
              <span className={styles.choiceLetter}>{String.fromCharCode(65 + index)}</span>
              <span className={styles.choiceText}>{choice}</span>
              {isCorrect && <span className={styles.correctLabel}>正解</span>}
            </li>
          );
        })}
      </ol>
      {!isShortMode && hasExplanation && (
        <div className={styles.explanation}>
          <span className={styles.explanationMark} aria-hidden="true">
            ✦
          </span>
          <p>{question.explanation}</p>
        </div>
      )}
    </section>
  );
}

export default function PresentationScreen({
  presenterRequested = false,
}: {
  presenterRequested?: boolean;
}) {
  const [data, setData] = useState<ProjectionData | null>(null);
  const [announcementKey, setAnnouncementKey] = useState<string | null>(null);
  const previousState = useRef<State | null>(null);
  const seenAnnouncements = useRef(new Set<string>());
  const [connectionError, setConnectionError] = useState(false);
  const [adminControls, setAdminControls] = useState<AdminControls | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const projectionSequence = useRef(0);
  const adminSequence = useRef(0);
  const mutationInFlight = useRef(false);
  const [wakeStatus, setWakeStatus] = useState<
    "pending" | "active" | "unavailable" | "unsupported"
  >("pending");

  useEffect(() => {
    let active = true;
    let timer = 0;
    const refresh = async () => {
      const sequence = ++projectionSequence.current;
      try {
        const next = await getProjection();
        if (active && sequence === projectionSequence.current) {
          const previous = previousState.current;
          if (next.state === "third" || next.state === "second" || next.state === "first") {
            const eventKey = announcementKeyFor(next.state, next.winners);
            let hasBeenSeen = seenAnnouncements.current.has(eventKey);
            try {
              const saved = window.sessionStorage.getItem("stcirt:presentation:announcements");
              const parsed: unknown = saved ? JSON.parse(saved) : [];
              let storedAnnouncements: string[] = [];
              if (Array.isArray(parsed)) {
                storedAnnouncements = parsed.filter(
                  (item): item is string => typeof item === "string",
                );
              }
              for (const item of storedAnnouncements) seenAnnouncements.current.add(item);
              hasBeenSeen = seenAnnouncements.current.has(eventKey);
            } catch {
              // The in-memory set still deduplicates announcements while this component is mounted.
            }
            if (previous !== null && previous !== next.state && !hasBeenSeen) {
              setAnnouncementKey(eventKey);
              window.setTimeout(() => setAnnouncementKey(null), 1400);
            }
            if (!hasBeenSeen) {
              seenAnnouncements.current.add(eventKey);
              try {
                window.sessionStorage.setItem(
                  "stcirt:presentation:announcements",
                  JSON.stringify([...seenAnnouncements.current].slice(-30)),
                );
              } catch {
                // Session persistence is best effort; the in-memory set remains available.
              }
            }
          }
          previousState.current = next.state;
          setData(next);
          setConnectionError(false);
        }
      } catch {
        if (active && sequence === projectionSequence.current) setConnectionError(true);
      } finally {
        if (active) timer = window.setTimeout(refresh, 1400);
      }
    };
    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const refreshAdmin = useCallback(async () => {
    const sequence = ++adminSequence.current;
    try {
      const sessionResponse = await fetch("/api/admin/session", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const session = (await sessionResponse.json().catch(() => null)) as {
        authenticated?: unknown;
      } | null;
      if (!sessionResponse.ok || session?.authenticated !== true) {
        if (sequence === adminSequence.current) setAdminControls(null);
        return;
      }
      const controls = await getAdminControls();
      if (sequence === adminSequence.current) setAdminControls(controls);
    } catch {
      if (sequence === adminSequence.current) setAdminControls(null);
    }
  }, []);

  useEffect(() => {
    if (!presenterRequested) {
      setAdminControls(null);
      return;
    }
    let active = true;
    const refresh = async () => {
      if (!active) return;
      await refreshAdmin();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [presenterRequested, refreshAdmin]);

  const recoverUnauthorized = useCallback(() => {
    setAdminControls(null);
    setAdminMessage("管理者セッションの有効期限が切れました。観客表示に戻りました。");
  }, []);

  const operate = useCallback(
    async (action: AdminAction, mode?: PresentationMode) => {
      if (!adminControls || mutationInFlight.current) return;
      mutationInFlight.current = true;
      setAdminBusy(true);
      setAdminMessage(null);
      try {
        await requestAdminAction(action, mode);
        const projectionRequest = (async () => {
          const sequence = ++projectionSequence.current;
          const projection = await getProjection();
          if (sequence === projectionSequence.current) {
            previousState.current = projection.state;
            setData(projection);
            setConnectionError(false);
          }
        })();
        await Promise.all([refreshAdmin(), projectionRequest]);
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status === 401) recoverUnauthorized();
        else {
          try {
            const sequence = ++projectionSequence.current;
            const projection = await getProjection();
            if (sequence === projectionSequence.current) {
              previousState.current = projection.state;
              setData(projection);
              setConnectionError(false);
            }
          } catch {
            setConnectionError(true);
          }
          setAdminMessage(
            status === 409
              ? "進行状態が更新されました。最新の投影状態に同期しました。"
              : "操作を反映できませんでした。状態を再確認しています。",
          );
        }
        try {
          await refreshAdmin();
        } catch {
          /* The next session poll will retry. */
        }
      } finally {
        mutationInFlight.current = false;
        setAdminBusy(false);
      }
    },
    [adminControls, recoverUnauthorized, refreshAdmin],
  );

  const toggleParticipantResults = useCallback(async () => {
    if (!adminControls || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      await requestParticipantResultsVisibility(!adminControls.participantResultsVisible);
      await refreshAdmin();
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401) recoverUnauthorized();
      else {
        setAdminMessage(
          adminControls.participantResultsVisible
            ? "結果公開状態を更新できませんでした。"
            : "結果の準備または公開に失敗しました。結果は非公開のままです。",
        );
        try {
          await refreshAdmin();
        } catch {
          /* The next session poll will retry. */
        }
      }
    } finally {
      mutationInFlight.current = false;
      setAdminBusy(false);
    }
  }, [adminControls, recoverUnauthorized, refreshAdmin]);

  useEffect(() => {
    if (!adminControls || !presenterRequested) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [role='dialog'], dialog"))
      )
        return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (adminControls.state !== "finished")
          void operate(adminControls.state === "not_started" ? "start" : "advance");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        const canGoPrevious =
          adminControls.state !== "not_started" &&
          !(adminControls.state === "question" && adminControls.questionIndex === 0) &&
          !(adminControls.state === "podium_preview" && adminControls.questionCount === 0);
        if (canGoPrevious) void operate("previous");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [adminControls, operate, presenterRequested]);

  useEffect(() => {
    let active = true;
    let requesting = false;
    let currentLock: ScreenLock | null = null;
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;

    async function acquireScreenWakeLock() {
      if (document.visibilityState !== "visible") return;
      if (requesting || (currentLock && !currentLock.released)) return;
      if (!wakeLock) {
        setWakeStatus("unsupported");
        return;
      }
      requesting = true;
      try {
        const lock = await wakeLock.request("screen");
        if (!active) {
          await lock.release();
          return;
        }
        currentLock = lock;
        setWakeStatus("active");
        lock.addEventListener(
          "release",
          () => {
            if (active && currentLock === lock) {
              currentLock = null;
              setWakeStatus("unavailable");
            }
          },
          { once: true },
        );
      } catch {
        if (active) setWakeStatus("unavailable");
      } finally {
        requesting = false;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") void acquireScreenWakeLock();
    }

    void acquireScreenWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (currentLock && !currentLock.released) void currentLock.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    updateFullscreen();
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (wrapperRef.current?.requestFullscreen) await wrapperRef.current.requestFullscreen();
    } catch {
      // Fullscreen is optional; the browser can deny it without affecting the presentation.
    }
  }

  const state = data?.state;
  const questionOrdinal =
    data && (data.state === "question" || data.state === "answer")
      ? (data.question?.ordinal ?? "·")
      : "·";

  return (
    <main
      ref={wrapperRef}
      className={`${styles.screen} ${presenterRequested && adminControls ? styles.presenterScreen : ""}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className={styles.slideRegion}>
        <div className={styles.canvas} data-testid="presentation-canvas">
          <div className={styles.topline} aria-hidden="true">
            <span>STCIRT</span>
            <span className={styles.toplineRule} />
            <span>CELEBRATION QUIZ</span>
          </div>

          {state === "standby" && (
            <section className={styles.waiting} aria-labelledby="standby-title">
              <p className={styles.kicker}>TAKE A MOMENT</p>
              <span className={styles.decorativeRule} aria-hidden="true" />
              <h1 id="standby-title">ただいま休憩中です</h1>
              <p className={styles.subtitle}>まもなく再開します</p>
            </section>
          )}

          {(!data || state === "not_started") && (
            <section className={styles.waiting} aria-labelledby="presentation-title">
              <p className={styles.kicker}>A MOMENT TO CELEBRATE</p>
              <span className={styles.decorativeRule} aria-hidden="true" />
              <h1 id="presentation-title">
                ふたりの思い出を
                <br />
                振り返る時間
              </h1>
              <p className={styles.subtitle}>発表が始まるまで、少々お待ちください</p>
            </section>
          )}

          {state === "question" && data?.question && <QuestionPrompt question={data.question} />}
          {state === "answer" && data?.question && <AnswerReview question={data.question} />}

          {state === "podium_preview" && (
            <section className={styles.podiumPreview} aria-labelledby="podium-title">
              <p className={styles.kicker}>THE MOMENT IS HERE</p>
              <span className={styles.decorativeRule} aria-hidden="true" />
              <h1 id="podium-title">いよいよ、結果発表です</h1>
              <p className={styles.subtitle}>これから入賞者を発表します。どうぞお楽しみに</p>
              <div className={styles.podiumMarks} aria-hidden="true">
                <span>Ⅲ</span>
                <span>Ⅱ</span>
                <span>Ⅰ</span>
              </div>
            </section>
          )}

          {(state === "third" || state === "second" || state === "first") && (
            <section
              className={`${styles.winners} ${state === "first" ? styles.grandWinner : ""} ${
                announcementKey === announcementKeyFor(state, data?.winners) ? styles.announce : ""
              }`}
              role="region"
              aria-label={`${rankTitle[state]}の勝者一覧`}
              tabIndex={0}
            >
              <p className={styles.kicker}>WITH OUR WARMEST CONGRATULATIONS</p>
              <div className={styles.winnerNames}>
                {data?.winners?.length ? (
                  data.winners.map((winner, index) => (
                    <article
                      className={styles.winner}
                      key={`${winner.rank}-${winner.displayName}-${index}`}
                    >
                      <h1>
                        {winner.displayName}
                        <span> さん</span>
                      </h1>
                      <p>{winner.score.toFixed(2)} ポイント</p>
                    </article>
                  ))
                ) : (
                  <h1 className={styles.noWinner}>該当する受賞者はいません</h1>
                )}
              </div>
              <p className={styles.rank}>{rankTitle[state]}</p>
              <p className={styles.congratulations}>おめでとうございます</p>
            </section>
          )}

          {state === "finished" && (
            <section className={styles.finished} aria-labelledby="finished-title">
              <p className={styles.kicker}>WITH LOVE AND GRATITUDE</p>
              <span className={styles.decorativeRule} aria-hidden="true" />
              <h1 id="finished-title">
                ご参加
                <br />
                ありがとうございました
              </h1>
              <p className={styles.subtitle}>
                ふたりの思い出を一緒に祝ってくださり、心から感謝します
              </p>
              <span className={styles.decorativeRule} aria-hidden="true" />
            </section>
          )}

          <div className={styles.bottomline} aria-hidden="true">
            <span className={styles.bottomRule} />
            <span>WITH LOVE, ALWAYS</span>
            <span className={styles.bottomRule} />
          </div>
          {connectionError && (
            <p className={styles.connection} role="status">
              接続を確認しています…
            </p>
          )}
        </div>
      </div>
      {presenterRequested && adminControls && (
        <footer className={styles.controls} aria-label="発表操作">
          <div className={styles.controlStatus}>
            <strong>
              {adminControls.state === "not_started"
                ? "待機中"
                : adminControls.state === "finished"
                  ? "発表終了"
                  : `QUESTION ${questionOrdinal}`}
            </strong>
            {adminMessage && <span role="status">{adminMessage}</span>}
          </div>
          <div className={styles.controlButtons}>
            <button
              type="button"
              onClick={() => void operate("previous")}
              disabled={
                adminBusy ||
                adminControls.state === "not_started" ||
                (adminControls.state === "question" && adminControls.questionIndex === 0) ||
                (adminControls.state === "podium_preview" && adminControls.questionCount === 0)
              }
            >
              ← 前へ
            </button>
            <button
              className={styles.primaryControl}
              type="button"
              onClick={() =>
                void operate(adminControls.state === "not_started" ? "start" : "advance")
              }
              disabled={adminBusy || adminControls.state === "finished"}
            >
              {adminBusy
                ? "同期中…"
                : adminControls.state === "not_started"
                  ? "発表を始める"
                  : adminControls.state === "finished"
                    ? "発表終了"
                    : NEXT_CONTROL_LABEL[adminControls.state]}
            </button>
            <button
              type="button"
              onClick={() => void operate(adminControls.projectionHidden ? "show" : "hide")}
              disabled={adminBusy}
            >
              {adminControls.projectionHidden ? "投影を表示" : "投影を隠す"}
            </button>
            <div className={styles.modeControls} role="group" aria-label="答え合わせの表示モード">
              <button
                type="button"
                aria-pressed={adminControls.presentationMode === "full"}
                onClick={() => void operate("setMode", "full")}
                disabled={adminBusy || adminControls.presentationMode === "full"}
              >
                通常
              </button>
              <button
                type="button"
                aria-pressed={adminControls.presentationMode === "short"}
                onClick={() => void operate("setMode", "short")}
                disabled={adminBusy || adminControls.presentationMode === "short"}
              >
                短縮
              </button>
            </div>
            <div className={styles.resultControls}>
              <button
                type="button"
                onClick={() => void toggleParticipantResults()}
                disabled={adminBusy}
                aria-pressed={adminControls.participantResultsVisible}
              >
                {adminControls.participantResultsVisible
                  ? "参加者結果を非公開"
                  : "参加者結果を公開"}
              </button>
              <span>初回公開時に結果を確定します。公開後の回答変更は結果に反映されません。</span>
            </div>
            <button
              type="button"
              className={styles.fullscreenControl}
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "全画面表示を終了" : "全画面表示"}
            >
              {fullscreen ? "全画面を終了" : "⛶ 全画面"}
            </button>
          </div>
        </footer>
      )}
      {(!presenterRequested || !adminControls) && (
        <button
          className={styles.fullscreenButton}
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? "全画面表示を終了" : "全画面表示"}
          title={fullscreen ? "全画面表示を終了" : "全画面表示"}
        >
          <span aria-hidden="true">{fullscreen ? "↙" : "⛶"}</span>
        </button>
      )}
      <p className={styles.wakeHint} aria-live="off">
        {wakeStatus === "active"
          ? "画面の自動消灯を防止中"
          : wakeStatus === "pending"
            ? "画面の点灯を準備中"
            : wakeStatus === "unsupported"
              ? "画面の自動消灯にご注意ください"
              : "画面の点灯を維持できません。全画面表示をお使いください"}
      </p>
    </main>
  );
}
