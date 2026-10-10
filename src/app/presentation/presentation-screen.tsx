"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
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

type WinnerQuestionResult = {
  position: number;
  question: string | null;
  answer:
    | { kind: "selected"; value: string | null }
    | { kind: "freeText"; value: string | null }
    | { kind: "unanswered" }
    | { kind: "legacy" }
    | { kind: "unavailable" };
  correctness?: "correct" | "incorrect" | "unavailable";
  normalizedScore?: number | null;
  scoreStatus?: "unavailable";
};
type Winner = {
  displayName: string;
  score: number;
  rank: number;
  questionResults?: WinnerQuestionResult[];
};
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
  version: number;
  snapshotRevision: number;
  questionIndex: number;
  questionCount: number;
  projectionHidden: boolean;
};
const adminStates: AdminState[] = [
  "not_started",
  "question",
  "answer",
  "podium_preview",
  "third",
  "second",
  "first",
  "finished",
];

function parseAdminControls(payload: unknown): AdminControls | null {
  if (typeof payload !== "object" || payload === null) return null;
  const controls = payload as Record<string, unknown>;
  if (
    !adminStates.includes(controls.state as AdminState) ||
    !Number.isFinite(controls.version) ||
    !Number.isInteger(controls.version) ||
    (controls.version as number) < 0 ||
    !Number.isFinite(controls.snapshotRevision) ||
    !Number.isInteger(controls.snapshotRevision) ||
    (controls.snapshotRevision as number) < 0 ||
    !Number.isFinite(controls.questionIndex) ||
    !Number.isInteger(controls.questionIndex) ||
    (controls.questionIndex as number) < 0 ||
    !Number.isFinite(controls.questionCount) ||
    !Number.isInteger(controls.questionCount) ||
    (controls.questionCount as number) < 0 ||
    typeof controls.projectionHidden !== "boolean"
  ) {
    return null;
  }
  return controls as AdminControls;
}
type PresenterDeck = {
  snapshotRevision: number;
  slides: { state: AdminState; questionIndex: number; projection: ProjectionData }[];
};
type AdminAction = "advance" | "previous";
type ScreenLock = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void, options?: { once?: boolean }) => void;
};
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<ScreenLock> };
};
const POLL_TIMEOUT_MS = 8_000;

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

async function getProjection(signal?: AbortSignal): Promise<ProjectionData> {
  const response = await fetch("/api/presentation", {
    cache: "no-store",
    credentials: "omit",
    signal,
  });
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
  if (!isProjectionData(payload)) throw new Error("投影状態を取得できませんでした。");
  return payload as ProjectionData;
}

function isProjectionData(payload: unknown): payload is ProjectionData {
  if (typeof payload !== "object" || payload === null || !("state" in payload)) return false;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.state !== "string" ||
    ![
      "standby",
      "not_started",
      "question",
      "answer",
      "podium_preview",
      "third",
      "second",
      "first",
      "finished",
    ].includes(value.state)
  )
    return false;
  if (value.state === "question" || value.state === "answer") {
    if (typeof value.question !== "object" || value.question === null) return false;
    const question = value.question as Record<string, unknown>;
    return (
      (typeof question.id === "string" || typeof question.id === "number") &&
      Number.isInteger(question.ordinal) &&
      Number.isInteger(question.total) &&
      typeof question.question === "string" &&
      Array.isArray(question.choices) &&
      question.choices.every((choice) => typeof choice === "string")
    );
  }
  if (["third", "second", "first"].includes(value.state) && value.winners !== undefined) {
    return (
      Array.isArray(value.winners) &&
      value.winners.every((winner) => {
        if (typeof winner !== "object" || winner === null) return false;
        const entry = winner as Record<string, unknown>;
        return (
          typeof entry.displayName === "string" &&
          typeof entry.score === "number" &&
          typeof entry.rank === "number"
        );
      })
    );
  }
  return true;
}

