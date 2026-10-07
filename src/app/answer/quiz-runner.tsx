"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useQuizSession } from "./use-quiz-session";
import ChoiceButton from "@/components/ChoiceButton";
import { choiceLabel } from "@/lib/choice-label";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/Spinner";
import { ApiError } from "@/lib/api/client";
import { HeaderPortal } from "./header-portal";

export default function QuizRunner() {
  const {
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
    refreshSavedAnswers,
    editAnswers,
    retryLoad,
    retrySubmissionCheck,
    login,
  } = useQuizSession();
  const questionRefs = useRef<Record<number, HTMLHeadingElement | null>>({});
  const [participantResultsVisible, setParticipantResultsVisible] = useState(false);
  useEffect(() => {
    if (phase.kind !== "complete" || access.kind !== "ready") {
      setParticipantResultsVisible(false);
      return;
    }
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/participants/results", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!active) return;
        if (!response.ok) {
          setParticipantResultsVisible(false);
          return;
        }
        const result = (await response.json()) as { state?: unknown };
        if (active) setParticipantResultsVisible(result.state === "visible");
      } catch {
        if (active) setParticipantResultsVisible(false);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [access.kind, phase.kind]);
  const isSubmitting = phase.kind === "submitting";
  const isRefreshing = phase.kind === "refreshing";
  const unanswered = quizzes.filter(({ question }) =>
    question.answerType === "freeText"
      ? !freeResponses[question.id]?.trim()
      : selections[question.id] === undefined,
  );

  function jumpToQuestion(questionId: number) {
    questionRefs.current[questionId]?.scrollIntoView({ behavior: "auto", block: "start" });
    questionRefs.current[questionId]?.focus({ preventScroll: true });
  }

  if (access.kind === "checking") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          参加状態を確認しています…
        </p>
      </main>
    );
  }

  if (access.kind === "login") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">参加して検定を受ける</h1>
          <p className="mt-4 max-w-xl leading-relaxed text-muted">
            回答を記録するため、お名前と主催者から案内された4桁PINを入力してください。
          </p>
          <ParticipantForm onLogin={login} message={access.message} />
        </ParticipantCard>
      </main>
    );
  }

  if (access.kind === "switching") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          参加状態を切り替えています…
        </p>
      </main>
    );
  }

  if (phase.kind === "checking-submission" || (phase.kind === "ready" && access.kind === "ready")) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          保存済みの回答状況を確認しています…
        </p>
      </main>
    );
  }

  if (phase.kind === "submission-error") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">回答状況を確認できませんでした</h1>
          <p className="mt-4 text-muted" role="alert">
            {phase.message}
          </p>
          <Button onClick={retrySubmissionCheck} className="mt-8">
            もう一度確認する
          </Button>
        </ParticipantCard>
      </main>
    );
  }

  if (phase.kind === "loading") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-12">
        <p className="w-full text-center text-muted" role="status" aria-live="polite">
          全5問を準備しています…
        </p>
      </main>
    );
  }

  if (phase.kind === "shortage") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">問題が足りません</h1>
          <p className="mt-4 text-muted">
            全5問をそろえられないため、検定を開始できません。問題が5問そろったら、もう一度お試しください。
          </p>
        </ParticipantCard>
      </main>
    );
  }

  if (phase.kind === "load-error") {
    const hasLoadedQuestions = quizzes.length > 0;
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">問題を読み込めませんでした</h1>
          <p className="mt-4 text-muted" role="alert">
            {phase.message}
          </p>
          {hasLoadedQuestions && (
            <p className="mt-3 text-sm leading-relaxed text-muted" role="status" aria-live="polite">
              取得済みの{quizzes.length}問は保持しています。不足分から再開できます。
            </p>
          )}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button onClick={retryLoad}>
              {hasLoadedQuestions ? "不足分を再読み込み" : "もう一度読み込む"}
            </Button>
          </div>
        </ParticipantCard>
      </main>
    );
  }

  if (phase.kind === "complete") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <ParticipantCard>
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">回答完了</h1>
          <p className="mt-4 text-muted">全5問の回答を記録しました。</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            回答を見直す場合は、同じ5問の回答を復元して修正できます。
          </p>
          {restoreError && (
            <p className="mt-4 text-sm font-medium text-error" role="alert">
              {restoreError}
            </p>
          )}
          <Button onClick={editAnswers} className="mt-8" disabled={Boolean(restoreError)}>
            回答を修正する
          </Button>
          {participantResultsVisible && (
            <Link
              href="/results"
              className="mt-3 inline-flex min-h-11 items-center justify-center rounded-md border border-primary px-5 font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              自分の結果を見る
            </Link>
          )}
        </ParticipantCard>
      </main>
    );
  }

  const retryRequired = phase.kind === "answering" && phase.retryRequired;
  const refreshRequired = phase.kind === "answering" && phase.refreshRequired;
  const isLocked = isSubmitting || isRefreshing || retryRequired || refreshRequired;
  const authExpired = access.kind === "reauthentication";
  const hasSavedAnswers =
    Object.keys(savedSelections).length ===
    quizzes.filter(({ question }) => question.answerType === "selected").length;

  return (
    <>
      <HeaderPortal>
        <nav aria-label="設問へ移動">
          <ol className="grid grid-cols-5 gap-2">
            {quizzes.map(({ question }, index) => {
              const answered =
                question.answerType === "freeText"
                  ? Boolean(freeResponses[question.id]?.trim())
                  : selections[question.id] !== undefined;
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
          <p className="text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">受検票</h1>
              {access.kind === "ready" && (
                <p className="mt-1 text-sm text-muted">受検者：{access.participant.name}</p>
              )}
            </div>
            <p className="text-base font-bold" aria-live="polite">
              回答済み {answeredCount}/5
            </p>
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
            全5問を縦に確認しながら回答してください。回答は最後にまとめて確定します。
          </p>
        </header>

        {phase.kind === "answering" && phase.message && (
          <p
            className="mb-5 rounded-lg border border-error/50 bg-error/10 p-4 text-sm font-medium text-error"
            role="alert"
            aria-live="assertive"
          >
            {phase.message}{" "}
            {phase.refreshRequired
              ? "回答案は保持しています。保存済み回答を再確認してから、確定してください。"
              : phase.retryRequired
                ? "回答案は保持しています。同じ内容を再送してください。"
                : "回答案は保持しています。内容を確認して、もう一度確定してください。"}
          </p>
        )}

        {authExpired && (
          <section
            className="mb-6 rounded-xl border border-border bg-surface-2 p-5 sm:p-6"
            aria-labelledby="reauth-title"
          >
            <h2 id="reauth-title" className="text-lg font-bold">
              参加状態の確認が必要です
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              再ログイン後、回答は自動送信されません。回答案を確認してから、明示的に再確定してください。
            </p>
            <ParticipantForm
              key="reauthentication-form"
              onLogin={login}
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
                        className="min-h-36 w-full resize-y rounded-lg border border-border bg-bg p-4 text-base text-text shadow-sm outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
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
          <h2 id="final-check-title" className="mt-1 text-xl font-bold">
            回答内容を確認してください
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            保存すると回答完了になります。完了後も「回答を修正する」から同じ5問を見直せます。
          </p>
          <p className="mt-4 font-semibold" aria-live="polite">
            {unanswered.length === 0 ? "全5問に回答しました。" : `未回答 ${unanswered.length}問`}
          </p>
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
          {isSubmitting && (
            <p className="mt-4 text-sm font-medium" role="status" aria-live="polite">
              回答を送信しています…
            </p>
          )}
          {isRefreshing && (
            <p className="mt-4 text-sm font-medium" role="status" aria-live="polite">
              保存済み回答を確認しています…
            </p>
          )}
          {refreshRequired && (
            <Button
              onClick={() => void refreshSavedAnswers()}
              className="mt-6 min-h-12"
              disabled={isSubmitting || isRefreshing}
            >
              保存済み回答を再確認する
            </Button>
          )}
          <Button
            onClick={() => void saveAnswers()}
            disabled={unanswered.length > 0 || isRefreshing || authExpired || refreshRequired}
            aria-disabled={
              isSubmitting ||
              isRefreshing ||
              unanswered.length > 0 ||
              authExpired ||
              refreshRequired ||
              undefined
            }
            className={`mt-6 min-h-12 w-full sm:w-auto ${isSubmitting || isRefreshing ? "cursor-wait opacity-80" : ""}`}
          >
            {(isSubmitting || isRefreshing) && <Spinner className="motion-reduce:animate-none" />}
            {isSubmitting
              ? "回答を送信しています…"
              : isRefreshing
                ? "保存済み回答を確認しています…"
                : retryRequired
                  ? "同じ回答を再送する"
                  : hasSavedAnswers
                    ? "修正内容を確定する"
                    : "5問の回答を確定する"}
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

function ParticipantCard({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-10">
      {children}
    </section>
  );
}

function ParticipantForm({
  onLogin,
  initialName = "",
  message,
  submitLabel = "はじめる",
}: {
  onLogin: (name: string, pin: string) => Promise<void>;
  initialName?: string;
  message?: string;
  submitLabel?: string;
}) {
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
    try {
      await onLogin(name, submittedPin);
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
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-7 space-y-5">
      <div className="space-y-2">
        <label htmlFor="participant-name" className="block text-sm font-semibold">
          お名前
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
          4桁PIN
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
