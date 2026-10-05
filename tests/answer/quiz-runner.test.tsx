import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";

const mockUseQuizSession = vi.hoisted(() => vi.fn());
vi.mock("@/app/answer/use-quiz-session", () => ({
  useQuizSession: () => mockUseQuizSession(),
}));

const question = {
  question: {
    id: 1,
    question: "What is the capital of France?",
    choices: ["Paris", "London", "Berlin", "Madrid"],
  },
  shuffled: { choices: ["Paris", "London", "Berlin", "Madrid"], choiceIndices: [0, 1, 2, 3] },
};

function session(phase: object, overrides: Record<string, unknown> = {}) {
  return {
    access: { kind: "ready", participant: { id: 7, name: "参加者" } },
    phase,
    quiz: question,
    questionIndex: 0,
    recordedCount: 0,
    select: vi.fn(),
    confirm: vi.fn(),
    retry: vi.fn(),
    login: vi.fn(async () => {}),
    start: vi.fn(),
    switchParticipant: vi.fn(async () => {}),
    resendAnswer: vi.fn(),
    restart: vi.fn(),
    ...overrides,
  };
}

describe("QuizRunner", () => {
  beforeEach(() => mockUseQuizSession.mockReset());

  it("shows the five-question loading state", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "loading" }));
    render(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("全5問を準備しています");
  });

  it("shows the participant-switching state", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "ready" }));
    const { rerender } = render(<QuizRunner />);

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "ready" },
        { access: { kind: "switching", participant: { id: 7, name: "参加者" } } },
      ),
    );
    rerender(<QuizRunner />);

    expect(screen.getByRole("status")).toHaveTextContent("参加状態を切り替えています…");
  });

  it("collects name and a four digit PIN, clears the PIN after submit, then waits for explicit start", async () => {
    const login = vi.fn(async () => {});
    const start = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login, start }),
    );
    const { rerender } = render(<QuizRunner />);
    fireEvent.change(screen.getByLabelText("お名前"), { target: { value: "田中" } });
    const pinInput = screen.getByLabelText("4桁PIN") as HTMLInputElement;
    fireEvent.change(pinInput, { target: { value: "0a12345" } });
    expect(pinInput).toHaveValue("0123");
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("田中", "0123"));
    expect(pinInput).toHaveValue("");
    expect(start).not.toHaveBeenCalled();

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "ready" },
        { access: { kind: "ready", participant: { id: 8, name: "田中" } }, start },
      ),
    );
    rerender(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "田中さん" })).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "検定をはじめる" }));
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps the name and clears the PIN after a failed participant login", async () => {
    const login = vi.fn(async () => {
      throw new Error("PINが正しくありません。");
    });
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login }),
    );
    render(<QuizRunner />);
    const nameInput = screen.getByLabelText("お名前") as HTMLInputElement;
    const pinInput = screen.getByLabelText("4桁PIN") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "田中" } });
    fireEvent.change(pinInput, { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("PINが正しくありません。");
    expect(nameInput).toHaveValue("田中");
    expect(pinInput).toHaveValue("");
  });

  it("offers logout and another name for an authenticated participant", () => {
    const switchParticipant = vi.fn(async () => {});
    mockUseQuizSession.mockReturnValue(session({ kind: "ready" }, { switchParticipant }));
    render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "参加者さん" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "別の名前で参加" }));
    expect(switchParticipant).toHaveBeenCalledOnce();
  });

  it("shows a fallback alert when switching participants rejects a non-Error value", async () => {
    const switchParticipant = vi.fn(() => Promise.reject("failure"));
    mockUseQuizSession.mockReturnValue(session({ kind: "ready" }, { switchParticipant }));
    render(<QuizRunner />);
    fireEvent.click(screen.getByRole("button", { name: "別の名前で参加" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "参加状態を切り替えられませんでした。",
    );
  });

  it("shows a shortage message and home path when five questions are unavailable", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "shortage" }, { quiz: undefined }));
    render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "問題が足りません" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/");
  });

  it("retries a network failure to load the missing questions", () => {
    const retry = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "error", message: "Load failed" }, { retry }),
    );
    render(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Load failed");
    fireEvent.click(screen.getByRole("button", { name: "不足分を再読み込み" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("renders the question position separately from recorded answers and confirms a choice", () => {
    const select = vi.fn();
    const confirm = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "question", selectedIndex: 0 },
        { select, confirm, recordedCount: 1, questionIndex: 1 },
      ),
    );
    render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "第2問 / 全5問" })).toBeInTheDocument();
    expect(screen.getByText("回答記録済み 1/5")).toBeInTheDocument();
    expect(screen.getByText("What is the capital of France?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /A\..*Paris/ })).toBeChecked();
    expect(screen.getByRole("group", { name: "回答を1つ選択してください" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "回答を確定する" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByText(/正解！|不正解|解説:/)).not.toBeInTheDocument();
  });

  it("locks choices while the answer is being recorded", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "submitting", selectedIndex: 1 }));
    render(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("回答を記録しています");
    const confirm = screen.getByRole("button", { name: "回答を確定する" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).not.toBeDisabled();
    expect(confirm).not.toHaveAttribute("aria-busy");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /B\..*London/ })).toBeChecked();
    expect(screen.getAllByRole("radio").every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
  });

  it("keeps the selected option visible after failure and explicitly resends or returns home", () => {
    const resendAnswer = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "error", message: "Could not record", selectedIndex: 1 }, { resendAnswer }),
    );
    render(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not record");
    expect(screen.getByRole("radio", { name: /B\..*London/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "回答を再送する" }));
    expect(resendAnswer).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/");
  });

  it("shows reauthentication while keeping the failed choice and does not offer automatic resend", () => {
    const login = vi.fn(async () => {});
    mockUseQuizSession.mockReturnValue(
      session(
        {
          kind: "error",
          message: "Session expired",
          selectedIndex: 1,
          authenticationRequired: true,
        },
        { access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } }, login },
      ),
    );
    render(<QuizRunner />);
    expect(screen.getByRole("radio", { name: /B\..*London/ })).toBeChecked();
    expect(screen.getByText(/回答は自動送信されません/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再ログインする" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答を再送する" })).not.toBeInTheDocument();
  });

  it("shows neutral completion and restarts a fresh attempt", () => {
    const restart = vi.fn();
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }, { restart }));
    render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "回答完了" })).toBeInTheDocument();
    expect(screen.getByText("全5問の回答を記録しました。")).toBeInTheDocument();
    expect(screen.queryByText(/正解|不正解|合格|得点|正答率/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "もう一度受検する" }));
    expect(restart).toHaveBeenCalledOnce();
  });
});
