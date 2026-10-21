import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";
import GlobalHeader from "@/app/GlobalHeader";

const mockUseQuizSession = vi.hoisted(() => vi.fn());
vi.mock("@/app/answer/use-quiz-session", () => ({ useQuizSession: () => mockUseQuizSession() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/answer" }));

const quizzes = Array.from({ length: 5 }, (_, index) => ({
  question: {
    id: index + 1,
    question: `Question ${index + 1}?`,
    choices: ["A", "B", "C", "D"].map((choice) => `${choice}${index + 1}`),
    answerType: "selected" as const,
  },
  shuffled: {
    choices: ["C", "A", "D", "B"].map((choice) => `${choice}${index + 1}`),
    choiceIndices: [2, 0, 3, 1],
  },
}));

const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");

function session(phase: object, overrides: Record<string, unknown> = {}) {
  return {
    access: { kind: "ready", participant: { id: 7, name: "参加者" } },
    answerMode: "owner",
    assistedScreen: "closed",
    assistedParticipant: null,
    assistedError: null,
    assistedBusy: false,
    phase,
    quizzes,
    selections: {},
    freeResponses: {},
    legacyAnswerIds: [],
    savedSelections: {},
    answeredCount: 0,
    restoreError: null,
    select: vi.fn(),
    setFreeResponse: vi.fn(),
    saveAnswers: vi.fn(),
    refreshSavedAnswers: vi.fn(),
    editAnswers: vi.fn(),
    retryLoad: vi.fn(),
    retrySubmissionCheck: vi.fn(),
    login: vi.fn(async () => {}),
    start: vi.fn(),
    switchParticipant: vi.fn(async () => {}),
    ...overrides,
  };
}

function RunnerPage() {
  return (
    <>
      <GlobalHeader />
      <QuizRunner />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("QuizRunner batch answer sheet", () => {
  beforeEach(() => mockUseQuizSession.mockReset());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (visibilityStateDescriptor) {
      Object.defineProperty(document, "visibilityState", visibilityStateDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("moves focus to final confirmation after explicit submit without requiring button focus", async () => {
    const saveRequest = deferred<void>();
    const saveAnswers = vi.fn(() => saveRequest.promise);
    let currentPhase: object = { kind: "answering" };
    mockUseQuizSession.mockImplementation(() =>
      session(currentPhase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
        saveAnswers,
      }),
    );
    const { rerender } = render(<RunnerPage />);
    try {
      const submitButton = screen.getByRole("button", { name: "5問の回答を確定する" });
      expect(document.activeElement).not.toBe(submitButton);
      fireEvent.click(submitButton);
      expect(saveAnswers).toHaveBeenCalledOnce();

      currentPhase = { kind: "submitting" };
      rerender(<RunnerPage />);
      const submittingStatus = screen.getByRole("status");
      expect(submittingStatus).toHaveTextContent("回答を送信しています…");
      expect(submittingStatus).toHaveAttribute("aria-live", "polite");
      expect(screen.getByRole("heading", { name: "回答内容を確認してください" })).toBeVisible();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("heading", { name: "回答内容を確認してください" }),
        ),
      );

      currentPhase = { kind: "complete" };
      rerender(<RunnerPage />);
      const completionHeading = screen.getByRole("heading", { name: "回答済み" });
      await waitFor(() => expect(document.activeElement).toBe(completionHeading));
    } finally {
      saveRequest.resolve();
    }
  });

  it("keeps completion focus after an owner submission check", async () => {
    let currentPhase: object = { kind: "answering" };
    mockUseQuizSession.mockImplementation(() =>
      session(currentPhase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);
    fireEvent.click(screen.getByRole("button", { name: "5問の回答を確定する" }));

    currentPhase = { kind: "submitting" };
    rerender(<RunnerPage />);
    const finalCheckHeading = screen.getByRole("heading", {
      name: "回答内容を確認してください",
    });
    await waitFor(() => expect(document.activeElement).toBe(finalCheckHeading));

    currentPhase = { kind: "checking-submission" };
    rerender(<RunnerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("保存済みの回答状況を確認しています");

    currentPhase = { kind: "complete" };
    rerender(<RunnerPage />);
    const completionHeading = screen.getByRole("heading", { name: "回答済み" });
    await waitFor(() => expect(document.activeElement).toBe(completionHeading));
  });

  it("preserves focus moved elsewhere while the owner submission status is checked", async () => {
    let currentPhase: object = { kind: "answering" };
    mockUseQuizSession.mockImplementation(() =>
      session(currentPhase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);
    fireEvent.click(screen.getByRole("button", { name: "5問の回答を確定する" }));

    currentPhase = { kind: "submitting" };
    rerender(<RunnerPage />);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "回答内容を確認してください" }),
      ),
    );

    currentPhase = { kind: "checking-submission" };
    rerender(<RunnerPage />);
    const externalControl = document.createElement("button");
    externalControl.textContent = "ページ内の別操作";
    document.body.append(externalControl);
    try {
      externalControl.focus();

      currentPhase = { kind: "complete" };
      rerender(<RunnerPage />);
      expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
      expect(document.activeElement).toBe(externalControl);
    } finally {
      externalControl.remove();
    }
  });

  it("does not move focus to completion when the initial phase is already complete", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答済み" }));
  });

  it("does not move focus when submission starts while a question navigation link is focused", () => {
    let currentPhase: object = { kind: "answering" };
    mockUseQuizSession.mockImplementation(() =>
      session(currentPhase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);
    const questionLink = screen.getByRole("link", { name: "第1問へ移動、回答済み" });
    questionLink.focus();
    expect(document.activeElement).toBe(questionLink);

    currentPhase = { kind: "submitting" };
    rerender(<RunnerPage />);
    const finalCheckHeading = screen.getByRole("heading", {
      name: "回答内容を確認してください",
    });
    expect(document.activeElement).not.toBe(finalCheckHeading);

    currentPhase = { kind: "complete" };
    rerender(<RunnerPage />);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答済み" }));
  });

  it("keeps the completion handoff canceled after focus returns to final confirmation", async () => {
    let currentPhase: object = { kind: "answering" };
    mockUseQuizSession.mockImplementation(() =>
      session(currentPhase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);
    fireEvent.click(screen.getByRole("button", { name: "5問の回答を確定する" }));

    currentPhase = { kind: "submitting" };
    rerender(<RunnerPage />);
    const finalCheckHeading = screen.getByRole("heading", {
      name: "回答内容を確認してください",
    });
    await waitFor(() => expect(document.activeElement).toBe(finalCheckHeading));

    const questionLink = screen.getByRole("link", { name: "第1問へ移動、回答済み" });
    questionLink.focus();
    expect(document.activeElement).toBe(questionLink);
    finalCheckHeading.focus();
    expect(document.activeElement).toBe(finalCheckHeading);

    currentPhase = { kind: "complete" };
    rerender(<RunnerPage />);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答済み" }));
  });

  it("preserves the focused element while a pending submission check returns to answering", async () => {
    const checkRequest = deferred<void>();
    let currentPhase: object = {
      kind: "submission-error",
      message: "回答状況を確認できませんでした。",
    };
    let rerenderRunner = () => {};
    const retrySubmissionCheck = vi.fn(() => {
      currentPhase = { kind: "checking-submission" };
      rerenderRunner();
      return checkRequest.promise.then(() => {
        currentPhase = { kind: "answering" };
        rerenderRunner();
      });
    });
    mockUseQuizSession.mockImplementation(() => session(currentPhase, { retrySubmissionCheck }));
    const { rerender } = render(<RunnerPage />);
    rerenderRunner = () => rerender(<RunnerPage />);
    const externalControl = document.createElement("button");
    externalControl.textContent = "ページ内の別操作";
    document.body.append(externalControl);
    try {
      externalControl.focus();
      fireEvent.click(screen.getByRole("button", { name: "もう一度確認する" }));
      expect(retrySubmissionCheck).toHaveBeenCalledOnce();

      expect(screen.getByRole("status")).toHaveTextContent("保存済みの回答状況を確認しています");
      expect(document.activeElement).toBe(externalControl);

      await act(async () => {
        checkRequest.resolve();
        await checkRequest.promise;
        await retrySubmissionCheck.mock.results[0].value;
      });
      expect(screen.getByRole("navigation", { name: "設問へ移動" })).toBeInTheDocument();
      expect(document.activeElement).toBe(externalControl);
    } finally {
      checkRequest.resolve();
      externalControl.remove();
    }
  });

  it("does not reuse a failed submission focus handoff on an unfocused retry", async () => {
    let currentPhase: object = { kind: "answering" };
    mockUseQuizSession.mockImplementation(() =>
      session(currentPhase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.click(screen.getByRole("button", { name: "5問の回答を確定する" }));
    currentPhase = { kind: "submitting" };
    rerender(<RunnerPage />);
    const finalCheckHeading = screen.getByRole("heading", {
      name: "回答内容を確認してください",
    });
    await waitFor(() => expect(document.activeElement).toBe(finalCheckHeading));

    currentPhase = { kind: "answering" };
    rerender(<RunnerPage />);
    const questionLink = screen.getByRole("link", { name: "第1問へ移動、回答済み" });
    questionLink.focus();
    expect(document.activeElement).toBe(questionLink);

    currentPhase = { kind: "submitting" };
    rerender(<RunnerPage />);
    const retryFinalCheckHeading = screen.getByRole("heading", {
      name: "回答内容を確認してください",
    });
    expect(document.activeElement).not.toBe(retryFinalCheckHeading);

    currentPhase = { kind: "complete" };
    rerender(<RunnerPage />);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答済み" }));
  });

  it("moves focus to a question from the progress and unanswered links", () => {
    const select = vi.fn();
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { selections: { 1: 3 }, answeredCount: 1, select, saveAnswers },
      ),
    );
    render(<RunnerPage />);
    const heading = document.querySelector<HTMLHeadingElement>("#question-2 h2");
    expect(heading).not.toBeNull();
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    heading!.scrollIntoView = scrollIntoView;
    heading!.focus = focus;

    fireEvent.click(screen.getByRole("link", { name: "第2問へ移動、未回答" }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    scrollIntoView.mockClear();
    focus.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "第2問へ" }));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(saveAnswers).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /B1/ })).toBeChecked();
  });
});
