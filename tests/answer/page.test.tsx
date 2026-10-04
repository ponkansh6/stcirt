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
      phase: { kind: "loading" },
      quiz: undefined,
      questionIndex: 0,
      recordedCount: 0,
      select: vi.fn(),
      confirm: vi.fn(),
      retry: vi.fn(),
      resendAnswer: vi.fn(),
      restart: vi.fn(),
    });
    render(<AnswerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("全5問を準備しています");
  });
});
