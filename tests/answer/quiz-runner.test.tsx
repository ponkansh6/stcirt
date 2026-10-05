import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";

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
});
