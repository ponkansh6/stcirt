import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
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
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: "保存済み回答を確認しています…" })).toBeDisabled();
  });

  it("keeps a new-submission draft through 401 reauthentication and waits for explicit save", async () => {
    const login = vi.fn(async () => {});
    const saveAnswers = vi.fn();
    const selections = { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 };
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", retryRequired: true },
        {
          access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } },
          selections,
          answeredCount: 5,
          login,
          saveAnswers,
        },
      ),
    );
    const view = render(<RunnerPage />);
    expect(screen.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeInTheDocument();
    expect(screen.getByLabelText("お名前")).toHaveValue("参加者");
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    expect(screen.queryByRole("button", { name: "同じ回答を再送する" })).not.toBeInTheDocument();
    expect(saveAnswers).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("参加者", "0123"));
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    expect(saveAnswers).not.toHaveBeenCalled();

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", retryRequired: true },
        { selections, answeredCount: 5, login, saveAnswers },
      ),
    );
    view.rerender(<RunnerPage />);
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    expect(saveAnswers).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(saveAnswers).toHaveBeenCalledOnce();
  });
});
