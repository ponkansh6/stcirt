import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AnswerPage from "@/app/answer/page";

const mockUseQuizSession = vi.hoisted(() => vi.fn());
vi.mock("@/app/answer/use-quiz-session", () => ({
  useQuizSession: () => mockUseQuizSession(),
}));

function mockSession(access: object, phase: object) {
  mockUseQuizSession.mockReturnValue({
    access,
    phase,
    quizzes: [],
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
  });
}

describe("AnswerPage", () => {
  it("renders QuizRunner", () => {
    mockSession({ kind: "checking" }, { kind: "loading" });
    render(<AnswerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("参加状態を確認しています");
  });

  it("shows the participant form after session lookup reports no participant", () => {
    mockSession({ kind: "login" }, { kind: "ready" });
    render(<AnswerPage />);
    expect(screen.getByRole("heading", { name: "参加して検定を受ける" })).toBeInTheDocument();
    expect(screen.getByLabelText("お名前")).toBeInTheDocument();
    expect(screen.getByLabelText("4桁PIN")).toBeInTheDocument();
  });
});