async function getAdminControls(signal?: AbortSignal): Promise<AdminControls> {
  const response = await fetch("/api/admin/presentation?view=controls", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(new Error("管理状態を取得できませんでした。"), { status: response.status });
  const controls = parseAdminControls(payload);
  if (!controls) throw new Error("管理状態を取得できませんでした。");
  return controls;
}

async function getPresenterDeck(signal?: AbortSignal): Promise<PresenterDeck> {
  const response = await fetch("/api/admin/presentation/deck", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(new Error("スライドを読み込めませんでした。"), { status: response.status });
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("slides" in payload) ||
    !Array.isArray(payload.slides) ||
    !("snapshotRevision" in payload) ||
    !Number.isInteger(payload.snapshotRevision) ||
    (payload.snapshotRevision as number) < 0 ||
    !payload.slides.every((slide) => {
      if (typeof slide !== "object" || slide === null) return false;
      const item = slide as Record<string, unknown>;
      return (
        adminStates.includes(item.state as AdminState) &&
        Number.isInteger(item.questionIndex) &&
        (item.questionIndex as number) >= 0 &&
        isProjectionData(item.projection)
      );
    })
  )
    throw new Error("スライドを読み込めませんでした。");
  return payload as unknown as PresenterDeck;
}

function projectionForControl(deck: PresenterDeck, controls: AdminControls): ProjectionData | null {
  if (controls.state === "not_started") return { state: "not_started" };
  const slide = slideForControl(deck, controls);
  if (!slide) return null;
  return controls.projectionHidden ? { state: "standby" } : slide.projection;
}

function slideForControl(
  deck: PresenterDeck,
  controls: AdminControls,
): PresenterDeck["slides"][number] | undefined {
  const questionStage = controls.state === "question" || controls.state === "answer";
  return deck.slides.find(
    (candidate) =>
      candidate.state === controls.state &&
      (!questionStage || candidate.questionIndex === controls.questionIndex),
  );
}

async function requestAdminAction(action: AdminAction, expectedSnapshotRevision: number) {
  const response = await fetch("/api/admin/presentation", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      action,
      expectedSnapshotRevision,
    }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("操作を反映できませんでした。") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const controls = parseAdminControls(payload);
  if (!controls) throw new Error("操作結果を確認できませんでした。");
  return controls;
}

const rankTitle: Record<string, string> = { third: "第3位", second: "第2位", first: "第1位" };
function WinnerQuestionBreakdown({ results }: { results: WinnerQuestionResult[] }) {
  return (
    <ol className={styles.winnerQuestionResults} aria-label="設問別の回答">
      {results.map((result) => (
        <li
          key={result.position}
          className={result.answer.kind === "freeText" ? styles.freeTextResult : undefined}
        >
          <span className={styles.winnerQuestionLabel}>Q{result.position + 1}</span>
          <span className={styles.winnerQuestionAnswer}>
            {result.answer.kind === "freeText" ? (
              <>
                {result.answer.value ?? "回答を確認できません"}
                <span className={styles.winnerQuestionScore}>
                  {result.scoreStatus === "unavailable"
                    ? "得点を確認できません"
                    : result.normalizedScore === null || result.normalizedScore === undefined
                      ? "未採点"
                      : `得点 ${result.normalizedScore}`}
                </span>
              </>
            ) : (
              <span
                className={styles.winnerQuestionMark}
                aria-label={
                  result.correctness === "correct"
                    ? "正解"
                    : result.correctness === "incorrect"
                      ? "不正解"
                      : "正誤を確認できません"
                }
              >
                {result.correctness === "correct"
                  ? "○"
                  : result.correctness === "incorrect"
                    ? "×"
                    : "—"}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
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
  const [adminControls, setAdminControls] = useState<AdminControls | null>(null);
  const adminControlsRef = useRef<AdminControls | null>(null);
  const [presenterDeck, setPresenterDeck] = useState<PresenterDeck | null>(null);
  const [deckSyncPending, setDeckSyncPending] = useState(false);
  const [deckLoadError, setDeckLoadError] = useState(false);
  const [pollError, setPollError] = useState(false);
  const presenterDeckRef = useRef<PresenterDeck | null>(null);
  const presenterDeckRequest = useRef<Promise<PresenterDeck> | null>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const fitViewportRef = useRef<HTMLDivElement | null>(null);
  const contentLayerRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ scale: 1, left: 0, top: 0, ready: false });
  const fullscreenAttempted = useRef(false);
  const pointerStart = useRef<{
    id: number;
    x: number;
    y: number;
    generation: number;
    ignored: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const suppressClickTimer = useRef<number | undefined>(undefined);
  const adminSequence = useRef(0);
  const presenterAuthenticated = useRef(false);
  const adminPollAbort = useRef<AbortController | null>(null);
  const adminPollFlight = useRef<Promise<void> | null>(null);
  const mutationInFlight = useRef(false);
  const mutationGeneration = useRef(0);
  const applyAdminControls = useCallback((controls: AdminControls | null) => {
    adminControlsRef.current = controls;
    setAdminControls(controls);
  }, []);
  const applyProjection = useCallback((projection: ProjectionData) => {
    setData(projection);
  }, []);

  useEffect(() => {
    if (presenterRequested) return;
    let active = true;
    let timer = 0;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (!active) return;
      if (mutationInFlight.current) {
        timer = window.setTimeout(refresh, 1400);
        return;
      }
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), POLL_TIMEOUT_MS);
      try {
        const next = await getProjection(controller.signal);
        if (active) {
          applyProjection(next);
          setPollError(false);
        }
      } catch {
        if (active) setPollError(true);
      } finally {
        window.clearTimeout(timeout);
        if (active) timer = window.setTimeout(refresh, 1400);
      }
    };
    void refresh();
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(timer);
    };
  }, [applyProjection, presenterRequested]);

  const performRefreshAdmin = useCallback(
    async (checkSession = false) => {
      const sequence = ++adminSequence.current;
      const controller = new AbortController();
      adminPollAbort.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      let controls: AdminControls | null = null;
      let loadingDeck = false;
      try {
        if (checkSession || !presenterAuthenticated.current) {
          const sessionResponse = await fetch("/api/admin/session", {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          });
          const session = (await sessionResponse.json().catch(() => null)) as {
            authenticated?: unknown;
          } | null;
          if (sessionResponse.ok && typeof session?.authenticated !== "boolean")
            throw new Error("管理者セッションを確認できませんでした。");
          if (
            sessionResponse.status === 401 ||
            (sessionResponse.ok && session?.authenticated !== true)
          ) {
            if (sequence === adminSequence.current) {
              presenterAuthenticated.current = false;
              presenterDeckRef.current = null;
              presenterDeckRequest.current = null;
              setPresenterDeck(null);
              applyAdminControls(null);
              setDeckSyncPending(false);
              setDeckLoadError(false);
              setData({ state: "standby" });
              setPollError(false);
            }
            return;
          }
          if (!sessionResponse.ok)
            throw Object.assign(new Error("管理者セッションを確認できませんでした。"), {
              status: sessionResponse.status,
            });
          if (sequence !== adminSequence.current) return;
          presenterAuthenticated.current = true;
        }
        // Session checks return on unauthenticated outcomes or set this ref before continuing; ordinary polls run only after authentication.
        /* v8 ignore if */
        if (!presenterAuthenticated.current) return;
        controls = await getAdminControls(controller.signal);
        if (sequence !== adminSequence.current) return;
        if (controls.state === "not_started") {
          applyAdminControls(controls);
          setDeckSyncPending(false);
          setDeckLoadError(false);
          setPollError(false);
          setData({ state: "not_started" });
          return;
        }
        let deck = presenterDeckRef.current;
        if (!deck || deck.snapshotRevision !== controls.snapshotRevision) {
          if (deck && deck.snapshotRevision !== controls.snapshotRevision) setData(null);
          presenterDeckRef.current = null;
          setPresenterDeck(null);
          loadingDeck = true;
          setDeckSyncPending(true);
          setDeckLoadError(false);
          const request = presenterDeckRequest.current ?? getPresenterDeck(controller.signal);
          presenterDeckRequest.current = request;
          try {
            deck = await request;
          } finally {
            // Single-flight keeps this request current until its awaited fetch settles.
            /* v8 ignore else */
            if (presenterDeckRequest.current === request) presenterDeckRequest.current = null;
          }
          if (sequence !== adminSequence.current) return;
          if (deck.snapshotRevision !== controls.snapshotRevision) {
            setDeckSyncPending(false);
            setDeckLoadError(true);
            applyAdminControls(null);
            setData(null);
            return;
          }
          setDeckSyncPending(false);
          presenterDeckRef.current = deck;
          setPresenterDeck(deck);
          setDeckLoadError(false);
        }
        const projection = projectionForControl(deck, controls);
        if (!projection) {
          // A same-revision deck should contain every reachable slide. Its current
          // slide cannot be trusted until both controls and deck are reconciled.
          applyAdminControls(null);
          presenterDeckRef.current = null;
          setPresenterDeck(null);
          setData(null);
          setDeckSyncPending(true);
          setDeckLoadError(false);
          loadingDeck = true;
          const request = getPresenterDeck(controller.signal);
          presenterDeckRequest.current = request;
          try {
            deck = await request;
          } finally {
            // Single-flight keeps this request current until its awaited fetch settles.
            /* v8 ignore else */
            if (presenterDeckRequest.current === request) presenterDeckRequest.current = null;
          }
          if (sequence !== adminSequence.current) return;
          const recoveredProjection =
            deck.snapshotRevision === controls.snapshotRevision
              ? projectionForControl(deck, controls)
              : null;
          if (!recoveredProjection) {
            setDeckSyncPending(false);
            setDeckLoadError(true);
            return;
          }
          presenterDeckRef.current = deck;
          setPresenterDeck(deck);
          setDeckSyncPending(false);
          setDeckLoadError(false);
          setData(recoveredProjection);
          applyAdminControls(controls);
          setPollError(false);
          return;
        }
        applyAdminControls(controls);
        setDeckLoadError(false);
        setPollError(false);
        setData(projection);
      } catch (error) {
        if (sequence === adminSequence.current) {
          if ((error as { status?: number })?.status === 401) {
            presenterAuthenticated.current = false;
            presenterDeckRef.current = null;
            presenterDeckRequest.current = null;
            setPresenterDeck(null);
            applyAdminControls(null);
            setDeckSyncPending(false);
            setDeckLoadError(false);
            setData({ state: "standby" });
            setPollError(false);
          } else {
            setPollError(true);
            if (loadingDeck && !presenterDeckRef.current) {
              setDeckSyncPending(false);
              setDeckLoadError(true);
            }
          }
        }
      } finally {
        window.clearTimeout(timeout);
        // Single-flight keeps this invocation as the current controller until it finishes.
        /* v8 ignore else */
        if (adminPollAbort.current === controller) adminPollAbort.current = null;
      }
    },
    [applyAdminControls],
  );

  const refreshAdmin = useCallback(
    (checkSession = false): Promise<void> => {
      if (adminPollFlight.current) {
        const current = adminPollFlight.current;
        // Timer polls await the prior flight, while visible refreshes set checkSession.
        /* v8 ignore else */
        if (checkSession) return current.then(() => refreshAdmin(true));
        // Ordinary timer polls await their prior flight before scheduling, so no public caller joins here with checkSession=false.
        /* v8 ignore next */
        return current;
      }
      const pending = performRefreshAdmin(checkSession);
      adminPollFlight.current = pending;
      const clearFlight = () => {
        // Single-flight keeps this promise in the slot until its cleanup runs.
        /* v8 ignore else */
        if (adminPollFlight.current === pending) adminPollFlight.current = null;
      };
      void pending.then(clearFlight, clearFlight);
      return pending;
    },
    [performRefreshAdmin],
  );

  useEffect(() => {
    if (!presenterRequested) {
      presenterAuthenticated.current = false;
      applyAdminControls(null);
      setDeckSyncPending(false);
      setDeckLoadError(false);
      setPollError(false);
      return;
    }
    setPollError(false);
    let active = true;
    let timer: number | undefined;
    async function refresh() {
      // Cleanup clears the scheduled timer before an unmounted poll callback can run.
      /* v8 ignore if */
      if (!active) return;
      // Scheduling and visibility changes prevent this guard from being reached in these states.
      /* v8 ignore if */
      if (document.visibilityState === "hidden" || !presenterAuthenticated.current) return;
      if (!mutationInFlight.current) await refreshAdmin();
      schedulePoll();
    }
    function schedulePoll() {
      if (!active || document.visibilityState === "hidden" || !presenterAuthenticated.current)
        return;
      timer = window.setTimeout(() => void refresh(), 2500);
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) window.clearTimeout(timer);
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      void refreshAdmin(true).then(schedulePoll);
    };
    void refreshAdmin(true).then(schedulePoll);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      adminSequence.current += 1;
      adminPollAbort.current?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyAdminControls, presenterRequested, refreshAdmin]);

  const recoverUnauthorized = useCallback(() => {
    adminSequence.current += 1;
    presenterAuthenticated.current = false;
    adminPollAbort.current?.abort();
    applyAdminControls(null);
    presenterDeckRef.current = null;
    presenterDeckRequest.current = null;
    setPresenterDeck(null);
    setDeckSyncPending(false);
    setDeckLoadError(false);
    setPollError(false);
    setData({ state: "standby" });
  }, [applyAdminControls]);

  const requestFullscreenForIntent = useCallback(() => {
    if (fullscreenAttempted.current) return;
    fullscreenAttempted.current = true;
    const element = wrapperRef.current;
    if (!element?.requestFullscreen || document.fullscreenElement) return;
    try {
      void element.requestFullscreen().catch(() => {});
    } catch {
      // Browser support and user permission are optional for projection.
    }
  }, []);

  const operate = useCallback(
    async (action: AdminAction) => {
      const currentControls = adminControlsRef.current;
      const currentDeck = presenterDeckRef.current;
      if (!currentControls || !currentDeck || mutationInFlight.current) return;
      requestFullscreenForIntent();
      const generation = ++mutationGeneration.current;
      mutationInFlight.current = true;
      try {
        // Let any active poll finish before starting the mutation. Its result is
        // authoritative for the cursor used by this action.
        await adminPollFlight.current;
        const currentControls = adminControlsRef.current;
        const currentDeck = presenterDeckRef.current;
        if (!currentControls || !currentDeck) return;
        adminSequence.current += 1;
        const currentSlideIndex = currentDeck.slides.findIndex(
          (slide) => slide === slideForControl(currentDeck, currentControls),
        );
        const optimisticSlide =
          currentSlideIndex < 0
            ? /* v8 ignore next */ undefined // Unreachable: operate requires an aligned controls/deck cursor.
            : currentDeck.slides[currentSlideIndex + (action === "advance" ? 1 : -1)];
        if (optimisticSlide) setData(optimisticSlide.projection);
        const confirmedControls = await requestAdminAction(
          action,
          currentControls.snapshotRevision,
        );
        const confirmedProjection =
          confirmedControls.snapshotRevision !== currentDeck.snapshotRevision
            ? null
            : confirmedControls.state === "not_started" || confirmedControls.projectionHidden
              ? projectionForControl(currentDeck, confirmedControls)
              : slideForControl(currentDeck, confirmedControls)?.projection;
        if (!confirmedProjection) {
          // The server cursor does not belong to this cached deck. Re-fetch both
          // controls and deck before allowing another operation.
          applyAdminControls(null);
          presenterDeckRef.current = null;
          setPresenterDeck(null);
          setDeckLoadError(false);
          setData({ state: confirmedControls.state });
          await refreshAdmin();
        } else {
          applyAdminControls(confirmedControls);
          setData(confirmedProjection);
        }
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status === 401) recoverUnauthorized();
        if (status !== 401) {
          // A failed or malformed response may follow a committed POST. Keep the
          // current view until authoritative controls/deck state can be fetched.
          applyAdminControls(null);
          try {
            await refreshAdmin();
          } catch {
            /* The next session poll will retry. */
          }
        }
      } finally {
        // Single-flight prevents another mutation from changing this generation.
        /* v8 ignore else */
        if (generation === mutationGeneration.current) {
          mutationInFlight.current = false;
        }
      }
    },
    [applyAdminControls, recoverUnauthorized, refreshAdmin, requestFullscreenForIntent],
  );

  useEffect(() => {
    if (!adminControls || !presenterRequested) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (!(target instanceof Node) || !wrapperRef.current?.contains(target)) return;
      if (isInteractiveTarget(target)) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (adminControls.state !== "finished" && adminControls.state !== "not_started")
          void operate("advance");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        const canGoPrevious =
          adminControls.state !== "not_started" &&
          !(adminControls.state === "question" && adminControls.questionIndex === 0) &&
          !(adminControls.state === "podium_preview" && adminControls.questionCount === 0);
        if (canGoPrevious) void operate("previous");
      } else if ((event.key === " " || event.key === "Enter") && !event.isComposing) {
        event.preventDefault();
        if (adminControls.state !== "finished" && adminControls.state !== "not_started")
          void operate("advance");
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
      window.clearTimeout(suppressClickTimer.current);
    },
    [],
  );

  const handleSlideClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        window.clearTimeout(suppressClickTimer.current);
        suppressClickTimer.current = undefined;
        event.preventDefault();
        return;
      }
      if (!adminControls || isInteractiveTarget(event.target)) return;
      if (adminControls.state === "finished" || adminControls.state === "not_started") return;
      wrapperRef.current?.focus({ preventScroll: true });
      void operate("advance");
    },
    [adminControls, operate],
  );

  const handlePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.isPrimary === false || event.button !== 0 || isInteractiveTarget(event.target)) {
      pointerStart.current = null;
      return;
    }
    pointerStart.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      generation: mutationGeneration.current,
      ignored: mutationInFlight.current,
    };
  }, []);

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = pointerStart.current;
      pointerStart.current = null;
      if (
        !start ||
        start.id !== event.pointerId ||
        event.isPrimary === false ||
        !adminControls ||
        isInteractiveTarget(event.target)
      )
        return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.35) return;
      suppressClick.current = true;
      window.clearTimeout(suppressClickTimer.current);
      suppressClickTimer.current = window.setTimeout(() => {
        suppressClick.current = false;
        suppressClickTimer.current = undefined;
      }, 450);
      if (
        start.ignored ||
        mutationInFlight.current ||
        start.generation !== mutationGeneration.current
      )
        return;
      if (dx < 0) {
        if (adminControls.state !== "finished" && adminControls.state !== "not_started")
          void operate("advance");
        return;
      }
      const canGoPrevious =
        adminControls.state !== "not_started" &&
        !(adminControls.state === "question" && adminControls.questionIndex === 0) &&
        !(adminControls.state === "podium_preview" && adminControls.questionCount === 0);
      if (canGoPrevious) void operate("previous");
    },
    [adminControls, operate],
  );

  const state = data?.state;
  const loadingPresenterDeck =
    presenterRequested &&
    (deckSyncPending ||
      deckLoadError ||
      (adminControls !== null && adminControls.state !== "not_started" && presenterDeck === null));

  useLayoutEffect(() => {
    const viewport = fitViewportRef.current!;
    const layer = contentLayerRef.current!;

    let active = true;
    let frame = 0;
    let nextViewportSize: { width: number; height: number } | null = null;
    const measure = (observedSize?: { width: number; height: number }) => {
      frame = 0;
      const viewportRect = viewport.getBoundingClientRect();
      // The viewport has no padding or border; its rect is the canvas content box.
      const availableWidth = observedSize?.width ?? viewportRect.width;
      const availableHeight = observedSize?.height ?? viewportRect.height;
      const naturalWidth = layer.offsetWidth;
      const naturalHeight = Math.max(layer.offsetHeight, layer.scrollHeight);
      if (availableWidth <= 0 || availableHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0)
        return;
      const nextScale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
      const nextFit = {
        scale: nextScale,
        left: Math.max(0, (availableWidth - naturalWidth * nextScale) / 2),
        top: Math.max(0, (availableHeight - naturalHeight * nextScale) / 2),
        ready: true,
      };
      setFit((current) =>
        current.ready &&
        Math.abs(current.scale - nextFit.scale) < 0.001 &&
        Math.abs(current.left - nextFit.left) < 0.5 &&
        Math.abs(current.top - nextFit.top) < 0.5
          ? current
          : nextFit,
      );
    };
    const scheduleMeasure = () => {
      if (!active || frame) return;
      frame = window.requestAnimationFrame
        ? window.requestAnimationFrame(() => measure(nextViewportSize ?? undefined))
        : window.setTimeout(() => measure(nextViewportSize ?? undefined), 0);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === viewport);
            const firstContentBox = entry?.contentBoxSize?.[0];
            if (firstContentBox) {
              nextViewportSize = {
                width: firstContentBox.inlineSize,
                height: firstContentBox.blockSize,
              };
            }
            scheduleMeasure();
          });
    observer?.observe(viewport);
    observer?.observe(layer);
    window.addEventListener("resize", scheduleMeasure);
    const handleImageLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) scheduleMeasure();
    };
    layer.addEventListener("load", handleImageLoad, true);
    document.fonts?.ready?.then(scheduleMeasure);
    document.fonts?.addEventListener?.("loadingdone", scheduleMeasure);
    measure();

    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      layer.removeEventListener("load", handleImageLoad, true);
      document.fonts?.removeEventListener?.("loadingdone", scheduleMeasure);
      if (frame) {
        if (window.cancelAnimationFrame) window.cancelAnimationFrame(frame);
        else window.clearTimeout(frame);
      }
    };
  }, [data, loadingPresenterDeck]);

  return (
    <main
      ref={wrapperRef}
      className={styles.screen}
      tabIndex={0}
      aria-label="プレゼンテーションスライド"
      onClick={handleSlideClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        pointerStart.current = null;
      }}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className={styles.slideRegion}>
        <div
          className={styles.canvas}
          data-testid="presentation-canvas"
          role="region"
          aria-label="現在のスライド"
        >
          <div
            ref={fitViewportRef}
            className={styles.fitViewport}
            data-testid="presentation-fit-viewport"
          >
            <div
              className={styles.fitTransform}
              data-testid="presentation-fit-layer"
              style={
                {
                  left: `${fit.left}px`,
                  top: `${fit.top}px`,
                  "--presentation-fit-scale": fit.scale,
                } as CSSProperties
              }
            >
              <div
                ref={contentLayerRef}
                className={styles.contentLayer}
                data-testid="presentation-natural-layer"
                data-fit-ready={fit.ready}
                style={{ visibility: fit.ready ? "visible" : "hidden" }}
              >
                {loadingPresenterDeck && (
                  <section className={styles.waiting} aria-live="polite">
                    <p className={styles.kicker}>PREPARING PRESENTATION</p>
                    <h1>
                      {deckLoadError
                        ? "スライドを読み込めませんでした"
                        : "スライドを読み込んでいます"}
                    </h1>
                    <p className={styles.subtitle}>
                      {deckLoadError
                        ? "接続を確認しています。自動で再試行します"
                        : "少々お待ちください"}
                    </p>
                  </section>
                )}

                {state === "standby" && (
                  <section className={styles.waiting} aria-labelledby="standby-title">
                    <p className={styles.kicker}>TAKE A MOMENT</p>
                    <h1 id="standby-title">ただいま休憩中です</h1>
                    <p className={styles.subtitle}>まもなく再開します</p>
                  </section>
                )}

                {!loadingPresenterDeck && (!data || state === "not_started") && (
                  <section className={styles.waiting} aria-labelledby="presentation-title">
                    <p className={styles.kicker}>A MOMENT TO CELEBRATE</p>
                    <h1 id="presentation-title">
                      ふたりの思い出を
                      <br />
                      振り返る時間
                    </h1>
                    <p className={styles.subtitle}>発表が始まるまで、少々お待ちください</p>
                  </section>
                )}

                {state === "question" && data?.question && (
                  <QuestionPrompt question={data.question} />
                )}
                {state === "answer" && data?.question && <AnswerReview question={data.question} />}

                {state === "podium_preview" && (
                  <section className={styles.podiumPreview} aria-labelledby="podium-title">
                    <p className={styles.kicker}>THE MOMENT IS HERE</p>
                    <h1 id="podium-title">いよいよ、結果発表です</h1>
                    <p className={styles.subtitle}>これから入賞者を発表します。どうぞお楽しみに</p>
                  </section>
                )}

                {(state === "third" || state === "second" || state === "first") && (
                  <section
                    className={styles.winners}
                    role="region"
                    aria-label={`${rankTitle[state]}の勝者一覧`}
                    tabIndex={0}
                  >
                    <p className={styles.rank}>{rankTitle[state]}</p>
                    <div
                      className={`${styles.winnerNames} ${data?.winners?.length === 1 ? styles.singleWinner : ""}`}
                    >
                      {data?.winners?.length ? (
                        data.winners.map((winner, index) => (
                          <article
                            className={styles.winner}
                            key={`${winner.rank}-${winner.displayName}-${index}`}
                          >
                            <h1>
                              <span className={styles.winnerName}>
                                {winner.displayName}
                                <span className={styles.winnerHonorific}>&nbsp;さん</span>
                              </span>
                            </h1>
                            <p className={styles.winnerScore}>{winner.score.toFixed(2)} ポイント</p>
                            {winner.questionResults && (
                              <WinnerQuestionBreakdown results={winner.questionResults} />
                            )}
                          </article>
                        ))
                      ) : (
                        <h1 className={styles.noWinner}>該当する受賞者はいません</h1>
                      )}
                    </div>
                  </section>
                )}

                {state === "finished" && (
                  <section className={styles.finished} aria-labelledby="finished-title">
                    <p className={styles.kicker}>WITH LOVE AND GRATITUDE</p>
                    <h1 id="finished-title">
                      ご参加
                      <br />
                      ありがとうございました
                    </h1>
                    <p className={styles.subtitle}>
                      ふたりの思い出を一緒に祝ってくださり、心から感謝します
                    </p>
                  </section>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {pollError && (
        <p
          role="status"
          className={styles.subtitle}
          style={{ position: "fixed", top: 12, right: 16, zIndex: 40, margin: 0 }}
        >
          接続を確認しています。自動で再試行します
        </p>
      )}
    </main>
  );
}
