"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useQuizSession } from "./use-quiz-session";
import ChoiceButton from "@/components/ChoiceButton";
import { choiceLabel } from "@/lib/choice-label";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/Spinner";
import styles from "./quiz-runner.module.css";
import { ApiError } from "@/lib/api/client";
import { parseParticipantResult } from "@/lib/participant-results-contract";
import { HeaderPortal } from "./header-portal";
import { resolveAnswererDisplay } from "./answerer-display";
import type { AccessState, AnswerMode, Phase } from "./use-quiz-session";

type AnswerUiSurface =
  | "access-checking"
  | "assisted-login"
  | "login"
  | "switching"
  | "checking-submission"
  | "reauthentication"
  | "submission-error"
  | "owner-return-error"
  | "loading"
  | "shortage"
  | "load-error"
  | "complete"
  | "answering";

type AnswerUiAction =
  | "login"
  | "start-assisted"
  | "reauthenticate"
  | "retry-submission-check"
  | "retry-load"
  | "retry-owner-return"
  | "refresh-saved-answers"
  | "retry-submit"
  | "submit"
  | "edit-answers"
  | null;

type AnswerUiModel = {
  surface: AnswerUiSurface;
  status: string;
  message: string;
  statusRole: "status" | "alert";
  busy: boolean;
  primaryAction: AnswerUiAction;
};

function hasAnswer(
  question: { id: number; answerType: "selected" | "freeText" },
  selections: Record<number, number | undefined>,
  freeResponses: Record<number, string>,
): boolean {
  return question.answerType === "freeText"
    ? Boolean(freeResponses[question.id]?.trim())
    : selections[question.id] !== undefined;
}

function deriveAnswerUi({
  access,
  assistedScreen,
  phase,
  unansweredCount,
  restoreError,
}: {
  access: AccessState;
  assistedScreen: "closed" | "login" | "active";
  phase: Phase;
  unansweredCount: number;
  restoreError: string | null;
}): AnswerUiModel {
  let surface: AnswerUiSurface;
  if (access.kind === "checking") surface = "access-checking";
  else if (assistedScreen === "login") surface = "assisted-login";
  else if (access.kind === "login") surface = "login";
  else if (access.kind === "switching") surface = "switching";
  else if (
    access.kind === "reauthentication" &&
    phase.kind !== "answering" &&
    phase.kind !== "owner-return-error" &&
    phase.kind !== "complete"
  ) {
    surface = "reauthentication";
  } else if (
    phase.kind === "checking-submission" ||
    (phase.kind === "ready" && access.kind === "ready")
  ) {
    surface = "checking-submission";
  } else if (phase.kind === "submission-error") surface = "submission-error";
  else if (phase.kind === "owner-return-error") surface = "owner-return-error";
  else if (phase.kind === "loading") surface = "loading";
  else if (phase.kind === "shortage") surface = "shortage";
  else if (phase.kind === "load-error") surface = "load-error";
  else if (phase.kind === "complete") surface = "complete";
  else surface = "answering";

  if (access.kind === "reauthentication") {
    const isComplete = phase.kind === "complete";
    const message = isComplete
      ? "全5問の回答は記録されています。回答の修正や代理回答を続けるには再ログインしてください。回答は自動送信されません。"
      : phase.kind === "answering"
        ? `${phase.message ? `${phase.message} ` : ""}回答案は保持しています。再ログイン後に内容を確認してから、必要な操作を改めて確定してください。`
        : phase.kind === "owner-return-error"
          ? "代理回答は保存されています。本人として再ログインすると、自分の回答状況を確認できます。"
          : phase.kind === "submission-error" || phase.kind === "load-error"
            ? `${phase.message}再ログイン後に状態を確認し、必要な操作を改めて行ってください。回答は自動送信されません。`
            : "再ログイン後、現在の状態を確認してから次の操作を行ってください。回答は自動送信されません。";
    return {
      surface,
      status: isComplete ? "回答済み" : "参加状態の確認が必要です",
      message,
      statusRole: "alert",
      busy: false,
      primaryAction: "reauthenticate",
    };
  }

  if (surface === "access-checking") {
    return {
      surface,
      status: "参加状態を確認しています…",
      message: "確認が終わるまでお待ちください。",
      statusRole: "status",
      busy: true,
      primaryAction: null,
    };
  }
  if (surface === "assisted-login") {
    return {
      surface,
      status: "代理回答",
      message: "回答する人のお名前を入力してください。この画面からは、お一人分の回答を行えます。",
      statusRole: "status",
      busy: false,
      primaryAction: "start-assisted",
    };
  }
  if (surface === "login") {
    return {
      surface,
      status: "参加して検定を受ける",
      message: "受験者氏名と主催者から案内された受験コードを入力してください。",
      statusRole: "status",
      busy: false,
      primaryAction: "login",
    };
  }
  if (surface === "switching") {
    return {
      surface,
      status: "参加状態を切り替えています…",
      message: "切り替えが終わるまでお待ちください。",
      statusRole: "status",
      busy: true,
      primaryAction: null,
    };
  }
  if (surface === "checking-submission") {
    return {
      surface,
      status: "保存済みの回答状況を確認しています…",
      message: "確認が終わるまでお待ちください。",
      statusRole: "status",
      busy: true,
      primaryAction: null,
    };
  }
  if (surface === "submission-error" && phase.kind === "submission-error") {
    return {
      surface,
      status: "回答状況を確認できませんでした",
      message: phase.message,
      statusRole: "alert",
      busy: false,
      primaryAction: "retry-submission-check",
    };
  }
  if (surface === "owner-return-error" && phase.kind === "owner-return-error") {
    return {
      surface,
      status: "代理回答を保存しました",
      message: phase.message,
      statusRole: "alert",
      busy: false,
      primaryAction: "retry-owner-return",
    };
  }
  if (surface === "loading") {
    return {
      surface,
      status: "全5問を準備しています…",
      message: "準備が終わるまでお待ちください。",
      statusRole: "status",
      busy: true,
      primaryAction: null,
    };
  }
  if (surface === "shortage") {
    return {
      surface,
      status: "問題が足りません",
      message:
        "全5問をそろえられないため、検定を開始できません。問題が5問そろったら、もう一度お試しください。",
      statusRole: "alert",
      busy: false,
      primaryAction: null,
    };
  }
  if (surface === "load-error" && phase.kind === "load-error") {
    return {
      surface,
      status: "問題を読み込めませんでした",
      message: phase.message,
      statusRole: "alert",
      busy: false,
      primaryAction: "retry-load",
    };
  }
  if (surface === "complete") {
    return {
      surface,
      status: "回答済み",
      message: "",
      statusRole: "status",
      busy: false,
      primaryAction: restoreError ? null : "edit-answers",
    };
  }

  if (phase.kind === "submitting") {
    return {
      surface,
      status: "回答を送信しています…",
      message: "送信が完了するまで、回答の変更や再送はできません。",
      statusRole: "status",
      busy: true,
      primaryAction: null,
    };
  }
  if (phase.kind === "refreshing") {
    return {
      surface,
      status: "保存済み回答を確認しています…",
      message: "確認が終わるまで、回答の変更や送信はできません。",
      statusRole: "status",
      busy: true,
      primaryAction: null,
    };
  }
  if (phase.kind === "answering" && phase.refreshRequired) {
    return {
      surface,
      status: "保存済み回答の再確認が必要です",
      message: `${phase.message ?? "保存済み回答が更新されています。"}回答案は保持しています。再確認後に送信できます。`,
      statusRole: "alert",
      busy: false,
      primaryAction: "refresh-saved-answers",
    };
  }
  if (phase.kind === "answering" && phase.retryRequired) {
    const canRetry = unansweredCount === 0;
    return {
      surface,
      status: "回答を再送できます",
      message: `${phase.message ?? "回答は保存できませんでした。"}回答案は保持しています。同じ内容を再送してください。`,
      statusRole: "alert",
      busy: false,
      primaryAction: canRetry ? "retry-submit" : null,
    };
  }
  if (phase.kind === "answering" && phase.message) {
    return {
      surface,
      status: "回答内容を確認してください",
      message: `${phase.message}回答案は保持しています。内容を確認して、もう一度確定してください。`,
      statusRole: "alert",
      busy: false,
      primaryAction: unansweredCount === 0 ? "submit" : null,
    };
  }
  return {
    surface,
    status: unansweredCount > 0 ? `未回答 ${unansweredCount}問` : "全5問に回答しました。",
    message:
      unansweredCount > 0
        ? "未回答の設問へ移動して回答してください。回答は最後にまとめて確定します。"
        : "回答内容を確認してから、5問をまとめて確定してください。",
    statusRole: "status",
    busy: false,
    primaryAction: unansweredCount === 0 ? "submit" : null,
  };
}

