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
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import Image from "next/image";
import { canApplyPresenterPoll } from "@/lib/presentation/presenter-position";
import {
  usePublicProjection,
  isProjectionData,
  isMissingQuestionPayload,
  type ProjectionData,
  type PublicAnswerQuestion,
  type PublicQuestion,
  type State,
  type Winner,
  type WinnerQuestionResult,
} from "./use-public-projection";
import styles from "./presentation-screen.module.css";
type AdminState = Extract<
  State,
  | "not_started"
  | "opening"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "first_prize"
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
  "opening",
  "question",
  "answer",
  "podium_preview",
  "third",
  "second",
  "first",
  "first_prize",
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
type AdminPosition = Pick<AdminControls, "state" | "questionIndex" | "snapshotRevision">;
type PositionWriteEnvelope = AdminPosition & {
  operationId: string;
  expectedSessionVersion: number;
};
type ScreenLock = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void, options?: { once?: boolean }) => void;
};
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<ScreenLock> };
};
const POLL_TIMEOUT_MS = 8_000;
const OPENING_WAIT_MESSAGE = "発表が始まるまで、少々お待ちください";

function PresenceSlide({
  children,
  focusTargetRef,
}: {
  children: ReactNode;
  focusTargetRef: { current: HTMLElement | null };
}) {
  const isPresent = useIsPresent();
  const shouldReduceMotion = useReducedMotion();
  const slideRef = useRef<HTMLDivElement | null>(null);
  const hadFocus = useRef(false);

  useLayoutEffect(() => {
    if (isPresent) return;
    if (hadFocus.current) {
      focusTargetRef.current?.focus({ preventScroll: true });
      hadFocus.current = false;
    }
  }, [focusTargetRef, isPresent]);

  return (
    <motion.div
      ref={slideRef}
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ opacity: { duration: shouldReduceMotion ? 0 : 0.14, ease: "easeOut" } }}
      aria-hidden={!isPresent || undefined}
      inert={!isPresent}
      data-exiting={!isPresent || undefined}
      style={{ pointerEvents: isPresent ? "auto" : "none" }}
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (
          isPresent &&
          (!(event.relatedTarget instanceof Node) ||
            !slideRef.current?.contains(event.relatedTarget))
        ) {
          hadFocus.current = false;
        }
      }}
    >
      {children}
    </motion.div>
  );
}

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
  const missingQuestionPayload =
    typeof payload === "object" &&
    payload !== null &&
    "slides" in payload &&
    Array.isArray(payload.slides) &&
    payload.slides.some(
      (slide) =>
        typeof slide === "object" &&
        slide !== null &&
        "projection" in slide &&
        isMissingQuestionPayload(slide.projection),
    );
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
    throw Object.assign(new Error("スライドを読み込めませんでした。"), {
      invalidPayload: true,
      missingQuestionPayload,
    });
  return payload as unknown as PresenterDeck;
}

