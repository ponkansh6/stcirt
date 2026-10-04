import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    phase,
    quiz: question,
    questionIndex: 0,
    recordedCount: 0,
    select: vi.fn(),
    confirm: vi.fn(),
    retry: vi.fn(),
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
    expect(screen.getByRole("button", { name: /Paris.*選択中/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "回答を確定する" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByText(/正解！|不正解|解説:/)).not.toBeInTheDocument();
  });

  it("locks choices while the answer is being recorded", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "submitting" }));
    render(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("回答を記録しています");
    expect(screen.getByRole("button", { name: /回答を記録しています/ })).toBeDisabled();
    expect(
      screen
        .getAllByRole("button", { name: /Paris|London|Berlin|Madrid/ })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps the selected option visible after failure and explicitly resends or returns home", () => {
    const resendAnswer = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "error", message: "Could not record", selectedIndex: 1 }, { resendAnswer }),
    );
    render(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not record");
    expect(screen.getByRole("button", { name: /London.*選択中/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "回答を再送する" }));
    expect(resendAnswer).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/");
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
