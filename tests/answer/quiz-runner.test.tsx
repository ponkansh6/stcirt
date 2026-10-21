import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
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

  it("renders five native radio groups, progress navigation, and a disabled final confirmation while unanswered", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "answering" }));
    render(<RunnerPage />);
    expect(screen.getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /Question [1-5]\?/ })).toHaveLength(5);
    const firstQuestion = document.querySelector<HTMLElement>("#question-1");
    expect(firstQuestion).not.toBeNull();
    expect(
      within(firstQuestion as HTMLElement).getByRole("heading", { name: "Question 1?" }),
    ).toBeVisible();
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
    const finalReview = document.querySelector<HTMLElement>(
      '[aria-labelledby="final-check-title"]',
    );
    expect(finalReview).not.toBeNull();
    expect(within(finalReview as HTMLElement).getByText("未回答 5問")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未回答の設問に回答してください" })).toBeDisabled();
  });

  it("announces ordinary answer progress only from the header", () => {
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { selections: { 1: 0 }, answeredCount: 1 }),
    );
    render(<RunnerPage />);

    const main = screen.getByRole("main");
    const liveRegions = main.querySelectorAll('[aria-live], [role="status"], [role="alert"]');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]).toHaveTextContent("回答済み 1/5");
    expect(liveRegions[0]).toHaveAttribute("aria-live", "polite");

    const finalReview = main.querySelector<HTMLElement>('[aria-labelledby="final-check-title"]');
    expect(finalReview).not.toBeNull();
    const ordinaryStatus = within(finalReview as HTMLElement)
      .getByText("未回答の設問へ移動して回答してください。回答は最後にまとめて確定します。")
      .closest("p");
    expect(ordinaryStatus).not.toHaveAttribute("role");
    expect(ordinaryStatus).not.toHaveAttribute("aria-live");
    expect(
      within(finalReview as HTMLElement)
        .getByText("未回答 4問")
        .closest("p"),
    ).not.toHaveAttribute("aria-live");
  });

  it("uses the same answered status in navigation and final review", () => {
    const freeResponseQuizzes = quizzes.map((quiz, index) =>
      index === 4
        ? { ...quiz, question: { ...quiz.question, answerType: "freeText" as const, choices: [] } }
        : quiz,
    );
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { quizzes: freeResponseQuizzes, selections: { 1: 0 }, freeResponses: { 5: "  \n" } },
      ),
    );

    render(<RunnerPage />);

    const navigation = screen.getByRole("navigation", { name: "設問へ移動" });
    expect(within(navigation).getByRole("link", { name: "第1問へ移動、回答済み" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "第2問へ移動、未回答" })).toBeVisible();
    expect(within(navigation).getByRole("link", { name: "第5問へ移動、未回答" })).toBeVisible();

    const reviewAnswers = screen.getByRole("list", { name: "回答内容" });
    const reviewItems = within(reviewAnswers).getAllByRole("listitem");
    expect(within(reviewItems[0]).getByText("回答")).toBeInTheDocument();
    expect(within(reviewItems[4]).getByText("未回答")).toBeInTheDocument();
    const finalReview = document.querySelector<HTMLElement>(
      '[aria-labelledby="final-check-title"]',
    );
    expect(finalReview).not.toBeNull();
    expect(within(finalReview as HTMLElement).getByText("未回答 4問")).toBeInTheDocument();
    expect(
      within(finalReview as HTMLElement)
        .getByText("未回答 4問")
        .closest("p"),
    ).not.toHaveAttribute("aria-live");
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
    expect(response).toHaveAttribute("rows", "6");
    expect(response.className).toContain("freeText");
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

  it("shows the exact partial-batch recovery guidance and retries the missing questions", () => {
    const retryLoad = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "load-error", message: "残りの問題を読み込めませんでした。" },
        { quizzes: quizzes.slice(0, 1), retryLoad },
      ),
    );
    render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "問題を読み込めませんでした" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("残りの問題を読み込めませんでした。");
    expect(screen.getByRole("status")).toHaveTextContent(
      "取得済みの1問は保持しています。不足分から再開できます。",
    );
    fireEvent.click(screen.getByRole("button", { name: "不足分を再読み込み" }));
    expect(retryLoad).toHaveBeenCalledOnce();
  });
});