function projectionForControl(deck: PresenterDeck, controls: AdminControls): ProjectionData | null {
  /* v8 ignore if -- このガードは refreshAdmin の not_started 早期 return より後にしか呼ばれないため到達不能 */
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

async function requestAdminPosition(position: PositionWriteEnvelope, signal?: AbortSignal) {
  const response = await fetch("/api/admin/presentation", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationId: position.operationId,
      action: "position",
      state: position.state,
      questionIndex: position.questionIndex,
      expectedSnapshotRevision: position.snapshotRevision,
      expectedSessionVersion: position.expectedSessionVersion,
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

const rankTitle: Record<string, string> = { third: "第三位", second: "第二位", first: "第一位" };

function ExamStamp({ className }: { className: string }) {
  return (
    <Image
      className={`${styles.examStamp} ${className}`}
      src="/cert_stamp.png"
      width={1254}
      height={1254}
      alt=""
      data-testid="presentation-exam-stamp"
      aria-hidden="true"
      draggable={false}
    />
  );
}

function WinnerReveal({
  anticipationEligible,
  children,
}: {
  anticipationEligible: boolean;
  children: ReactNode;
}) {
  const eligibleAtEntry = useRef(anticipationEligible);
  useLayoutEffect(() => {
    if (!anticipationEligible) eligibleAtEntry.current = false;
  }, [anticipationEligible]);

  return (
    <div
      className={styles.winnerReveal}
      data-reveal-eligible={anticipationEligible && eligibleAtEntry.current}
    >
      <div className={styles.winnerContent}>{children}</div>
    </div>
  );
}

function PresentationFrame() {
  return (
    <Image
      className={styles.presentationFrame}
      src="/certificate_reference_style_16x9.svg"
      alt=""
      aria-hidden="true"
      fill
      unoptimized
      loading="eager"
      draggable={false}
    />
  );
}

function WinnerQuestionBreakdown({ results }: { results: WinnerQuestionResult[] }) {
  return (
    <ol className={styles.winnerQuestionResults} aria-label="設問別の回答">
      {results.map((result) => (
        <li
          key={result.position}
          className={
            [
              result.answer.kind === "freeText" ? styles.freeTextResult : "",
              result.position === 0 ? styles.firstWinnerQuestion : "",
              result.position === 1 ? styles.secondWinnerQuestion : "",
              result.position === 2 ? styles.thirdWinnerQuestion : "",
              result.position === 3 ? styles.fourthWinnerQuestion : "",
              result.position === 4 ? styles.fifthWinnerQuestion : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
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
                      : `得点 ${result.normalizedScore.toFixed(2)}`}
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
function QuestionPrompt({ question, className }: { question: PublicQuestion; className: string }) {
  return (
    <section className={`${styles.question} ${className}`} aria-labelledby="question-heading">
      <p className={styles.ordinal}>
        問 <strong>{question.ordinal}</strong>
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
        <p className={styles.ordinal}>
          問 <strong>{question.ordinal}</strong>
        </p>
        <div className={styles.answerContent}>
          <h1 id="question-heading">{question.question}</h1>
          <div className={styles.answerReveal}>
            <h2>模範解答</h2>
            <p>{question.expectedAnswer}</p>
          </div>
          {showResponses && (
            <div className={styles.answerSupplement}>
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
            </div>
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
      <p className={styles.ordinal}>
        問 <strong>{question.ordinal}</strong>
      </p>
      <div className={styles.answerContent}>
        <h1 id="question-heading">{question.question}</h1>
        <ol className={`${styles.choices} ${styles.answered} ${styles.answerReveal}`}>
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
          <div className={`${styles.explanation} ${styles.answerSupplement}`}>
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
  const [missingQuestionPayload, setMissingQuestionPayload] = useState(false);
  const [adminControls, setAdminControls] = useState<AdminControls | null>(null);
  const adminControlsRef = useRef<AdminControls | null>(null);
  const [presenterDeck, setPresenterDeck] = useState<PresenterDeck | null>(null);
  const [deckSyncPending, setDeckSyncPending] = useState(false);
  const [deckLoadError, setDeckLoadError] = useState(false);
  const [staleDeckContent, setStaleDeckContent] = useState(false);
  const [pollError, setPollError] = useState(false);
  const presenterDeckRef = useRef<PresenterDeck | null>(null);
  const presenterDeckRequest = useRef<Promise<PresenterDeck> | null>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const fitViewportRef = useRef<HTMLDivElement | null>(null);
  const contentLayerRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ scale: 1, left: 0, top: 0, ready: false });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pointerStart = useRef<{
    id: number;
    x: number;
    y: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const suppressClickTimer = useRef<number | undefined>(undefined);
  // Keep authenticated controls, deck revision, cursor writes, retry state, and session refs
  // in this screen as one presenter controller owner; their validity checks share generations.
  const adminSequence = useRef(0);
  const presenterAuthenticated = useRef(false);
  const presenterRequestedRef = useRef(presenterRequested);
  presenterRequestedRef.current = presenterRequested;
  const adminPollAbort = useRef<AbortController | null>(null);
  const adminPollFlight = useRef<Promise<void> | null>(null);
  const pendingPosition = useRef<AdminPosition | null>(null);
  const uncertainPositionWrite = useRef<PositionWriteEnvelope | null>(null);
  const confirmedSessionVersion = useRef(0);
  const presenterIntentGeneration = useRef(0);
  const positionUnconfirmed = useRef(false);
  const positionConflictRecovery = useRef(false);
  const positionWriterRunning = useRef(false);
  const positionWriterGeneration = useRef(0);
  const positionRetryTimer = useRef<number | null>(null);
  const positionAbortController = useRef<AbortController | null>(null);
  const flushPositionRef = useRef<(() => void) | null>(null);
  const clearPendingPosition = useCallback(() => {
    presenterIntentGeneration.current += 1;
    positionWriterGeneration.current += 1;
    pendingPosition.current = null;
    uncertainPositionWrite.current = null;
    positionUnconfirmed.current = false;
    positionConflictRecovery.current = false;
    positionWriterRunning.current = false;
    if (positionRetryTimer.current !== null) {
      window.clearTimeout(positionRetryTimer.current);
      positionRetryTimer.current = null;
    }
    positionAbortController.current?.abort();
  }, []);
  useEffect(
    () => () => {
      if (positionRetryTimer.current !== null) {
        window.clearTimeout(positionRetryTimer.current);
        positionRetryTimer.current = null;
      }
    },
    [],
  );
  const applyAdminControls = useCallback((controls: AdminControls | null) => {
    /* v8 ignore if -- 古い version は呼び出し元で弾かれるため到達不能 */
    if (controls && controls.version < confirmedSessionVersion.current) return;
    if (controls)
      confirmedSessionVersion.current = Math.max(confirmedSessionVersion.current, controls.version);
    adminControlsRef.current = controls;
    setAdminControls(controls);
  }, []);
  const applyScreenProjection = useCallback(
    (projection: ProjectionData | null, missingQuestion = false) => {
      setData(projection);
      setMissingQuestionPayload(missingQuestion);
    },
    [],
  );
  const applyProjection = useCallback(
    (projection: ProjectionData | null) => {
      applyScreenProjection(projection, projection === null);
    },
    [applyScreenProjection],
  );
  usePublicProjection(presenterRequested, applyProjection, setPollError);

  const performRefreshAdmin = useCallback(
    async (checkSession = false) => {
      const sequence = ++adminSequence.current;
      const intentGeneration = presenterIntentGeneration.current;
      const startedWhilePositionPending =
        positionUnconfirmed.current ||
        pendingPosition.current !== null ||
        positionWriterRunning.current;
      const canApply = () =>
        sequence === adminSequence.current &&
        canApplyPresenterPoll(
          intentGeneration,
          presenterIntentGeneration.current,
          startedWhilePositionPending,
          positionConflictRecovery.current,
        );
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
            // Authentication loss is authoritative even while optimistic position
            // persistence is pending; never retain presenter access on a 401.
            if (!presenterRequestedRef.current) return;
            clearPendingPosition();
            presenterAuthenticated.current = false;
            presenterDeckRef.current = null;
            presenterDeckRequest.current = null;
            setPresenterDeck(null);
            applyAdminControls(null);
            setDeckSyncPending(false);
            setDeckLoadError(false);
            applyScreenProjection({ state: "standby" });
            setPollError(false);
            return;
          }
          if (!sessionResponse.ok)
            throw Object.assign(new Error("管理者セッションを確認できませんでした。"), {
              status: sessionResponse.status,
            });
          if (!canApply()) return;
          presenterAuthenticated.current = true;
        }
        // Session checks return on unauthenticated outcomes or set this ref before continuing; ordinary polls run only after authentication.
        /* v8 ignore if */
        if (!presenterAuthenticated.current) return;
        controls = await getAdminControls(controller.signal);
        if (!canApply()) return;
        /* v8 ignore if -- 同上の趣旨: 古い version は呼び出し元で弾かれるため到達不能 */
        if (controls.version < confirmedSessionVersion.current) return;
        /* v8 ignore if -- canApply() が true になるのは poll 開始時に pending でなく世代一致、または conflict recovery 中だけ。前者はこの条件の pending を満たさず、後者は !positionConflictRecovery が false になるため、この return は到達不能。 */
        if (
          !positionConflictRecovery.current &&
          (pendingPosition.current || positionWriterRunning.current || positionUnconfirmed.current)
        )
          return;
        if (controls.state === "not_started") {
          if (positionConflictRecovery.current) {
            pendingPosition.current = null;
            positionUnconfirmed.current = false;
            positionConflictRecovery.current = false;
          }
          applyAdminControls(controls);
          setDeckSyncPending(false);
          setDeckLoadError(false);
          setPollError(false);
          applyScreenProjection({ state: "not_started" });
          return;
        }
        let deck = presenterDeckRef.current;
        if (!deck || deck.snapshotRevision !== controls.snapshotRevision) {
          const previousSnapshotRevision =
            presenterDeckRef.current?.snapshotRevision ??
            adminControlsRef.current?.snapshotRevision;
          presenterDeckRef.current = null;
          setPresenterDeck(null);
          loadingDeck = true;
          setDeckSyncPending(true);
          setDeckLoadError(false);
          const request = presenterDeckRequest.current ?? getPresenterDeck(controller.signal);
          presenterDeckRequest.current = request;
          try {
            deck = await request;
          } catch (error) {
            const failedRequest = error as { status?: number; invalidPayload?: boolean };
            if (canApply())
              setStaleDeckContent(
                !failedRequest.invalidPayload &&
                  controls.snapshotRevision > (previousSnapshotRevision ?? -1),
              );
            throw error;
          } finally {
            // Single-flight keeps this request current until its awaited fetch settles.
            /* v8 ignore else */
            if (presenterDeckRequest.current === request) presenterDeckRequest.current = null;
          }
          if (!canApply()) return;
          if (deck.snapshotRevision !== controls.snapshotRevision) {
            setDeckSyncPending(false);
            setDeckLoadError(true);
            setStaleDeckContent(false);
            applyAdminControls(null);
            return;
          }
          setDeckSyncPending(false);
          setStaleDeckContent(false);
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
          applyScreenProjection(null);
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
          if (!canApply()) return;
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
          setStaleDeckContent(false);
          /* v8 ignore if -- この経路は conflict 復旧で deck を再取得した場合に限る。再取得済みの同一 revision deck と controls が一致する状態を実環境で作れないため、防御的な復旧状態消去。 */
          if (positionConflictRecovery.current) {
            pendingPosition.current = null;
            positionUnconfirmed.current = false;
            positionConflictRecovery.current = false;
          }
          applyScreenProjection(recoveredProjection);
          applyAdminControls(controls);
          setPollError(false);
          return;
        }
        if (positionConflictRecovery.current) {
          const target = pendingPosition.current;
          const targetSlide = target
            ? deck.slides.find(
                (slide) =>
                  slide.state === target.state && slide.questionIndex === target.questionIndex,
              )
            : /* v8 ignore next -- positionConflictRecovery は position POST の 409 handler でのみ有効化し、その時点で pendingPosition を必ず保持する。null 分岐は壊れた内部状態に対する防御のみ。 */ undefined;
          if (target && target.snapshotRevision === controls.snapshotRevision && targetSlide) {
            pendingPosition.current = { ...target, snapshotRevision: controls.snapshotRevision };
            positionConflictRecovery.current = false;
            positionUnconfirmed.current = true;
            applyAdminControls({
              ...controls,
              state: target.state,
              questionIndex: target.questionIndex,
            });
            setDeckLoadError(false);
            setPollError(false);
            applyScreenProjection(targetSlide.projection);
            window.setTimeout(() => {
              if (pendingPosition.current && !positionWriterRunning.current) {
                positionWriterRunning.current = true;
                flushPositionRef.current?.();
              }
            }, 0);
            return;
          }
          pendingPosition.current = null;
          positionUnconfirmed.current = false;
          positionConflictRecovery.current = false;
        }
        applyAdminControls(controls);
        setDeckLoadError(false);
        setPollError(false);
        applyScreenProjection(projection);
      } catch (error) {
        const unauthorized = (error as { status?: number })?.status === 401;
        const missingQuestion =
          (error as { missingQuestionPayload?: boolean })?.missingQuestionPayload === true;
        if (missingQuestion && sequence === adminSequence.current && canApply()) {
          applyScreenProjection(null, true);
          setDeckSyncPending(false);
          setDeckLoadError(false);
          setStaleDeckContent(false);
          setPollError(false);
        } else if (unauthorized || (sequence === adminSequence.current && canApply())) {
          if (unauthorized) {
            if (!presenterRequestedRef.current) return;
            clearPendingPosition();
            presenterAuthenticated.current = false;
            presenterDeckRef.current = null;
            presenterDeckRequest.current = null;
            setPresenterDeck(null);
            applyAdminControls(null);
            setDeckSyncPending(false);
            setDeckLoadError(false);
            applyScreenProjection({ state: "standby" });
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
    [applyAdminControls, applyScreenProjection, clearPendingPosition],
  );

  const refreshAdmin = useCallback(
    (checkSession = false): Promise<void> => {
      if (!presenterRequestedRef.current) return Promise.resolve();
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
      clearPendingPosition();
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
      await refreshAdmin();
      schedulePoll();
    }
    function schedulePoll() {
      if (!active || document.visibilityState === "hidden" || !presenterAuthenticated.current)
        return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 2500);
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
        return;
      }
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      void refreshAdmin(true).then(schedulePoll);
    };
    void refreshAdmin(true).then(schedulePoll);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      adminSequence.current += 1;
      adminPollAbort.current?.abort();
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
  }, [applyAdminControls, clearPendingPosition, presenterRequested, refreshAdmin]);

  const recoverUnauthorized = useCallback(() => {
    adminSequence.current += 1;
    clearPendingPosition();
    presenterAuthenticated.current = false;
    adminPollAbort.current?.abort();
    applyAdminControls(null);
    presenterDeckRef.current = null;
    presenterDeckRequest.current = null;
    setPresenterDeck(null);
    setDeckSyncPending(false);
    setDeckLoadError(false);
    setPollError(false);
    applyScreenProjection({ state: "standby" });
  }, [applyAdminControls, applyScreenProjection, clearPendingPosition]);

  useLayoutEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(Boolean(document.fullscreenElement));
    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("fullscreenerror", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("fullscreenerror", syncFullscreenState);
    };
  }, []);

  const handleFullscreenClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const element = wrapperRef.current;
    if (!element?.requestFullscreen || document.fullscreenElement) return;
    try {
      // Keep this call directly in the user's click activation; fullscreen is optional.
      void element.requestFullscreen().catch(() => {});
    } catch {
      // Unsupported and rejected fullscreen requests must not affect presentation controls.
    }
  }, []);

  const operate = useCallback(
    async (action: "advance" | "previous") => {
      const currentControls = adminControlsRef.current;
      const currentDeck = presenterDeckRef.current;
      if (!currentControls || !currentDeck) return;
      const currentSlideIndex = currentDeck.slides.findIndex(
        (slide) => slide === slideForControl(currentDeck, currentControls),
      );
      const targetSlide = currentDeck.slides[currentSlideIndex + (action === "advance" ? 1 : -1)];
      if (!targetSlide) return;
      adminSequence.current += 1;
      presenterIntentGeneration.current += 1;
      positionUnconfirmed.current = true;
      const position = {
        state: targetSlide.state,
        questionIndex: targetSlide.questionIndex,
        snapshotRevision: currentControls.snapshotRevision,
      };
      // Update the local cursor immediately so rapid input is based on the latest slide.
      adminControlsRef.current = { ...currentControls, ...position };
      setAdminControls(adminControlsRef.current);
      applyScreenProjection(targetSlide.projection);
      pendingPosition.current = position;
      if (positionConflictRecovery.current) {
        window.setTimeout(() => void refreshAdmin(true), 0);
        return;
      }
      if (positionWriterRunning.current) return;
      if (positionRetryTimer.current !== null) {
        window.clearTimeout(positionRetryTimer.current);
        positionRetryTimer.current = null;
      }
      positionWriterRunning.current = true;
      const writerGeneration = ++positionWriterGeneration.current;
      const flushPosition = () => {
        void (async () => {
          try {
            while (
              writerGeneration === positionWriterGeneration.current &&
              (pendingPosition.current || uncertainPositionWrite.current)
            ) {
              const next = pendingPosition.current;
              const writeGeneration = presenterIntentGeneration.current;
              pendingPosition.current = null;
              const envelope = next
                ? {
                    ...next,
                    operationId: crypto.randomUUID(),
                    expectedSessionVersion: confirmedSessionVersion.current,
                  }
                : uncertainPositionWrite.current!;
              uncertainPositionWrite.current = null;
              const controller = new AbortController();
              positionAbortController.current = controller;
              try {
                const acknowledged = await requestAdminPosition(envelope, controller.signal);
                if (writerGeneration !== positionWriterGeneration.current) return;
                confirmedSessionVersion.current = Math.max(
                  confirmedSessionVersion.current,
                  acknowledged.version,
                );
                if (
                  pendingPosition.current === null &&
                  presenterIntentGeneration.current === writeGeneration
                ) {
                  positionUnconfirmed.current = false;
                }
              } catch (error) {
                if (writerGeneration !== positionWriterGeneration.current) return;
                /* v8 ignore if -- 認証喪失を起こす全経路（presenter OFF 遷移・401 セッション確認・409 復旧）が同時に clearPendingPosition 経由で positionWriterGeneration を進めるため、直前の generation 不一致ガードが必ず先に return し、この分岐の真側は到達しない防御用ガード */
                if (!presenterAuthenticated.current) return;
                const status = (error as { status?: number })?.status;
                if (status === 401) {
                  pendingPosition.current = null;
                  recoverUnauthorized();
                  return;
                }
                if (status === 409) {
                  pendingPosition.current = pendingPosition.current ?? {
                    state: envelope.state,
                    questionIndex: envelope.questionIndex,
                    snapshotRevision: envelope.snapshotRevision,
                  };
                  uncertainPositionWrite.current = null;
                  positionConflictRecovery.current = true;
                  positionUnconfirmed.current = true;
                  adminSequence.current += 1;
                  window.setTimeout(() => void refreshAdmin(), 0);
                  return;
                }
                // Retain the latest target and retry in the background; navigation stays local.
                if (pendingPosition.current === null) {
                  uncertainPositionWrite.current = envelope;
                }
                const retryTimer = window.setTimeout(() => {
                  /* v8 ignore if -- timer が登録された後に generation が変化する全経路は clearPendingPosition() が timer を解除する。timeout callback が動きつつ generation または timer ref だけが変わる実行順序は到達不能。 */
                  if (
                    writerGeneration !== positionWriterGeneration.current ||
                    positionRetryTimer.current !== retryTimer
                  )
                    return;
                  positionRetryTimer.current = null;
                  /* v8 ignore if -- presenter OFF と認証喪失は clearPendingPosition() が retry timer を解除し、pending が空のケースは retry timer を登録しない。したがって有効な callback でこの guard が真になる状態は到達不能。 */
                  if (
                    !presenterRequestedRef.current ||
                    !presenterAuthenticated.current ||
                    (!pendingPosition.current && !uncertainPositionWrite.current)
                  )
                    return;
                  positionWriterRunning.current = true;
                  flushPosition();
                }, 1000);
                positionRetryTimer.current = retryTimer;
                return;
              } finally {
                if (positionAbortController.current === controller) {
                  positionAbortController.current = null;
                }
              }
            }
          } finally {
            if (writerGeneration === positionWriterGeneration.current) {
              positionWriterRunning.current = false;
            }
          }
        })();
      };
      flushPositionRef.current = flushPosition;
      flushPosition();
    },
    [applyScreenProjection, recoverUnauthorized, refreshAdmin],
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
          adminControls.state !== "not_started" && adminControls.state !== "opening";
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
      if (dx < 0) {
        if (adminControls.state !== "finished" && adminControls.state !== "not_started")
          void operate("advance");
        return;
      }
      const canGoPrevious =
        adminControls.state !== "not_started" && adminControls.state !== "opening";
      if (canGoPrevious) void operate("previous");
    },
    [adminControls, operate],
  );

  const state = data?.state;
  const loadingPresenterDeck =
    presenterRequested &&
    !missingQuestionPayload &&
    (deckSyncPending ||
      deckLoadError ||
      (adminControls !== null && adminControls.state !== "not_started" && presenterDeck === null));
  const slideAnnouncement = (() => {
    if (loadingPresenterDeck || !data) return "";
    if (data.state === "question") return `第${data.question.ordinal}問`;
    if (data.state === "answer") return `第${data.question.ordinal}問の解説`;
    if (data.state === "third" || data.state === "second" || data.state === "first")
      return `${rankTitle[data.state]}を発表します`;
    if (data.state === "first_prize") return "1位の景品、和牛カタログを紹介します";
    if (data.state === "standby") return "休憩中";
    if (data.state === "opening") return "発表を開始しました";
    if (data.state === "podium_preview") return "結果発表を開始します";
    if (data.state === "finished") return "発表が終了しました";
    return "";
  })();

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
      const naturalWidth = Math.max(layer.offsetWidth, layer.scrollWidth);
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

  const winners =
    data && data.state !== "question" && data.state !== "answer" ? (data.winners ?? []) : [];
  const showFullscreenButton = presenterRequested && Boolean(adminControls) && !isFullscreen;
  const winnerGroups = winners.reduce<{ rank: number; winners: Winner[] }[]>((groups, winner) => {
    let group = groups.find((candidate) => candidate.rank === winner.rank);
    if (!group) {
      group = { rank: winner.rank, winners: [] };
      groups.push(group);
    }
    group.winners.push(winner);
    return groups;
  }, []);
  const slideDescriptor = (() => {
    if (!data || state === "standby") return null;
    if (state === "question" || state === "answer") {
      /* v8 ignore next -- missing question payloads are reset before apply; this remains defensive for internal callers. */
      return data.question ? { key: `${state}:${String(data.question.id)}` } : null;
    }
    if (state === "not_started") {
      return loadingPresenterDeck ? null : { key: "stage:not_started" };
    }
    /* v8 ignore next -- validated ProjectionData has a closed State union; after the earlier cases only these stage states remain. */
    if (
      state === "opening" ||
      state === "podium_preview" ||
      state === "third" ||
      state === "second" ||
      state === "first" ||
      state === "first_prize" ||
      state === "finished"
    ) {
      return { key: `stage:${state}` };
    }
    /* v8 ignore next -- validated ProjectionData has a closed State union; this is a defensive fallback. */
    return null;
  })();
  const presenceResetKey = `${staleDeckContent ? "stale" : "current"}:${fit.ready ? "fit" : "unfit"}`;

  return (
    <main
      ref={wrapperRef}
      className={`${styles.screen} ${showFullscreenButton ? styles.screenWithFullscreenButton : ""}`}
      tabIndex={0}
      aria-label="プレゼンテーションスライド"
      aria-describedby="presentation-keyboard-help"
      onClick={handleSlideClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        pointerStart.current = null;
      }}
    >
      <span id="presentation-keyboard-help" className={styles.visuallyHidden}>
        画面にフォーカスして、左右矢印キーで前後のスライドへ移動できます。Enter または Space
        キーでも次へ進めます。
      </span>
      <p className={styles.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">
        {slideAnnouncement}
      </p>
      <div className={styles.slideRegion}>
        <div
          className={styles.canvas}
          data-testid="presentation-canvas"
          role="region"
          aria-label="現在のスライド"
        >
          {!loadingPresenterDeck && (state === "not_started" || state === "opening") && (
            <div className={styles.openingFrame} aria-hidden="true" />
          )}
          {!loadingPresenterDeck &&
            (state === "third" || state === "second" || state === "first") && <PresentationFrame />}
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
                data-stale-hidden={staleDeckContent || undefined}
                style={{ visibility: fit.ready ? "visible" : "hidden" }}
              >
                {loadingPresenterDeck && (
                  <section
                    className={`${styles.waiting} ${deckLoadError ? styles.deckLoadStatus : ""}`}
                  >
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

                <div
                  className={styles.slideContent}
                  data-stale-hidden={staleDeckContent || undefined}
                  aria-hidden={staleDeckContent || undefined}
                  inert={staleDeckContent || undefined}
                >
                  {state === "standby" && (
                    <section className={styles.waiting} aria-labelledby="standby-title">
                      <h1 id="standby-title">ただいま休憩中です</h1>
                      <p className={styles.subtitle}>まもなく再開します</p>
                    </section>
                  )}

                  {!loadingPresenterDeck && !data && !missingQuestionPayload && (
                    <section className={styles.opening} aria-labelledby="presentation-title">
                      <div className={styles.openingLockup}>
                        <div className={styles.openingAnchor}>
                          <p className={styles.openingEdition}>令和八年度第一回</p>
                          <div className={styles.openingTitle}>
                            <h1 id="presentation-title" aria-label="しゅんたま検定">
                              <span>しゅんたま</span>
                              <span>検定</span>
                            </h1>
                          </div>
                        </div>
                      </div>
                      <p className={styles.openingSubtitle}>解答解説・表彰</p>
                      <div className={styles.openingWaitSlot}>
                        <p className={styles.openingWait}>{OPENING_WAIT_MESSAGE}</p>
                      </div>
                    </section>
                  )}

                  {slideDescriptor && (
                    <AnimatePresence mode="wait" initial={false} key={presenceResetKey}>
                      <PresenceSlide key={slideDescriptor.key} focusTargetRef={wrapperRef}>
                        {state === "not_started" && (
                          <section className={styles.opening} aria-labelledby="presentation-title">
                            <div className={styles.openingLockup}>
                              <div className={styles.openingAnchor}>
                                <p className={styles.openingEdition}>令和八年度第一回</p>
                                <div className={styles.openingTitle}>
                                  <h1 id="presentation-title" aria-label="しゅんたま検定">
                                    <span>しゅんたま</span>
                                    <span>検定</span>
                                  </h1>
                                </div>
                              </div>
                            </div>
                            <p className={styles.openingSubtitle}>解答解説・表彰</p>
                            <div className={styles.openingWaitSlot}>
                              <p className={styles.openingWait}>{OPENING_WAIT_MESSAGE}</p>
                            </div>
                          </section>
                        )}

                        {state === "opening" && (
                          <section
                            className={`${styles.opening} ${styles.openingMotion}`}
                            aria-labelledby="opening-title"
                          >
                            <ExamStamp className={styles.openingStamp} />
                            <div className={styles.openingLockup}>
                              <div className={styles.openingAnchor}>
                                <p className={styles.openingEdition}>令和八年度第一回</p>
                                <div className={styles.openingTitle}>
                                  <h1 id="opening-title" aria-label="しゅんたま検定">
                                    <span>しゅんたま</span>
                                    <span>検定</span>
                                  </h1>
                                </div>
                              </div>
                            </div>
                            <p className={styles.openingSubtitle}>解答解説・表彰</p>
                            <div className={styles.openingWaitSlot} aria-hidden="true">
                              <p className={styles.openingWait}>{OPENING_WAIT_MESSAGE}</p>
                            </div>
                          </section>
                        )}

                        {state === "question" && data?.question && (
                          <QuestionPrompt
                            key={`question:${String(data.question.id)}`}
                            question={data.question}
                            className={styles.questionMotion}
                          />
                        )}
                        {state === "answer" && data?.question && (
                          <AnswerReview
                            key={`answer:${String(data.question.id)}`}
                            question={data.question}
                          />
                        )}

                        {state === "podium_preview" && (
                          <section
                            className={`${styles.podiumPreview} ${styles.podiumPreviewMotion}`}
                            aria-labelledby="podium-title"
                          >
                            <h1 id="podium-title">いよいよ、結果発表です</h1>
                            <p className={styles.subtitle}>
                              これから入賞者を発表します。どうぞお楽しみに
                            </p>
                          </section>
                        )}

                        {state === "first_prize" && (
                          <section
                            className={styles.firstPrize}
                            aria-labelledby="first-prize-title"
                          >
                            <header className={styles.firstPrizeHeader}>
                              <p>1位の景品</p>
                              <h1 id="first-prize-title">和牛カタログ</h1>
                            </header>
                            <div className={styles.firstPrizeImages}>
                              <Image
                                className={styles.firstPrizeBeef}
                                src="/和牛.png"
                                width={640}
                                height={322}
                                alt="和牛の写真"
                                sizes="(max-width: 1666px) 60vw, 1000px"
                                loading="eager"
                                draggable={false}
                              />
                              <Image
                                className={styles.firstPrizeCatalog}
                                src="/和牛カタログ.jpg"
                                width={250}
                                height={275}
                                alt="和牛カタログの表紙"
                                sizes="(max-width: 1785px) 28vw, 500px"
                                loading="eager"
                                draggable={false}
                              />
                            </div>
                          </section>
                        )}

                        {(state === "third" || state === "second" || state === "first") && (
                          <section
                            key={state}
                            className={styles.winners}
                            role="region"
                            aria-label={`${rankTitle[state]}の勝者一覧`}
                            data-rank={state}
                            tabIndex={0}
                          >
                            <ExamStamp className={styles.rankStamp} />
                            <div className={styles.rankHeader}>
                              <span className={styles.certificateLabel}>認定証</span>
                              <div className={styles.rankHeading}>
                                <span className={styles.rankOrnament} aria-hidden="true" />
                                <h1 className={styles.rank}>{rankTitle[state]}</h1>
                              </div>
                            </div>
                            <WinnerReveal
                              anticipationEligible={
                                state === "first" && winnerGroups.some(({ rank }) => rank === 1)
                              }
                            >
                              {winnerGroups.length ? (
                                winnerGroups.map(({ rank, winners }) => (
                                  <div className={styles.winnerRankGroup} key={rank}>
                                    <div
                                      className={`${styles.winnerNames} ${winners.length === 1 ? styles.singleWinner : ""}`}
                                    >
                                      {winners.slice(0, 2).map((winner, index) => (
                                        <article
                                          className={styles.winner}
                                          key={`${winner.rank}-${winner.displayName}-${index}`}
                                        >
                                          <div className={styles.winnerIdentity}>
                                            <h1>
                                              <span
                                                className={`${styles.winnerName} ${[...winner.displayName].length <= 7 ? styles.shortWinnerName : ""}`}
                                              >
                                                {winner.displayName}
                                                <span className={styles.winnerHonorific}>
                                                  &nbsp;殿
                                                </span>
                                              </span>
                                            </h1>
                                            <p className={styles.winnerScore}>
                                              {winner.score.toFixed(2)} ポイント
                                            </p>
                                          </div>
                                          {winner.questionResults && (
                                            <WinnerQuestionBreakdown
                                              results={winner.questionResults}
                                            />
                                          )}
                                        </article>
                                      ))}
                                    </div>
                                    {winners.length > 2 && (
                                      <p className={styles.additionalWinners}>
                                        ほか {winners.length - 2} 名
                                      </p>
                                    )}
                                  </div>
                                ))
                              ) : (
                                <h1 className={styles.noWinner}>該当する受賞者はいません</h1>
                              )}
                            </WinnerReveal>
                          </section>
                        )}

                        {state === "finished" && (
                          <section
                            className={`${styles.finished} ${styles.finishedMotion}`}
                            aria-labelledby="finished-title"
                          >
                            <h1 id="finished-title">
                              ご参加
                              <br />
                              ありがとうございました
                            </h1>
                          </section>
                        )}
                      </PresenceSlide>
                    </AnimatePresence>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {showFullscreenButton && (
        <button
          type="button"
          className={styles.fullscreenButton}
          onClick={handleFullscreenClick}
          data-no-slide-advance
          aria-label="全画面表示"
        >
          全画面表示
        </button>
      )}
      {pollError && (
        <p
          role="note"
          aria-live="off"
          className={styles.subtitle}
          style={{ position: "fixed", top: 12, right: 16, zIndex: 40, margin: 0 }}
        >
          スライドの状態を確認できません。自動で再試行します
        </p>
      )}
    </main>
  );
}
