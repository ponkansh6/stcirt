"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
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
type AdminControls = {
  state: AdminState;
  questionIndex: number;
  questionCount: number;
  projectionHidden: boolean;
  participantResultsVisible: boolean;
  participantResultsReady: boolean;
};
type AdminAction = "start" | "advance" | "previous" | "hide" | "show";
type ScreenLock = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void, options?: { once?: boolean }) => void;
};
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<ScreenLock> };
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    (target instanceof HTMLElement && target.isContentEditable) ||
    Boolean(
      target.closest(
        "button, a, input, textarea, select, summary, [role='button'], [role='link'], [role='menuitem'], [role='tab'], [role='checkbox'], [role='radio'], [role='switch'], [role='combobox'], [role='listbox'], [role='option'], [role='dialog'], dialog, [data-no-slide-advance]",
      ),
    )
  );
}

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
    participantResultsVisible: admin.participantResultsVisible === true,
    participantResultsReady: admin.participantResultsReady === true,
  };
}

async function requestAdminAction(action: AdminAction) {
  const response = await fetch("/api/admin/presentation", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      action,
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
function isRankState(state: State): state is "third" | "second" | "first" {
  return state === "third" || state === "second" || state === "first";
}

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
    const showResponses = (question.responses?.length ?? 0) > 0;
    return (
      <section
        className={`${styles.question} ${styles.answerReview}`}
        aria-labelledby="question-heading"
      >
        <p className={styles.kicker}>THE STORY BEHIND IT</p>
        <p className={styles.ordinal}>
          QUESTION <strong>{question.ordinal}</strong>
          <span> / {question.total}</span>
        </p>
        <div className={styles.answerContent}>
          <h1 id="question-heading">{question.question}</h1>
          <h2>模範解答</h2>
          <p>{question.expectedAnswer}</p>
          {showResponses && (
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
          )}
        </div>
      </section>
    );
  }
  const hasExplanation =
    typeof question.explanation === "string" && question.explanation.trim().length > 0;

  return (
    <section
      className={`${styles.question} ${styles.answerReview}`}
      aria-labelledby="question-heading"
    >
      <p className={styles.kicker}>THE STORY BEHIND IT</p>
      <p className={styles.ordinal}>
        QUESTION <strong>{question.ordinal}</strong>
        <span> / {question.total}</span>
      </p>
      <div className={styles.answerContent}>
        <h1 id="question-heading">{question.question}</h1>
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
        {hasExplanation && (
          <div className={styles.explanation}>
            <span className={styles.explanationMark} aria-hidden="true">
              ✦
            </span>
            <p>{question.explanation}</p>
          </div>
        )}
      </div>
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
  const announcementTimer = useRef<number | null>(null);
  const [adminControls, setAdminControls] = useState<AdminControls | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const hasEnteredFullscreen = useRef(false);
  const wasFullscreenActive = useRef(false);
  const fullscreenReentryPending = useRef(false);
  const projectionSequence = useRef(0);
  const adminSequence = useRef(0);
  const mutationInFlight = useRef(false);
  const announceRank = useCallback((state: "third" | "second" | "first", winners?: Winner[]) => {
    const eventKey = announcementKeyFor(state, winners);
    setAnnouncementKey(eventKey);
    announcementTimer.current = window.setTimeout(() => {
      setAnnouncementKey(null);
      announcementTimer.current = null;
    }, 1200);
  }, []);

  const applyProjection = useCallback((projection: ProjectionData) => {
    setData(projection);
  }, []);

  useEffect(() => {
    let active = true;
    let timer = 0;
    const refresh = async () => {
      if (!active) return;
      if (mutationInFlight.current) {
        timer = window.setTimeout(refresh, 1400);
        return;
      }
      const sequence = ++projectionSequence.current;
      try {
        const next = await getProjection();
        if (active && sequence === projectionSequence.current) {
          applyProjection(next);
        }
      } catch {
        // Keep the last usable projection visible while the polling loop retries.
      } finally {
        if (active) timer = window.setTimeout(refresh, 1400);
      }
    };
    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [applyProjection]);

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

  const requestFullscreenForStart = useCallback(() => {
    const element = wrapperRef.current;
    if (!element?.requestFullscreen || document.fullscreenElement) return;
    try {
      void element
        .requestFullscreen()
        .then(() => {
          hasEnteredFullscreen.current = true;
          if (document.fullscreenElement !== element) fullscreenReentryPending.current = true;
        })
        .catch(() => {
          if (hasEnteredFullscreen.current) fullscreenReentryPending.current = true;
        });
    } catch {
      // Browser support and user permission are optional for projection.
    }
  }, []);

  const requestFullscreenForIntent = useCallback(
    (action: AdminAction) => {
      if (action === "start" && !hasEnteredFullscreen.current) {
        requestFullscreenForStart();
        return;
      }
      if (
        (action === "start" || action === "advance" || action === "previous") &&
        hasEnteredFullscreen.current &&
        fullscreenReentryPending.current
      ) {
        if (!wrapperRef.current?.requestFullscreen || document.fullscreenElement) return;
        fullscreenReentryPending.current = false;
        requestFullscreenForStart();
      }
    },
    [requestFullscreenForStart],
  );

  const operate = useCallback(
    async (action: AdminAction) => {
      if (!adminControls || mutationInFlight.current) return;
      const startingAdminState = adminControls.state;
      const expectedRankTarget: State | null =
        action === "advance"
          ? startingAdminState === "podium_preview"
            ? "third"
            : startingAdminState === "third"
              ? "second"
              : startingAdminState === "second"
                ? "first"
                : null
          : null;
      if (announcementTimer.current !== null) {
        window.clearTimeout(announcementTimer.current);
        announcementTimer.current = null;
        setAnnouncementKey(null);
      }
      requestFullscreenForIntent(action);
      mutationInFlight.current = true;
      projectionSequence.current += 1;
      setAdminBusy(true);
      setAdminMessage(null);
      try {
        await requestAdminAction(action);
        if (action === "start") wrapperRef.current?.focus({ preventScroll: true });
        const projectionRequest = (async () => {
          ++projectionSequence.current;
          const projection = await getProjection();
          const stillForward =
            action === "advance" &&
            ((startingAdminState === "podium_preview" && expectedRankTarget === "third") ||
              (startingAdminState === "third" && expectedRankTarget === "second") ||
              (startingAdminState === "second" && expectedRankTarget === "first"));
          if (
            stillForward &&
            expectedRankTarget === projection.state &&
            isRankState(projection.state) &&
            !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          )
            announceRank(projection.state, projection.winners);
          applyProjection(projection);
        })();
        await Promise.all([refreshAdmin(), projectionRequest]);
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status === 401) recoverUnauthorized();
        else {
          try {
            ++projectionSequence.current;
            const projection = await getProjection();
            applyProjection(projection);
          } catch {
            // Keep the last usable projection visible while the next poll retries.
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
    [
      adminControls,
      applyProjection,
      announceRank,
      recoverUnauthorized,
      refreshAdmin,
      requestFullscreenForIntent,
    ],
  );

  const toggleParticipantResults = useCallback(async () => {
    if (!adminControls || adminControls.participantResultsVisible || mutationInFlight.current)
      return;
    mutationInFlight.current = true;
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      await requestParticipantResultsVisibility(true);
      await refreshAdmin();
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401) recoverUnauthorized();
      else {
        setAdminMessage("結果の準備または公開に失敗しました。結果は非公開のままです。");
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
      if (!(target instanceof Node) || !wrapperRef.current?.contains(target)) return;
      if (isInteractiveTarget(target)) return;
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
      } else if ((event.key === " " || event.key === "Enter") && !event.isComposing) {
        event.preventDefault();
        if (adminControls.state !== "finished")
          void operate(adminControls.state === "not_started" ? "start" : "advance");
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
        lock.addEventListener(
          "release",
          () => {
            if (active && currentLock === lock) {
              currentLock = null;
            }
          },
          { once: true },
        );
      } catch {
        // Wake Lock is an optional browser feature.
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

  useEffect(
    () => () => {
      if (announcementTimer.current !== null) window.clearTimeout(announcementTimer.current);
    },
    [],
  );

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === wrapperRef.current;
      if (active) {
        hasEnteredFullscreen.current = true;
        fullscreenReentryPending.current = false;
      } else if (wasFullscreenActive.current && hasEnteredFullscreen.current) {
        fullscreenReentryPending.current = true;
      }
      wasFullscreenActive.current = active;
    };
    handleFullscreenChange();
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const handleSlideClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!adminControls || isInteractiveTarget(event.target)) return;
      if (adminControls.state === "finished") return;
      wrapperRef.current?.focus({ preventScroll: true });
      void operate(adminControls.state === "not_started" ? "start" : "advance");
    },
    [adminControls, operate],
  );

  const state = data?.state;
  return (
    <main
      ref={wrapperRef}
      className={styles.screen}
      tabIndex={0}
      aria-label="プレゼンテーションスライド"
      onClick={handleSlideClick}
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
                      <p className={styles.winnerRank}>{winner.rank}位</p>
                      <p className={styles.winnerScore}>{winner.score.toFixed(2)} ポイント</p>
                      <h1>
                        <span className={styles.winnerName}>
                          {winner.displayName}
                          <span className={styles.winnerHonorific}>&nbsp;さん</span>
                        </span>
                      </h1>
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
        </div>
      </div>
      {presenterRequested && adminControls?.state === "not_started" && (
        <div className={styles.startControl} onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => void operate("start")} disabled={adminBusy}>
            {adminBusy ? "開始しています…" : "プレゼンを開始"}
          </button>
          {adminMessage && <p role="status">{adminMessage}</p>}
        </div>
      )}
      {presenterRequested && adminControls?.state === "finished" && (
        <div className={styles.startControl} onClick={(event) => event.stopPropagation()}>
          {adminControls.participantResultsVisible ? (
            <span className={styles.publishedStatus} role="status">
              参加者結果は公開済みです
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void toggleParticipantResults()}
              disabled={adminBusy}
            >
              {adminBusy ? "公開しています…" : "参加者結果を公開"}
            </button>
          )}
          {adminMessage && <p role="status">{adminMessage}</p>}
        </div>
      )}
    </main>
  );
}
