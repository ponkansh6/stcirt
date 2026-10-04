"use client";

import { useEffect, useRef } from "react";
import { useQuizSession } from "./use-quiz-session";
import ChoiceButton from "@/components/ChoiceButton";
import { choiceLabel } from "@/lib/choice-label";
import { Button } from "@/components/Button";
import { NavLink } from "@/components/NavLink";

export default function QuizRunner() {
  const {
    phase,
    quiz,
    questionIndex,
    recordedCount,
    select,
    confirm,
    retry,
    resendAnswer,
    restart,
  } = useQuizSession();
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (phase.kind === "question" && recordedCount > 0) {
      questionHeadingRef.current?.focus();
    }
  }, [phase.kind, questionIndex, recordedCount]);

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
        <section className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-10">
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">問題が足りません</h1>
          <p className="mt-4 text-muted">
            全5問をそろえられないため、検定を開始できません。問題が5問そろったら、もう一度お試しください。
          </p>
          <NavLink href="/" variant="outline" className="mt-8">
            ホームへ戻る
          </NavLink>
        </section>
      </main>
    );
  }

  if (phase.kind === "error") {
    const isAnswerError = phase.selectedIndex !== undefined;
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <section className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-10">
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">
            {isAnswerError ? "回答を記録できませんでした" : "問題を読み込めませんでした"}
          </h1>
          <p className="mt-4 text-muted" role="alert" aria-live="assertive">
            {isAnswerError && phase.unavailable
              ? "この問題は現在回答を記録できません。選択した回答を保持しています。問題を差し替えず、この画面からホームへ戻れます。"
              : phase.message}
          </p>
          {isAnswerError ? (
            <>
              {quiz && (
                <div className="mt-6 space-y-3" aria-label="送信した回答">
                  <p className="font-semibold">{quiz.question.question}</p>
                  {quiz.shuffled.choices.map((choice, index) => (
                    <ChoiceButton
                      key={index}
                      label={choiceLabel(index)}
                      text={choice}
                      variant={index === phase.selectedIndex ? "selected" : "idle"}
                      disabled
                      aria-pressed={index === phase.selectedIndex}
                    />
                  ))}
                </div>
              )}
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button onClick={resendAnswer}>回答を再送する</Button>
                <NavLink href="/" variant="ghost">
                  ホームへ戻る
                </NavLink>
              </div>
            </>
          ) : (
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button onClick={retry}>不足分を再読み込み</Button>
              <NavLink href="/" variant="ghost">
                ホームへ戻る
              </NavLink>
            </div>
          )}
        </section>
      </main>
    );
  }

  if (phase.kind === "complete") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
        <section className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-10">
          <p className="mb-3 text-sm font-semibold tracking-widest text-primary">5問検定</p>
          <h1 className="text-3xl font-bold tracking-tight">回答完了</h1>
          <p className="mt-4 text-muted">全5問の回答を記録しました。</p>
          <Button onClick={restart} className="mt-8">
            もう一度受検する
          </Button>
        </section>
      </main>
    );
  }

  if (!quiz) return null;
  const selectedIndex = phase.kind === "question" ? phase.selectedIndex : undefined;
  const isSubmitting = phase.kind === "submitting";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-8 sm:py-12">
      <header className="mb-8 border-b border-border pb-5">
        <p className="text-sm font-semibold tracking-widest text-primary">5問検定</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
          <h1 className="text-3xl font-bold tracking-tight">
            第{questionIndex + 1}問 <span className="text-lg font-medium text-muted">/ 全5問</span>
          </h1>
          <p className="text-sm font-semibold text-muted" aria-live="polite">
            回答記録済み {recordedCount}/5
          </p>
        </div>
        <ol className="mt-5 grid grid-cols-5 gap-2" aria-label="各問題の回答状態">
          {Array.from({ length: 5 }, (_, index) => {
            const answered = index < recordedCount;
            const current = index === questionIndex;
            const status = answered ? "回答済み" : current ? "現在" : "未到達";
            return (
              <li
                key={index}
                className={`flex min-h-10 items-center justify-center rounded-md border px-1 text-xs font-semibold sm:text-sm ${answered ? "border-primary bg-primary text-on-primary" : current ? "border-primary bg-surface text-primary ring-2 ring-primary/30" : "border-border bg-surface-2 text-muted"}`}
                aria-current={current ? "step" : undefined}
              >
                <span className="sr-only">第{index + 1}問、</span>
                <span className="hidden sm:inline">{index + 1}問・</span>
                {status}
              </li>
            );
          })}
        </ol>
      </header>

      <section className="flex-1" aria-labelledby="question-title">
        <p className="mb-2 text-sm font-semibold tracking-widest text-primary">設問</p>
        <h2
          ref={questionHeadingRef}
          id="question-title"
          tabIndex={-1}
          className="mb-7 text-xl font-bold leading-relaxed tracking-tight sm:text-2xl"
        >
          {quiz.question.question}
        </h2>
        <fieldset disabled={isSubmitting} className="space-y-3">
          <legend className="sr-only">回答を1つ選択してください</legend>
          {quiz.shuffled.choices.map((choice, index) => (
            <ChoiceButton
              key={index}
              label={choiceLabel(index)}
              text={choice}
              variant={selectedIndex === index ? "selected" : "idle"}
              onClick={() => select(index)}
              disabled={isSubmitting}
              aria-pressed={selectedIndex === index}
            />
          ))}
        </fieldset>
        <p className="mt-4 text-sm text-muted">選択内容を確認してから回答を確定してください。</p>
        {isSubmitting && (
          <p className="mt-3 text-sm font-medium" role="status" aria-live="polite">
            回答を記録しています…
          </p>
        )}
        <Button
          onClick={() => void confirm()}
          disabled={selectedIndex === undefined || isSubmitting}
          loading={isSubmitting}
          className="mt-7"
        >
          {isSubmitting ? "回答を記録しています…" : "回答を確定する"}
        </Button>
      </section>
    </main>
  );
}
