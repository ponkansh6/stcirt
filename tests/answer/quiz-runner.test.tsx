import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";
import GlobalHeader from "@/app/GlobalHeader";
import { ApiError } from "@/lib/api/client";

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

const visibleResultsPayload = {
  state: "visible",
  rank: 1,
  score: 1,
  questions: [{ position: 0, question: "設問", answer: { kind: "unanswered" } }],
};

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
  afterEach(() => vi.unstubAllGlobals());

  it("renders five native radio groups, progress navigation, and a disabled final confirmation while unanswered", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "answering" }));
    render(<RunnerPage />);
    expect(screen.getByRole("heading", { name: "受検票" })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /Question [1-5]\?/ })).toHaveLength(5);
    expect(screen.getByRole("heading", { name: "Question 1?" })).toBeVisible();
    expect(document.querySelector("#question-1 legend")).toHaveClass("sr-only");
    expect(screen.getByRole("group", { name: /Question 1\?/ })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(20);
    const navigation = screen.getByRole("navigation", { name: "設問へ移動" });
    expect(navigation.closest("header")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();
    expect(within(navigation).getByRole("list").querySelectorAll("li")).toHaveLength(5);
    expect(screen.queryByText(/まだ回答していません|回答を選択しています/)).not.toBeInTheDocument();
    expect(
      document.querySelectorAll('fieldset[aria-describedby^="choice-instruction-"]'),
    ).toHaveLength(0);
    expect(screen.getAllByRole("group", { name: /Question [1-5]\?/ })).toHaveLength(5);
    expect(screen.getByText("未回答 5問")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "5問の回答を確定する" })).toBeDisabled();
  });

  it("renders the fifth-question free-response field, max length, and legacy guidance", () => {
    const setFreeResponse = vi.fn();
    const freeResponseQuizzes = quizzes.map((quiz, index) =>
      index === 4
        ? { ...quiz, question: { ...quiz.question, answerType: "freeText" as const, choices: [] } }
        : quiz,
    );
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          quizzes: freeResponseQuizzes,
          freeResponses: { 5: "draft" },
          legacyAnswerIds: [5],
          setFreeResponse,
        },
      ),
    );
    render(<RunnerPage />);

    const response = screen.getByRole("textbox", { name: "回答（1000字以内）" });
    expect(response).toHaveAttribute("maxLength", "1000");
    expect(response).toHaveValue("draft");
    expect(screen.getByText(/以前の保存回答は旧選択式です/)).toBeVisible();
    fireEvent.change(response, { target: { value: "新しい自由記載" } });
    expect(setFreeResponse).toHaveBeenCalledWith(5, "新しい自由記載");
  });

  it("shows loading and switching states without a home link", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "loading" }));
    const { rerender } = render(<RunnerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("全5問を準備しています");
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "ready" },
        { access: { kind: "switching", participant: { id: 7, name: "参加者" } } },
      ),
    );
    rerender(<RunnerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("参加状態を切り替えています");
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();
  });

  it("checks participant access without home navigation", () => {
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { access: { kind: "checking" } }),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("参加状態を確認しています");
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "設問へ移動" })).not.toBeInTheDocument();
  });

  it("shows shortage and load-error screens with and without retained questions", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "shortage" }, { quizzes: [] }));
    const { rerender } = render(<RunnerPage />);
    expect(screen.getByRole("heading", { name: "問題が足りません" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();

    const retryLoad = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "load-error", message: "load failed" }, { quizzes: [], retryLoad }),
    );
    rerender(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("load failed");
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "もう一度読み込む" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));
    expect(retryLoad).toHaveBeenCalledOnce();

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "load-error", message: "partial load failed" },
        { quizzes: quizzes.slice(0, 2), retryLoad },
      ),
    );
    rerender(<RunnerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("取得済みの2問は保持しています");
    expect(screen.getByRole("button", { name: "不足分を再読み込み" })).toBeInTheDocument();
  });

  it("records local choice changes and submits one batch only after all five have a choice", () => {
    const select = vi.fn();
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          selections: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 0 },
          answeredCount: 5,
          select,
          saveAnswers,
        },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByText("回答済み 5/5")).toBeInTheDocument();
    expect(screen.getByText("全5問に回答しました。")).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toBeChecked();
    fireEvent.click(radios[4]!);
    expect(select).toHaveBeenCalledWith(2, 0);
    fireEvent.click(screen.getByRole("button", { name: "5問の回答を確定する" }));
    expect(saveAnswers).toHaveBeenCalledOnce();
    expect(screen.queryByText(/正解！|不正解|解説:/)).not.toBeInTheDocument();
  });

  it("locks every choice while the atomic batch is submitting", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "submitting" },
        { selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, answeredCount: 5 },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("回答を送信しています");
    expect(screen.getAllByRole("radio").every((radio) => radio.hasAttribute("disabled"))).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "回答を送信しています…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("moves keyboard focus to final confirmation while submitting and then to completion", async () => {
    let currentPhase: object = { kind: "answering" };
    mockUseQuizSession.mockImplementation(() =>
      session(currentPhase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);
    const submitButton = screen.getByRole("button", { name: "5問の回答を確定する" });

    submitButton.focus();
    expect(document.activeElement).toBe(submitButton);

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
    const completionHeading = screen.getByRole("heading", { name: "回答完了" });
    await waitFor(() => expect(document.activeElement).toBe(completionHeading));
  });

  it("does not move focus to completion when the initial phase is already complete", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答完了" }));
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
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答完了" }));
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
    screen.getByRole("button", { name: "5問の回答を確定する" }).focus();

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
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答完了" }));
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

    screen.getByRole("button", { name: "5問の回答を確定する" }).focus();
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
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "回答完了" }));
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

  it("shows a retryable save error, locks the draft, and calls batch save explicitly", () => {
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", message: "temporary save failure", retryRequired: true },
        { selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, answeredCount: 5, saveAnswers },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "回答案は保持しています。同じ内容を再送してください。",
    );
    expect(screen.getAllByRole("radio").every((radio) => radio.hasAttribute("disabled"))).toBe(
      true,
    );
    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(retry).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(retry);
    expect(saveAnswers).toHaveBeenCalledOnce();
  });

  it("shows a recoverable save error without locking selections", () => {
    const select = vi.fn();
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", message: "save failed" },
        {
          selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          answeredCount: 5,
          select,
          saveAnswers,
        },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "回答案は保持しています。内容を確認して、もう一度確定してください。",
    );
    expect(screen.getAllByRole("radio").every((radio) => !radio.hasAttribute("disabled"))).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "5問の回答を確定する" }));
    expect(saveAnswers).toHaveBeenCalledOnce();
  });

  it("shows the refresh progress state and disables batch save while reading persisted answers", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "refreshing" },
        { selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, answeredCount: 5 },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("保存済み回答を確認しています");
    expect(screen.getByRole("button", { name: "保存済み回答を確認しています…" })).toBeDisabled();
  });

  it("keeps the answer draft through reauthentication and requires an explicit save afterward", async () => {
    const login = vi.fn(async () => {});
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", retryRequired: true },
        {
          access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } },
          selections: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 },
          answeredCount: 5,
          login,
          saveAnswers,
        },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeInTheDocument();
    expect(screen.getByLabelText("お名前")).toHaveValue("参加者");
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    expect(screen.getByRole("button", { name: "同じ回答を再送する" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("参加者", "0123"));
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    expect(saveAnswers).not.toHaveBeenCalled();
  });

  it("moves focus to the explicit retry action after successful reauthentication", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      phase = { kind: "checking-submission" };
      rerender(<RunnerPage />);
    });

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(retry);
  });

  it("cancels the retry focus handoff when focus leaves the reauthentication form", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    const questionLink = screen.getByRole("link", { name: "第2問へ移動、回答済み" });
    questionLink.focus();
    expect(document.activeElement).toBe(questionLink);

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      phase = { kind: "checking-submission" };
      rerender(<RunnerPage />);
    });

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(retry);
  });

  it("cancels the retry focus handoff if focus moves after reauthentication succeeds", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      phase = { kind: "checking-submission" };
      rerender(<RunnerPage />);
    });

    const outsideTarget = document.getElementById("global-header-navigation");
    expect(outsideTarget).not.toBeNull();
    outsideTarget!.tabIndex = -1;
    outsideTarget!.focus();
    expect(document.activeElement).toBe(outsideTarget);

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(outsideTarget);
    expect(document.activeElement).not.toBe(retry);
  });

  it("does not focus the retry action when reauthentication switches participants", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    let selections: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let answeredCount = 5;
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections,
        answeredCount,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      resolveLogin(8);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 8, name: "別の参加者" } };
      phase = { kind: "ready" };
      selections = {};
      answeredCount = 0;
      rerender(<RunnerPage />);
    });

    expect(screen.getByRole("status")).toHaveTextContent("保存済みの回答状況を確認しています");
    expect(screen.queryByRole("button", { name: "同じ回答を再送する" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus to the retry action after failed reauthentication", async () => {
    const login = vi.fn().mockRejectedValue(new Error("login failed"));
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", retryRequired: true },
        {
          access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } },
          login,
        },
      ),
    );
    render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeDisabled();
    expect(document.activeElement).not.toBe(retry);
  });

  it("uses the saved-answer correction label when all five persisted answers are present", () => {
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          selections: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 0 },
          savedSelections: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 0 },
          answeredCount: 5,
          saveAnswers,
        },
      ),
    );
    render(<RunnerPage />);
    fireEvent.click(screen.getByRole("button", { name: "修正内容を確定する" }));
    expect(saveAnswers).toHaveBeenCalledOnce();
  });

  it("shows owner completion actions without a publication status control", () => {
    const editAnswers = vi.fn();
    const openAssistedLogin = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { editAnswers, openAssistedLogin }),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("heading", { name: "回答完了" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代理回答を行う" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /公開状況/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "設問へ移動" })).not.toBeInTheDocument();
    expect(
      screen.getByText("回答を見直す場合は、同じ5問の回答を復元して修正できます。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/正解|不正解|合格|得点|正答率/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答を修正する" }));
    expect(editAnswers).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "代理回答を行う" }));
    expect(openAssistedLogin).toHaveBeenCalledOnce();
  });

  it("provides a name-only assisted sign-in screen and returns to the owner's answers", () => {
    const startAssisted = vi.fn();
    const returnToOwner = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { assistedScreen: "login", startAssisted, returnToOwner }),
    );
    render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "ほかの人の回答" })).toBeInTheDocument();
    expect(screen.getByLabelText("回答する人のお名前")).toBeInTheDocument();
    expect(screen.queryByLabelText("4桁PIN")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("回答する人のお名前"), {
      target: { value: "代理回答者" },
    });
    fireEvent.click(screen.getByRole("button", { name: "回答をはじめる" }));
    expect(startAssisted).toHaveBeenCalledWith("代理回答者");
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    expect(returnToOwner).toHaveBeenCalledOnce();
  });

  it("offers correction of the saved assisted answer and a path back to the owner", () => {
    const editAnswers = vi.fn();
    const returnToOwner = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          answerMode: "assisted",
          assistedParticipant: {
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: true,
            eligible: false,
          },
          editAnswers,
          returnToOwner,
        },
      ),
    );
    render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "回答完了" })).toBeInTheDocument();
    expect(screen.getByText("全5問の回答を記録しました。")).toBeInTheDocument();
    expect(screen.getByText("回答者：代理回答者（代理回答）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答を修正する" }));
    expect(editAnswers).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    expect(returnToOwner).toHaveBeenCalledOnce();
  });

  it("keeps the assistant action beside published results without a manual status button", async () => {
    const editAnswers = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => visibleResultsPayload }),
    );
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }, { editAnswers }));

    render(<RunnerPage />);

    const resultLink = await screen.findByRole("link", { name: "自分の結果を見る" });
    expect(resultLink).toHaveAttribute("href", "/results");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /公開状況/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代理回答を行う" })).toBeInTheDocument();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeInTheDocument();
    expect(resultLink).toBeInTheDocument();
  });

  it("queues one tab-return refresh and ignores the stale in-flight completion response", async () => {
    const firstResponse = deferred<{ ok: boolean; json: () => Promise<{ state: string }> }>();
    const secondResponse = deferred<{ ok: boolean; json: () => Promise<{ state: string }> }>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));

    render(<RunnerPage />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstResponse.resolve({ ok: true, json: async () => visibleResultsPayload });
      await firstResponse.promise;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();

    await act(async () => {
      secondResponse.resolve({ ok: true, json: async () => ({ state: "waiting" }) });
      await secondResponse.promise;
    });
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
  });

  it("keeps correction disabled when saved answers could not be restored", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          restoreError: "保存済み回答と現在の設問が一致しないため、回答を復元できません。",
        },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("回答を復元できません");
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeDisabled();
  });

  it("preserves the draft and provides explicit controls after save conflict or saved-answer refresh failure", () => {
    const refreshSavedAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", message: "状態を再確認してください。", refreshRequired: true },
        { selections: { 1: 1 }, answeredCount: 1, refreshSavedAnswers },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("回答案は保持しています");
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "保存済み回答を再確認する" }));
    expect(refreshSavedAnswers).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "5問の回答を確定する" })).toBeDisabled();
  });

  it("normalizes PIN input, clears it during login, and prevents duplicate submissions while busy", async () => {
    let resolveLogin!: () => void;
    const pendingLogin = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login }),
    );
    render(<RunnerPage />);
    const name = screen.getByLabelText("お名前");
    const pin = screen.getByLabelText("4桁PIN");
    fireEvent.change(name, { target: { value: "田中" } });
    fireEvent.change(pin, { target: { value: "0a12345" } });
    expect(pin).toHaveValue("0123");
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith("田中", "0123");
    expect(name).toHaveValue("田中");
    expect(pin).toHaveValue("");
    const busyButton = screen.getByRole("button", { name: "確認しています…" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    fireEvent.submit(pin.closest("form")!);
    expect(login).toHaveBeenCalledOnce();

    await act(async () => {
      resolveLogin();
      await pendingLogin;
    });
    expect(screen.getByRole("button", { name: "はじめる" })).toBeEnabled();
  });

  it("shows an ApiError retry time and marks the failed PIN invalid", async () => {
    const retryAt = "2030-06-01T12:30:00.000Z";
    const login = vi.fn().mockRejectedValue(
      new ApiError({
        status: 429,
        message: "PIN試行回数が上限です。",
        code: "RATE_LIMITED",
        retryAt,
      }),
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login }),
    );
    render(<RunnerPage />);
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "田中" } });
    const pin = screen.getByLabelText("4桁PIN");
    fireEvent.change(pin, { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("PIN試行回数が上限です。");
    expect(alert).toHaveTextContent(new Date(retryAt).toLocaleString("ja-JP"));
    expect(pin).toHaveAttribute("aria-invalid", "true");
    expect(pin).toHaveValue("");
  });

  it("shows an authentication lookup message before any local form error", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "ready" },
        { access: { kind: "login", message: "参加状態を確認できませんでした。" } },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("参加状態を確認できませんでした。");
    expect(screen.getByLabelText("お名前")).toHaveAttribute(
      "aria-describedby",
      "participant-form-message",
    );
    expect(screen.getByLabelText("4桁PIN")).toHaveAttribute(
      "aria-describedby",
      "participant-pin-hint participant-form-message",
    );
  });

  it("shows API errors without retry times and falls back for non-Error login failures", async () => {
    const login = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({
          status: 401,
          message: "PINが正しくありません。",
          code: null,
          retryAt: null,
        }),
      )
      .mockRejectedValueOnce(
        new ApiError({
          status: 429,
          message: "再試行時間を確認できません。",
          code: "RATE_LIMITED",
          retryAt: "not-a-date",
        }),
      )
      .mockRejectedValueOnce("unknown failure");
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login }),
    );
    render(<RunnerPage />);
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "田中" } });
    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PINが正しくありません。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("以降に再試行できます");

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("再試行時間を確認できません。"),
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("以降に再試行できます");

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "参加できませんでした。入力内容をご確認ください。",
      ),
    );
    expect(screen.getByLabelText("お名前")).toHaveValue("田中");
    expect(screen.getByLabelText("4桁PIN")).toHaveValue("");
  });
});
