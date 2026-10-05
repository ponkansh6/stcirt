import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";
import { ApiError } from "@/lib/api/client";

const mockUseQuizSession = vi.hoisted(() => vi.fn());
vi.mock("@/app/answer/use-quiz-session", () => ({ useQuizSession: () => mockUseQuizSession() }));

const quizzes = Array.from({ length: 5 }, (_, index) => ({
  question: {
    id: index + 1,
    question: `Question ${index + 1}?`,
    choices: ["A", "B", "C", "D"].map((choice) => `${choice}${index + 1}`),
  },
  shuffled: {
    choices: ["C", "A", "D", "B"].map((choice) => `${choice}${index + 1}`),
    choiceIndices: [2, 0, 3, 1],
  },
}));

function session(phase: object, overrides: Record<string, unknown> = {}) {
  return {
    access: { kind: "ready", participant: { id: 7, name: "参加者" } },
    phase,
    quizzes,
    selections: {},
    savedSelections: {},
    answeredCount: 0,
    select: vi.fn(),
    saveAnswers: vi.fn(),
    refreshSavedAnswers: vi.fn(),
    editAnswers: vi.fn(),
    retryLoad: vi.fn(),
    login: vi.fn(async () => {}),
    start: vi.fn(),
    switchParticipant: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("QuizRunner batch answer sheet", () => {
  beforeEach(() => mockUseQuizSession.mockReset());

  it("renders five native radio groups, progress navigation, and a disabled final confirmation while unanswered", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "answering" }));
    render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "受検票" })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /Question [1-5]\?/ })).toHaveLength(5);
    expect(screen.getAllByRole("radio")).toHaveLength(20);
    const navigation = screen.getByRole("navigation", { name: "設問へ移動" });
    expect(within(navigation).getByRole("list").querySelectorAll("li")).toHaveLength(5);
    expect(screen.getByText("未回答 5問")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "5問の回答を確定する" })).toBeDisabled();
  });

  it("shows loading, participant switching, and the ready start screen", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "loading" }));
    const { rerender } = render(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("全5問を準備しています");

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "ready" },
        { access: { kind: "switching", participant: { id: 7, name: "参加者" } } },
      ),
    );
    rerender(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("参加状態を切り替えています");

    const start = vi.fn();
    mockUseQuizSession.mockReturnValue(session({ kind: "ready" }, { start }));
    rerender(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "参加者さん" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "検定をはじめる" }));
    expect(start).toHaveBeenCalledOnce();
  });

  it("shows shortage and load-error screens with and without retained questions", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "shortage" }, { quizzes: [] }));
    const { rerender } = render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "問題が足りません" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/");

    const retryLoad = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "load-error", message: "load failed" }, { quizzes: [], retryLoad }),
    );
    rerender(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent("load failed");
    expect(screen.getByRole("button", { name: "もう一度読み込む" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));
    expect(retryLoad).toHaveBeenCalledOnce();

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "load-error", message: "partial load failed" },
        { quizzes: quizzes.slice(0, 2), retryLoad },
      ),
    );
    rerender(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("取得済みの2問は保持しています");
    expect(screen.getByRole("button", { name: "不足分を再読み込み" })).toBeInTheDocument();
  });

  it("reports a failed participant switch and falls back for non-Error failures", async () => {
    const switchParticipant = vi.fn().mockRejectedValueOnce(new Error("switch failed"));
    mockUseQuizSession.mockReturnValue(session({ kind: "ready" }, { switchParticipant }));
    render(<QuizRunner />);
    fireEvent.click(screen.getByRole("button", { name: "別の名前で参加" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("switch failed");

    switchParticipant.mockRejectedValueOnce("unknown failure");
    fireEvent.click(screen.getByRole("button", { name: "別の名前で参加" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "参加状態を切り替えられませんでした。",
    );
    expect(switchParticipant).toHaveBeenCalledTimes(2);
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
    render(<QuizRunner />);
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
    render(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("回答を送信しています");
    expect(screen.getAllByRole("radio").every((radio) => radio.hasAttribute("disabled"))).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "回答を送信しています…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("moves focus to a question from the progress and unanswered links", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "answering" }));
    render(<QuizRunner />);
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
  });

  it("shows a retryable save error, locks the draft, and calls batch save explicitly", () => {
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", message: "temporary save failure", retryRequired: true },
        { selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, answeredCount: 5, saveAnswers },
      ),
    );
    render(<QuizRunner />);
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
    render(<QuizRunner />);
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
    render(<QuizRunner />);
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
    render(<QuizRunner />);
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
    render(<QuizRunner />);
    fireEvent.click(screen.getByRole("button", { name: "修正内容を確定する" }));
    expect(saveAnswers).toHaveBeenCalledOnce();
  });

  it("shows neutral completion and offers correction of the same five answers", () => {
    const editAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }, { editAnswers }));
    render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "回答完了" })).toBeInTheDocument();
    expect(
      screen.getByText("回答を見直す場合は、同じ5問の回答を復元して修正できます。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/正解|不正解|合格|得点|正答率/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答を修正する" }));
    expect(editAnswers).toHaveBeenCalledOnce();
  });

  it("preserves the draft and provides explicit controls after save conflict or saved-answer refresh failure", () => {
    const refreshSavedAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", message: "状態を再確認してください。", refreshRequired: true },
        { selections: { 1: 1 }, answeredCount: 1, refreshSavedAnswers },
      ),
    );
    render(<QuizRunner />);
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
    render(<QuizRunner />);
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
    render(<QuizRunner />);
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
    render(<QuizRunner />);
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
    render(<QuizRunner />);
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
