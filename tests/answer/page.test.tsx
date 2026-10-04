import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AnswerPage from "@/app/answer/page";

const mockUseQuizSession = vi.hoisted(() => vi.fn());
vi.mock("@/app/answer/use-quiz-session", () => ({
  useQuizSession: () => mockUseQuizSession(),
}));

describe("AnswerPage", () => {
  it("renders QuizRunner", () => {
    mockUseQuizSession.mockReturnValue({
      access: { kind: "checking" },
      phase: { kind: "loading" },
      quiz: undefined,
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
    });
    render(<AnswerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("参加状態を確認しています");
  });

  it("shows the participant form after session lookup reports no participant", () => {
    mockUseQuizSession.mockReturnValue({
      access: { kind: "login" },
      phase: { kind: "ready" },
      quiz: undefined,
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
    });
    render(<AnswerPage />);
    expect(screen.getByRole("heading", { name: "参加して検定を受ける" })).toBeInTheDocument();
    expect(screen.getByLabelText("お名前")).toBeInTheDocument();
    expect(screen.getByLabelText("4桁PIN")).toBeInTheDocument();
  });
});