export default function QuizRunner() {
  const {
    answerMode,
    assistedScreen,
    assistedParticipant,
    assistedError,
    assistedBusy,
    openAssistedLogin,
    startAssisted,
    resumeAssisted,
    returnToOwner,
    access,
    phase,
    restoreError,
    quizzes,
    selections,
    freeResponses,
    legacyAnswerIds,
    savedSelections,
    answeredCount,
    select,
    setFreeResponse,
    saveAnswers,
    submissionId,
    revision,
    refreshSavedAnswers,
    editAnswers,
    clearPublishedLock,
    retryLoad,
    retrySubmissionCheck,
    login,
  } = useQuizSession();
  const questionRefs = useRef<Record<number, HTMLHeadingElement | null>>({});
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const finalCheckHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const previousPhaseKind = useRef(phase.kind);
  const shouldFocusSubmissionRef = useRef(false);
  const shouldFocusCompletion = useRef(false);
  const shouldFocusRetrySubmissionAfterReauthentication = useRef(false);
  const checkedSubmissionAfterReauthentication = useRef(false);
  const [reauthenticationSuccessCount, setReauthenticationSuccessCount] = useState(0);
  const [participantResultsVisible, setParticipantResultsVisible] = useState(false);
  const [participantResultsAuthExpired, setParticipantResultsAuthExpired] = useState(false);
  const [submissionVisibility, setSubmissionVisibility] = useState<{
    key: string;
    status: "unknown" | "locked" | "unlocked";
  } | null>(null);
  const currentVisibilityKey = [
    access.kind === "ready" ? access.participant.id : "unauthenticated",
    answerMode,
    answerMode === "assisted"
      ? (assistedParticipant?.participant?.id ?? "missing-target")
      : "owner",
    submissionId ?? "missing-submission",
  ].join(":");
  const visibilityStatus =
    submissionVisibility?.key === currentVisibilityKey ? submissionVisibility.status : "unknown";
  const retryRequired = phase.kind === "answering" && phase.retryRequired;
  useEffect(() => {
    if (phase.kind !== "complete" || access.kind !== "ready") {
      setParticipantResultsVisible(false);
      setParticipantResultsAuthExpired(false);
      return;
    }
    let active = true;
    let pending = false;
    let refreshQueued = false;
    let requestRevision = 0;
    const refresh = async () => {
      if (pending) {
        refreshQueued = true;
        requestRevision += 1;
        return;
      }
      pending = true;
      const currentRevision = ++requestRevision;
      try {
        const resultsUrl =
          answerMode === "assisted"
            ? "/api/participants/results?scope=assisted"
            : "/api/participants/results";
        const response = await fetch(resultsUrl, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!active || currentRevision !== requestRevision) return;
        if (response.status === 401) {
          setParticipantResultsVisible(false);
          setParticipantResultsAuthExpired(true);
          return;
        }
        if (!response.ok) return;
        const result = parseParticipantResult(await response.json());
        if (active && currentRevision === requestRevision) {
          if (!result) return;
          setParticipantResultsVisible(result.state === "visible");
          setParticipantResultsAuthExpired(false);
        }
      } catch {
        // Keep the last confirmed CTA state when a refresh fails.
      } finally {
        pending = false;
        if (active && refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    void refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [access.kind, answerMode, phase.kind]);
  useEffect(() => {
    const editingSubmission = phase.kind === "answering" || phase.kind === "complete";
    const visibilityKey = currentVisibilityKey;
    const markVisibilityUnknown = () =>
      setSubmissionVisibility((current) =>
        current?.key === visibilityKey && current.status === "unknown"
          ? current
          : { key: visibilityKey, status: "unknown" },
      );
    if (!submissionId || revision === 0 || !editingSubmission || access.kind !== "ready") {
      markVisibilityUnknown();
      return;
    }
    let active = true;
    let pending = false;
    const refreshLock = async () => {
      if (pending) return;
      pending = true;
      try {
        const scope = answerMode === "assisted" ? "&scope=assisted" : "";
        const response = await fetch(
          `/api/answers/batch?submissionId=${encodeURIComponent(submissionId)}${scope}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (!active) return;
        if (!response.ok) throw new Error("Visibility lookup failed");
        const payload: unknown = await response.json();
        if (!active) return;
        if (typeof payload !== "object" || payload === null) {
          markVisibilityUnknown();
          return;
        }
        const resultsVisible = (payload as { resultsVisible?: unknown }).resultsVisible;
        if (typeof resultsVisible === "boolean") {
          setSubmissionVisibility({
            key: visibilityKey,
            status: resultsVisible ? "locked" : "unlocked",
          });
          if (!resultsVisible) clearPublishedLock?.();
        } else {
          markVisibilityUnknown();
        }
      } catch {
        if (active) markVisibilityUnknown();
      } finally {
        pending = false;
      }
    };
    void refreshLock();
    const interval = window.setInterval(() => void refreshLock(), 5000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshLock();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    access,
    answerMode,
    assistedParticipant?.participant?.id,
    clearPublishedLock,
    phase.kind,
    revision,
    submissionId,
    currentVisibilityKey,
  ]);
  useEffect(() => {
    const previousKind = previousPhaseKind.current;
    previousPhaseKind.current = phase.kind;

    if (previousKind === "answering" && phase.kind === "submitting") {
      const wasExplicitlySubmitted = shouldFocusSubmissionRef.current;
      shouldFocusSubmissionRef.current = false;
      shouldFocusCompletion.current = wasExplicitlySubmitted;
      if (wasExplicitlySubmitted) {
        finalCheckHeadingRef.current?.focus({ preventScroll: true });
      }
      return;
    }

    if (previousKind === "submitting" && phase.kind === "complete") {
      if (shouldFocusCompletion.current && document.activeElement === document.body) {
        completionHeadingRef.current?.focus({ preventScroll: true });
      }
      shouldFocusCompletion.current = false;
      return;
    }

    if (
      previousKind === "submitting" &&
      phase.kind === "checking-submission" &&
      answerMode === "owner"
    ) {
      return;
    }

    if (phase.kind === "complete" && shouldFocusCompletion.current) {
      if (document.activeElement === document.body) {
        completionHeadingRef.current?.focus({ preventScroll: true });
      }
      shouldFocusCompletion.current = false;
      return;
    }

    if (previousKind === "submitting") {
      shouldFocusCompletion.current = false;
    }
  }, [answerMode, phase.kind]);
  useEffect(() => {
    if (phase.kind !== "submitting" || !shouldFocusCompletion.current) return;
    const handleFocusIn = (event: FocusEvent) => {
      if (event.target !== finalCheckHeadingRef.current) {
        shouldFocusCompletion.current = false;
      }
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [phase.kind]);
  useEffect(() => {
    if (!shouldFocusRetrySubmissionAfterReauthentication.current) return;
    if (phase.kind === "checking-submission") {
      checkedSubmissionAfterReauthentication.current = true;
      return;
    }
    if (
      access.kind !== "ready" ||
      phase.kind !== "answering" ||
      !retryRequired ||
      !checkedSubmissionAfterReauthentication.current
    ) {
      return;
    }

    shouldFocusRetrySubmissionAfterReauthentication.current = false;
    checkedSubmissionAfterReauthentication.current = false;
    submitButtonRef.current!.focus({ preventScroll: true });
  }, [access.kind, phase.kind, reauthenticationSuccessCount, retryRequired]);
  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      if (
        shouldFocusRetrySubmissionAfterReauthentication.current &&
        event.target !== document.body
      ) {
        shouldFocusRetrySubmissionAfterReauthentication.current = false;
        checkedSubmissionAfterReauthentication.current = false;
      }
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);
  const isSubmitting = phase.kind === "submitting";
  const isRefreshing = phase.kind === "refreshing";
  const unanswered = quizzes.filter(
    ({ question }) => !hasAnswer(question, selections, freeResponses),
  );
  const ui = deriveAnswerUi({
    access,
    assistedScreen,
    phase,
    unansweredCount: unanswered.length,
    restoreError,
  });
  const ownerName =
    access.kind === "ready" || access.kind === "reauthentication"
      ? access.participant.name || "本人"
      : "本人";

  function jumpToQuestion(questionId: number, focusAnswer = false) {
    const heading = questionRefs.current[questionId];
    heading?.scrollIntoView({ behavior: "auto", block: "start" });
    if (focusAnswer) {
      const section = document.getElementById(`question-${questionId}`);
      const answerInput =
        section?.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled)') ??
        section?.querySelector<HTMLElement>(
          'textarea:not(:disabled), input[type="radio"]:not(:disabled)',
        );
      (answerInput ?? heading)?.focus({ preventScroll: true });
      return;
    }
    heading?.focus({ preventScroll: true });
  }

  if (ui.surface === "access-checking") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          {ui.status}
        </p>
      </main>
    );
  }

  if (ui.surface === "assisted-login") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1 className="text-3xl font-bold tracking-tight">
            {ui.primaryAction === "reauthenticate" ? ui.status : "代理回答"}
          </h1>
          <p className="mt-4 max-w-xl leading-relaxed text-muted">{ui.message}</p>
          <AssistedParticipantForm
            onSubmit={startAssisted}
            message={assistedError}
            busy={assistedBusy}
            variant={ui.primaryAction === "start-assisted" ? "primary" : "outline"}
          />
          {access.kind === "reauthentication" && (
            <section
              className="mt-8 border-t border-border pt-6"
              aria-labelledby="assisted-reauth-title"
            >
              <h2 id="assisted-reauth-title" className="text-lg font-bold">
                {ui.status}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {ui.message} 入力したお名前はこの画面に残ります。
              </p>
              <ParticipantForm
                onLogin={login}
                initialName={access.participant.name}
                submitLabel="再ログインする"
              />
            </section>
          )}
          <Button
            variant="outline"
            className="mt-5"
            onClick={() => returnToOwner()}
            disabled={assistedBusy}
          >
            自分の回答に戻る
          </Button>
        </ParticipantCard>
      </main>
    );
  }

  if (ui.surface === "login" && access.kind === "login") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1 className="text-3xl font-bold tracking-tight">参加して検定を受ける</h1>
          <p className="mt-4 max-w-xl leading-relaxed text-muted">{ui.message}</p>
          <ParticipantForm
            onLogin={login}
            message={access.message}
            nameLabel="受験者氏名"
            pinLabel="受験コード"
          />
        </ParticipantCard>
      </main>
    );
  }

  if (ui.surface === "switching") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          {ui.status}
        </p>
      </main>
    );
  }

  if (ui.surface === "checking-submission") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          {ui.status}
        </p>
      </main>
    );
  }

  if (ui.surface === "reauthentication" && access.kind === "reauthentication") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1 className="text-3xl font-bold tracking-tight">{ui.status}</h1>
          <p className="mt-4 text-muted" role={ui.statusRole}>
            {ui.message}
          </p>
          <ParticipantForm
            onLogin={login}
            initialName={access.participant.name}
            submitLabel="再ログインする"
          />
        </ParticipantCard>
      </main>
    );
  }

  if (ui.surface === "submission-error") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1 className="text-3xl font-bold tracking-tight">{ui.status}</h1>
          <p className="mt-4 text-muted" role={ui.statusRole}>
            {ui.message}
          </p>
          <Button onClick={retrySubmissionCheck} className="mt-8" variant="primary">
            もう一度確認する
          </Button>
        </ParticipantCard>
      </main>
    );
  }

  if (ui.surface === "owner-return-error") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1 className="text-3xl font-bold tracking-tight">{ui.status}</h1>
          <p className="mt-4 text-muted" role={ui.statusRole}>
            {ui.message}
          </p>
          {access.kind === "reauthentication" && (
            <section
              className="mt-6 rounded-xl border border-border bg-surface-2 p-5"
              aria-labelledby="owner-return-reauth-title"
            >
              <h2 id="owner-return-reauth-title" className="text-lg font-bold">
                参加状態の確認が必要です
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                代理回答は保存されています。本人として再ログインすると、自分の回答状況を確認します。
              </p>
              <ParticipantForm
                onLogin={login}
                initialName={access.participant.name}
                submitLabel="再ログインする"
              />
            </section>
          )}
          <Button
            onClick={retrySubmissionCheck}
            className="mt-8"
            disabled={access.kind !== "ready"}
            variant={ui.primaryAction === "retry-owner-return" ? "primary" : "outline"}
          >
            自分の回答状況をもう一度確認する
          </Button>
        </ParticipantCard>
      </main>
    );
  }

  if (ui.surface === "loading") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          {ui.status}
        </p>
      </main>
    );
  }

  if (ui.surface === "shortage") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1 className="text-3xl font-bold tracking-tight">{ui.status}</h1>
          <p className="mt-4 text-muted">{ui.message}</p>
        </ParticipantCard>
      </main>
    );
  }

  if (ui.surface === "load-error") {
    const hasLoadedQuestions = quizzes.length > 0;
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1 className="text-3xl font-bold tracking-tight">{ui.status}</h1>
          <p className="mt-4 text-muted" role={ui.statusRole}>
            {ui.message}
          </p>
          {hasLoadedQuestions && (
            <p className="mt-3 text-sm leading-relaxed text-muted" role="status" aria-live="polite">
              取得済みの{quizzes.length}問は保持しています。不足分から再開できます。
            </p>
          )}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button onClick={retryLoad} variant="primary">
              {hasLoadedQuestions ? "不足分を再読み込み" : "もう一度読み込む"}
            </Button>
          </div>
        </ParticipantCard>
      </main>
    );
  }

  if (ui.surface === "complete") {
    const answeringForAssisted = answerMode === "assisted";
    const canAnswerForAssisted =
      answerMode === "owner" &&
      access.kind === "ready" &&
      (assistedParticipant === null ||
        Boolean(assistedParticipant.participant) ||
        assistedParticipant.eligible);
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
          <h1
            ref={completionHeadingRef}
            tabIndex={-1}
            className="text-3xl font-bold tracking-tight focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-4"
          >
            {ui.status}
          </h1>
          {ui.message && (
            <p className="mt-4 text-muted" role={ui.statusRole} aria-live="polite">
              {ui.message}
            </p>
          )}
          <AnswererNameField
            answerMode={answerMode}
            ownerName={ownerName}
            assistedName={assistedParticipant?.participant?.name}
            className="mt-3"
          />
          <p className="mt-2 text-sm leading-relaxed text-muted">
            回答を見直す場合は、同じ5問の回答を復元して修正できます。
          </p>
          {restoreError && (
            <p className="mt-4 text-sm font-medium text-error" role="alert">
              {restoreError}
            </p>
          )}
          {(access.kind === "reauthentication" || participantResultsAuthExpired) && (
            <section
              className="mt-6 rounded-xl border border-border bg-surface-2 p-5"
              aria-labelledby="complete-reauth-title"
            >
              <h2 id="complete-reauth-title" className="text-lg font-bold">
                参加状態の確認が必要です
              </h2>
              {ui.message && (
                <p className="mt-2 text-sm leading-relaxed text-muted" role={ui.statusRole}>
                  {ui.message}
                </p>
              )}
              <p className="mt-2 text-sm leading-relaxed text-muted">
                再ログイン後、回答の修正や代理回答を続けられます。
              </p>
              <ParticipantForm
                onLogin={login}
                initialName={ownerName}
                onSuccess={() => setParticipantResultsAuthExpired(false)}
                submitLabel="再ログインする"
              />
            </section>
          )}
          <Button
            onClick={editAnswers}
            className="mt-8"
            disabled={Boolean(restoreError) || visibilityStatus !== "unlocked"}
            variant={ui.primaryAction === "edit-answers" ? "primary" : "outline"}
          >
            回答を修正する
          </Button>
          {visibilityStatus === "locked" && (
            <p className="mt-3 text-sm leading-relaxed text-muted" role="status" aria-live="polite">
              結果が公開されているため、回答は修正できません。主催者が結果を非公開にすると、再び修正できます。
            </p>
          )}
          {visibilityStatus === "unknown" && !restoreError && (
            <p className="mt-3 text-sm leading-relaxed text-muted" role="status" aria-live="polite">
              回答の公開状態を確認しています。確認できるまで編集はできません。
            </p>
          )}
          {answeringForAssisted && (
            <Button variant="outline" className="mt-3" onClick={() => returnToOwner()}>
              自分の回答に戻る
            </Button>
          )}
          {!answeringForAssisted && canAnswerForAssisted && (
            <div className="mt-4">
              {assistedError && (
                <p className="mb-2 text-sm text-error" role="alert">
                  {assistedError}
                </p>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  if (assistedParticipant?.participant) void resumeAssisted();
                  else openAssistedLogin();
                }}
                disabled={assistedBusy}
              >
                {assistedBusy
                  ? "回答状態を確認しています…"
                  : assistedParticipant?.hasSubmission
                    ? "代理回答を修正する"
                    : "代理回答を行う"}
              </Button>
              {assistedParticipant?.participant && !assistedParticipant.hasSubmission && (
                <p className="mt-2 text-sm text-muted">
                  {assistedParticipant.participant.name}さんの回答を再開できます。
                </p>
              )}
            </div>
          )}
          {participantResultsVisible && !participantResultsAuthExpired && (
            <div className="mt-3 flex flex-col items-start gap-2">
              <Link
                href="/results"
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-primary px-5 font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                自分の結果を見る
              </Link>
              {assistedParticipant?.hasSubmission && (
                <Link
                  href="/results?scope=assisted"
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-primary px-5 font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  代理回答の結果を見る
                </Link>
              )}
            </div>
          )}
        </ParticipantCard>
      </main>
    );
  }

  const refreshRequired = phase.kind === "answering" && phase.refreshRequired;
  const visibilityRequired = revision > 0 || phase.kind === "complete";
  const publishedLock =
    (visibilityRequired && visibilityStatus === "locked") ||
    (phase.kind === "answering" && phase.publishedLock === true);
  const visibilityUnknown = visibilityRequired && visibilityStatus === "unknown";
  const submissionBlocked =
    isSubmitting || isRefreshing || refreshRequired || publishedLock || visibilityUnknown;
  const isLocked =
    isSubmitting ||
    isRefreshing ||
    retryRequired ||
    refreshRequired ||
    publishedLock ||
    visibilityUnknown;
  const authExpired = access.kind === "reauthentication";
  const reauthenticationParticipantId = authExpired ? access.participant.id : null;
  const hasSavedAnswers =
    Object.keys(savedSelections).length ===
    quizzes.filter(({ question }) => question.answerType === "selected").length;
  const answerer = resolveAnswererDisplay(
    answerMode,
    ownerName,
    assistedParticipant?.participant?.name,
  );
  const canRunRecoveryAction = access.kind === "ready";
  const canSubmit =
    canRunRecoveryAction && (ui.primaryAction === "submit" || ui.primaryAction === "retry-submit");
  function submitAnswers() {
    if (!canSubmit || submissionBlocked) return;
    shouldFocusSubmissionRef.current = true;
    void Promise.resolve(saveAnswers()).finally(() => {
      shouldFocusSubmissionRef.current = false;
    });
  }
  const submitLabel = isSubmitting
    ? "回答を送信しています…"
    : isRefreshing
      ? "保存済み回答を確認しています…"
      : ui.primaryAction === "retry-submit"
        ? "同じ回答を再送する"
        : ui.primaryAction === "reauthenticate"
          ? "再ログイン後に回答を確定する"
          : ui.primaryAction === "refresh-saved-answers"
            ? "保存済み回答を再確認してください"
            : unanswered.length > 0
              ? "未回答の設問に回答してください"
              : hasSavedAnswers
                ? "修正内容を確定する"
                : "5問の回答を確定する";

  return (
    <>
      <HeaderPortal>
        <nav aria-label="設問へ移動">
          <ol className="grid grid-cols-5 gap-2">
            {quizzes.map(({ question }, index) => {
              const answered = hasAnswer(question, selections, freeResponses);
              return (
                <li key={question.id}>
                  <a
                    href={`#question-${question.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      jumpToQuestion(question.id);
                    }}
                    aria-label={`第${index + 1}問へ移動、${answered ? "回答済み" : "未回答"}`}
                    className={`flex min-h-11 flex-col items-center justify-center rounded-md border px-1 text-center text-xs font-semibold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${answered ? "border-primary bg-primary text-on-primary" : "border-border bg-surface-2 text-muted"}`}
                  >
                    <span>第{index + 1}問</span>
                    {answered ? "回答済み" : "未回答"}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
      </HeaderPortal>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-7 sm:py-10">
        <header className="mb-7 border-b border-border pb-6">
          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">しゅんたま検定</h1>
              {access.kind === "ready" && (
                <AnswererNameField
                  answerMode={answerMode}
                  ownerName={access.participant.name}
                  assistedName={assistedParticipant?.participant?.name}
                  className="mt-2"
                />
              )}
            </div>
            <p className="text-base font-bold" aria-live="polite">
              回答済み {answeredCount}/5
            </p>
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
            全5問を縦に確認しながら回答してください。回答は最後にまとめて確定します。
          </p>
          {answerMode === "assisted" && (
            <Button variant="outline" className="mt-4" onClick={() => returnToOwner()}>
              自分の回答に戻る
            </Button>
          )}
        </header>

        {(phase.kind === "answering" || isSubmitting || isRefreshing) &&
          !authExpired &&
          (ui.busy || ui.statusRole === "alert") && (
            <p
              className={`mb-5 rounded-lg border p-4 text-sm font-medium ${ui.statusRole === "alert" ? "border-error/50 bg-error/10 text-error" : "border-border bg-surface-2"}`}
              role={ui.statusRole}
              aria-live={ui.statusRole === "alert" ? "assertive" : "polite"}
              aria-busy={ui.busy || undefined}
            >
              <strong>{ui.status}</strong>
              <span className="mt-1 block leading-relaxed">{ui.message}</span>
            </p>
          )}

        {authExpired && (
          <section
            className="mb-6 rounded-xl border border-border bg-surface-2 p-5 sm:p-6"
            aria-labelledby="reauth-title"
          >
            <h2 id="reauth-title" className="text-lg font-bold">
              {ui.status}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted" role={ui.statusRole}>
              {ui.message}
            </p>
            <ParticipantForm
              key="reauthentication-form"
              onLogin={login}
              onSuccess={(participantId, canHandoffFocus) => {
                const participantMatches = participantId === reauthenticationParticipantId;
                shouldFocusRetrySubmissionAfterReauthentication.current =
                  participantMatches && canHandoffFocus;
                checkedSubmissionAfterReauthentication.current = false;
                if (!participantMatches) return;
                setReauthenticationSuccessCount((count) => count + 1);
              }}
              initialName={access.participant.name}
              submitLabel="再ログインする"
            />
          </section>
        )}

        <div className="space-y-5">
          {quizzes.map(({ question, shuffled }, index) => {
            const selectedIndex = selections[question.id];
            const questionTitleId = `question-title-${question.id}`;
            return (
              <section
                key={question.id}
                id={`question-${question.id}`}
                className="rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-7"
                aria-labelledby={questionTitleId}
              >
                <p className="mb-2 text-sm font-semibold tracking-widest text-primary">
                  第{index + 1}問{" "}
                  <span className="font-medium tracking-normal text-muted">/ 全5問</span>
                </p>
                <h2
                  id={questionTitleId}
                  ref={(node) => {
                    questionRefs.current[question.id] = node;
                  }}
                  tabIndex={-1}
                  className="mb-6 scroll-mt-20 break-words text-xl font-bold leading-relaxed tracking-tight focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-4 sm:text-2xl"
                >
                  {question.question}
                </h2>
                <fieldset
                  disabled={isLocked}
                  className="min-w-0 space-y-3 border-t border-border pt-5"
                >
                  <legend className="sr-only">
                    <span className="sr-only">第{index + 1}問 / 全5問：</span>
                    {question.question}
                  </legend>
                  {question.answerType === "freeText" ? (
                    <div>
                      <label
                        htmlFor={`answer-${question.id}`}
                        className="mb-2 block text-sm font-semibold"
                      >
                        回答（1000字以内）
                      </label>
                      {legacyAnswerIds.includes(question.id) && (
                        <p className="mb-3 text-sm text-muted">
                          以前の保存回答は旧選択式です。自由記載へ変換・再採点せず、以下に新しい回答を入力できます。
                        </p>
                      )}
                      <textarea
                        id={`answer-${question.id}`}
                        name={`answer-${question.id}`}
                        maxLength={1000}
                        rows={6}
                        value={freeResponses[question.id] ?? ""}
                        onChange={(event) =>
                          setFreeResponse(question.id, event.currentTarget.value)
                        }
                        className={`min-h-36 w-full resize-y rounded-lg border border-border bg-bg p-4 text-base text-text shadow-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 ${styles.freeText}`}
                        disabled={isLocked}
                      />
                    </div>
                  ) : (
                    shuffled.choices.map((choice, choiceIndex) => (
                      <ChoiceButton
                        key={choiceIndex}
                        id={`answer-${question.id}-${choiceIndex}`}
                        name={`answer-${question.id}`}
                        value={String(choiceIndex)}
                        label={choiceLabel(choiceIndex)}
                        text={choice}
                        variant={selectedIndex === choiceIndex ? "selected" : "idle"}
                        checked={selectedIndex === choiceIndex}
                        onChange={() => select(question.id, choiceIndex)}
                        disabled={isLocked}
                      />
                    ))
                  )}
                </fieldset>
              </section>
            );
          })}
        </div>

        <section
          className="mt-7 rounded-2xl border-2 border-primary/30 bg-surface p-5 shadow-card sm:p-7"
          aria-labelledby="final-check-title"
        >
          <p className="text-sm font-semibold tracking-widest text-primary">最終確認</p>
          {publishedLock && (
            <p
              className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm leading-relaxed text-text"
              role="status"
              aria-live="polite"
            >
              結果が公開されているため、回答を修正できません。主催者が結果を非公開にすると、再び編集できます。
            </p>
          )}
          {visibilityUnknown && !publishedLock && (
            <p className="mt-3 text-sm text-muted" role="status" aria-live="polite">
              公開状態を確認できません。確認できるまで編集はできません。
            </p>
          )}
          <h2
            id="final-check-title"
            ref={finalCheckHeadingRef}
            tabIndex={-1}
            className="mt-1 text-xl font-bold focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-4"
          >
            回答内容を確認してください
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            保存すると回答完了になります。完了後も「回答を修正する」から同じ5問を見直せます。
          </p>
          <dl className="mt-4 rounded-lg border border-border bg-surface-2 p-4">
            <dt className="text-sm text-muted">回答先</dt>
            <dd className="mt-1 break-words font-semibold">
              {answerer.name}さん（{answerer.kind}）
            </dd>
          </dl>
          <p className="mt-4 font-semibold">
            {unanswered.length === 0 ? "全5問に回答しました。" : `未回答 ${unanswered.length}問`}
          </p>
          {ui.statusRole === "status" && !ui.busy && !authExpired && (
            <p className="mt-1 text-sm leading-relaxed text-muted">{ui.message}</p>
          )}
          {unanswered.length > 0 && (
            <div className="mt-2" role="group" aria-labelledby="unanswered-heading">
              <p id="unanswered-heading" className="text-sm text-muted">
                未回答の設問へ移動できます：
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {unanswered.map(({ question }) => {
                  const questionIndex = quizzes.findIndex(
                    (quiz) => quiz.question.id === question.id,
                  );
                  return (
                    <li key={question.id}>
                      <button
                        type="button"
                        onClick={() => jumpToQuestion(question.id)}
                        className="min-h-11 rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-semibold underline decoration-1 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        第{questionIndex + 1}問へ
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <ol className="mt-5 space-y-3" aria-label="回答内容">
            {quizzes.map(({ question, shuffled }, index) => {
              const selectedIndex = selections[question.id];
              const freeText = freeResponses[question.id] ?? "";
              const answered = hasAnswer(question, selections, freeResponses);
              const selectedChoice =
                question.answerType === "selected" && selectedIndex !== undefined
                  ? {
                      label: choiceLabel(selectedIndex),
                      text: shuffled.choices[selectedIndex],
                    }
                  : undefined;
              const freeTextCharacters = Array.from(freeText);
              const longAnswer =
                question.answerType === "freeText" && freeTextCharacters.length > 180;
              const preview = longAnswer ? freeTextCharacters.slice(0, 180).join("") : freeText;

              return (
                <li
                  key={question.id}
                  className="min-w-0 rounded-lg border border-border bg-surface-2 p-4"
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold tracking-wide text-muted">
                        第{index + 1}問
                      </p>
                      <h3 className="mt-1 break-words font-semibold leading-relaxed">
                        {question.question}
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => jumpToQuestion(question.id, true)}
                      aria-label={`第${index + 1}問「${question.question}」を編集`}
                      className="min-h-11 shrink-0 rounded-md px-3 text-sm font-semibold text-primary underline decoration-1 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      編集する
                    </button>
                  </div>
                  <div className="mt-3 min-w-0 border-t border-border pt-3">
                    <p className="text-sm font-semibold">{answered ? "回答" : "未回答"}</p>
                    {question.answerType === "selected" && selectedChoice !== undefined && (
                      <p className="mt-1 break-words leading-relaxed">
                        {selectedChoice.label} {selectedChoice.text}
                      </p>
                    )}
                    {question.answerType === "freeText" && answered && (
                      <>
                        <p className="mt-1 break-words whitespace-pre-wrap leading-relaxed">
                          {preview}
                          {longAnswer && "…"}
                        </p>
                        {longAnswer && (
                          <details className="mt-2">
                            <summary className="min-h-11 w-fit cursor-pointer rounded-md py-2 text-sm font-semibold text-primary underline decoration-1 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                              全文を表示（{freeTextCharacters.length}文字）
                            </summary>
                            <p className="mt-2 break-words whitespace-pre-wrap leading-relaxed">
                              {freeText}
                            </p>
                          </details>
                        )}
                      </>
                    )}
                    {question.answerType === "freeText" && !answered && (
                      <p className="mt-1 text-sm text-muted">自由記述は未入力です。</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {refreshRequired && (
            <Button
              onClick={() => void refreshSavedAnswers()}
              className="mt-6 min-h-12"
              disabled={!canRunRecoveryAction || isSubmitting || isRefreshing}
              variant={ui.primaryAction === "refresh-saved-answers" ? "primary" : "outline"}
            >
              {canRunRecoveryAction
                ? "保存済み回答を再確認する"
                : "再ログイン後に保存済み回答を再確認する"}
            </Button>
          )}
          <Button
            ref={submitButtonRef}
            onClick={submitAnswers}
            disabled={!canSubmit || submissionBlocked}
            aria-disabled={submissionBlocked || !canSubmit || undefined}
            variant={canSubmit ? "primary" : "outline"}
            className={`mt-6 min-h-12 w-full sm:w-auto ${isSubmitting || isRefreshing ? "cursor-wait opacity-80" : ""}`}
          >
            {(isSubmitting || isRefreshing) && <Spinner className="motion-reduce:animate-none" />}
            {submitLabel}
          </Button>
          {authExpired && (
            <p className="mt-3 text-sm text-muted">
              再ログインすると、回答案を保ったまま送信できます。
            </p>
          )}
        </section>
      </main>
    </>
  );
}

function AnswererNameField({
  answerMode,
  ownerName,
  assistedName,
  className = "",
}: {
  answerMode: AnswerMode;
  ownerName: string;
  assistedName?: string | null;
  className?: string;
}) {
  const answerer = resolveAnswererDisplay(answerMode, ownerName, assistedName);

  return (
    <div
      className={`flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm ${className}`}
    >
      <dl className="flex min-w-0 items-baseline gap-2">
        <dt className="shrink-0 text-muted">氏名</dt>
        <dd className="min-w-0 break-words font-medium">{answerer.name}</dd>
      </dl>
      {answerer.kind !== "本人の回答" && (
        <span className="shrink-0 text-muted">{answerer.kind}</span>
      )}
    </div>
  );
}

function ParticipantCard({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-10">
      {children}
    </section>
  );
}

function ParticipantForm({
  onLogin,
  onSuccess,
  initialName = "",
  message,
  submitLabel = "はじめる",
  nameLabel = "お名前",
  pinLabel = "4桁PIN",
}: {
  onLogin: (name: string, pin: string) => Promise<number>;
  onSuccess?: (participantId: number, canHandoffFocus: boolean) => void;
  initialName?: string;
  message?: string;
  submitLabel?: string;
  nameLabel?: string;
  pinLabel?: string;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [name, setName] = useState(initialName);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedback = error ?? message;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const submittedPin = pin;
    setPin("");
    const form = formRef.current;
    let focusMovedOutsideForm = false;
    const handleFocusIn = (focusEvent: FocusEvent) => {
      const target = focusEvent.target;
      if (target instanceof Node && target !== document.body && !form?.contains(target)) {
        focusMovedOutsideForm = true;
      }
    };
    document.addEventListener("focusin", handleFocusIn);
    try {
      const participantId = await onLogin(name, submittedPin);
      const activeElement = document.activeElement;
      const canHandoffFocus =
        !focusMovedOutsideForm &&
        (activeElement === document.body ||
          !activeElement?.isConnected ||
          Boolean(form?.contains(activeElement)));
      onSuccess?.(participantId, canHandoffFocus);
    } catch (cause) {
      const retryAt = cause instanceof ApiError && cause.retryAt ? new Date(cause.retryAt) : null;
      const retryHint =
        retryAt && !Number.isNaN(retryAt.valueOf())
          ? `（${retryAt.toLocaleString("ja-JP")}以降に再試行できます）`
          : "";
      setError(
        cause instanceof Error
          ? `${cause.message}${retryHint}`
          : "参加できませんでした。入力内容をご確認ください。",
      );
    } finally {
      document.removeEventListener("focusin", handleFocusIn);
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="mt-7 space-y-5">
      <div className="space-y-2">
        <label htmlFor="participant-name" className="block text-sm font-semibold">
          {nameLabel}
        </label>
        <input
          id="participant-name"
          name="name"
          type="text"
          autoComplete="name"
          maxLength={120}
          required
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-describedby={feedback ? "participant-form-message" : undefined}
          className="min-h-12 w-full rounded-lg border border-border bg-bg px-4 text-base text-text shadow-sm outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="participant-pin" className="block text-sm font-semibold">
          {pinLabel}
        </label>
        <input
          id="participant-pin"
          name="pin"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{4}"
          minLength={4}
          maxLength={4}
          autoComplete="off"
          required
          value={pin}
          onChange={(event) => setPin(event.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 4))}
          aria-describedby={`participant-pin-hint${feedback ? " participant-form-message" : ""}`}
          aria-invalid={Boolean(error) || undefined}
          className="min-h-12 w-full rounded-lg border border-border bg-bg px-4 text-base tracking-[0.35em] text-text shadow-sm outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        />
        <p id="participant-pin-hint" className="text-sm text-muted">
          主催者から案内された数字を入力してください。
        </p>
      </div>
      {feedback && (
        <p id="participant-form-message" className="text-sm font-medium text-error" role="alert">
          {feedback}
        </p>
      )}
      <Button type="submit" loading={busy}>
        {busy ? "確認しています…" : submitLabel}
      </Button>
    </form>
  );
}

function AssistedParticipantForm({
  onSubmit,
  message,
  busy,
  variant = "primary",
}: {
  onSubmit: (name: string) => Promise<void>;
  message: string | null;
  busy: boolean;
  variant?: "primary" | "outline";
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    try {
      await onSubmit(name.trim());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "回答を開始できませんでした。入力内容をご確認ください。",
      );
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-7 space-y-5">
      <div>
        <label htmlFor="assisted-name" className="mb-2 block text-sm font-semibold">
          回答する人のお名前
        </label>
        <input
          id="assisted-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          className="min-h-12 w-full rounded-lg border border-border bg-bg px-4 text-base text-text shadow-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          disabled={busy}
        />
      </div>
      {(error ?? message) && (
        <p className="text-sm font-medium text-error" role="alert">
          {error ?? message}
        </p>
      )}
      <Button type="submit" disabled={busy || name.trim().length === 0} variant={variant}>
        {busy ? "回答を準備しています…" : "回答をはじめる"}
      </Button>
    </form>
  );
}
