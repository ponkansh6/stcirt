import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import QuizRunner from "@/app/answer/quiz-runner";
import { runIfSubmissionAllowed } from "@/app/answer/submission-gate";

const mockUseQuizSession = vi.hoisted(() => vi.fn());
vi.mock("@/app/answer/use-quiz-session", () => ({ useQuizSession: () => mockUseQuizSession() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/answer" }));

const selectedQuizzes = Array.from({ length: 5 }, (_, index) => ({
  question: {
    id: index + 1,
    question: `設問${index + 1}`,
    choices: ["A", "B", "C", "D"],
    answerType: "selected" as const,
  },
  shuffled: { choices: ["A", "B", "C", "D"], choiceIndices: [0, 1, 2, 3] },
}));

const visibleResultsPayload = {
  state: "visible",
  rank: 1,
  isAggregationTarget: true,
  participantCount: 1,
  score: 1,
  maxScore: 1,
  questions: [{ position: 0, question: "設問", answer: { kind: "unanswered" } }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(phase: object, overrides: Record<string, unknown> = {}) {
  return {
    access: { kind: "ready", participant: { id: 7, name: "参加者" } },
    answerMode: "owner",
    assistedScreen: "closed",
    assistedParticipant: null,
    assistedError: null,
    assistedBusy: false,
    phase,
    restoreError: null,
    quizzes: selectedQuizzes,
    selections: {},
    freeResponses: {},
    legacyAnswerIds: [],
    savedSelections: {},
    answeredCount: 0,
    select: vi.fn(),
    setFreeResponse: vi.fn(),
    saveAnswers: vi.fn(),
    refreshSavedAnswers: vi.fn(),
    editAnswers: vi.fn(),
    retryLoad: vi.fn(),
    retrySubmissionCheck: vi.fn(),
    login: vi.fn(async () => {}),
    ...overrides,
  };
}

function triggerVisibleTabRefresh() {
  const originalDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    fireEvent(document, new Event("visibilitychange"));
  } finally {
    if (originalDescriptor) Object.defineProperty(document, "visibilityState", originalDescriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
}

function expectCompletionStatus() {
  expect(screen.getByRole("heading", { level: 1, name: "回答済み" })).toBeInTheDocument();
  expect(screen.queryByText(/結果.*(確認|公開|待ち)/)).not.toBeInTheDocument();
}

function getAnswererNameField(container: HTMLElement) {
  const nameLabel = within(container).getByText("氏名", { exact: true });
  const definition = nameLabel.nextElementSibling;
  const field = nameLabel.closest("dl")?.parentElement;
  expect(definition).toBeInTheDocument();
  expect(field).toBeInTheDocument();
  return { definition: definition as HTMLElement, field: field as HTMLElement };
}

describe("QuizRunner remaining coverage states", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("shows the submission lookup spinner and a retry action after lookup failure", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "checking-submission" }));
    const view = render(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("保存済みの回答状況を確認しています");

    mockUseQuizSession.mockReturnValue(session({ kind: "ready" }));
    view.rerender(<QuizRunner />);
    expect(screen.getByRole("status")).toHaveTextContent("保存済みの回答状況を確認しています");

    const retrySubmissionCheck = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "submission-error", message: "lookup unavailable" },
        { retrySubmissionCheck },
      ),
    );
    view.rerender(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent("lookup unavailable");
    fireEvent.click(screen.getByRole("button", { name: "もう一度確認する" }));
    expect(retrySubmissionCheck).toHaveBeenCalledOnce();
  });

  it("preserves the last confirmed results link after a rejected refresh without a manual retry control", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({ ok: false } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    const resultsLink = await screen.findByRole("link", { name: "自分の結果を見る" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(resultsLink).toBeInTheDocument();
      expectCompletionStatus();
    } finally {
      if (originalVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
    expect(screen.queryByRole("button", { name: /公開状況/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代理回答を行う" })).toBeInTheDocument();
  });

  it("links to the assisted participant's results after a successful status response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => visibleResultsPayload,
    } as Response);
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
        },
      ),
    );

    render(<QuizRunner />);

    const resultsLink = await screen.findByRole("link", { name: "代理回答の結果を見る" });
    expect(resultsLink).toHaveAttribute("href", "/results?scope=assisted");
  });

  it("renders a nonempty saved free response in the answer field", () => {
    const quizzes = selectedQuizzes.map((quiz, index) =>
      index === 4
        ? { ...quiz, question: { ...quiz.question, answerType: "freeText" as const, choices: [] } }
        : quiz,
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { quizzes, freeResponses: { 5: "保存した記述回答" } }),
    );
    render(<QuizRunner />);
    expect(screen.getByRole("textbox", { name: "回答（1000字以内）" })).toHaveValue(
      "保存した記述回答",
    );
  });

  it("reviews all five selected and free-text answers and reflects an edited selection", () => {
    const quizzes = selectedQuizzes.map((quiz, index) =>
      index === 1 || index === 3
        ? { ...quiz, question: { ...quiz.question, answerType: "freeText" as const, choices: [] } }
        : quiz,
    );
    function EditableAnswerSheet() {
      const [selections, setSelections] = useState<Record<number, number>>({ 1: 0, 3: 2, 5: 1 });
      const [freeResponses, setFreeResponses] = useState<Record<number, string>>({
        2: "記述回答その二",
        4: "記述回答その四",
      });
      mockUseQuizSession.mockReturnValue(
        session(
          { kind: "answering" },
          {
            quizzes,
            selections,
            freeResponses,
            answeredCount: 5,
            select: (questionId: number, choiceIndex: number) =>
              setSelections((current) => ({ ...current, [questionId]: choiceIndex })),
            setFreeResponse: (questionId: number, value: string) =>
              setFreeResponses((current) => ({ ...current, [questionId]: value })),
          },
        ),
      );
      return <QuizRunner />;
    }

    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      render(<EditableAnswerSheet />);

      const review = screen.getByRole("list", { name: "回答内容" });
      const questionCards = within(review).getAllByRole("listitem");
      expect(within(questionCards[0]).getByText("A. A", { exact: true })).toBeInTheDocument();
      expect(
        within(questionCards[1]).getByText("記述回答その二", { exact: true }),
      ).toBeInTheDocument();
      expect(within(questionCards[2]).getByText("C. C", { exact: true })).toBeInTheDocument();
      expect(
        within(questionCards[3]).getByText("記述回答その四", { exact: true }),
      ).toBeInTheDocument();
      expect(within(questionCards[4]).getByText("B. B", { exact: true })).toBeInTheDocument();

      fireEvent.click(
        within(questionCards[0]).getByRole("button", { name: "第1問「設問1」を編集" }),
      );
      fireEvent.click(document.getElementById("answer-1-1") as HTMLInputElement);

      expect(document.getElementById("answer-1-1")).toBeChecked();
      expect(within(questionCards[0]).getByText("B. B", { exact: true })).toBeInTheDocument();
      expect(within(questionCards[0]).queryByText("A. A", { exact: true })).not.toBeInTheDocument();
      expect(within(questionCards[4]).getByText("B. B", { exact: true })).toBeInTheDocument();
    } finally {
      if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("renders an empty free-response field and forwards typed values", () => {
    const quizzes = selectedQuizzes.map((quiz, index) =>
      index === 4
        ? { ...quiz, question: { ...quiz.question, answerType: "freeText" as const, choices: [] } }
        : quiz,
    );
    const setFreeResponse = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { quizzes, setFreeResponse }),
    );
    render(<QuizRunner />);
    const textbox = screen.getByRole("textbox", { name: "回答（1000字以内）" });
    expect(textbox).toHaveValue("");
    fireEvent.change(textbox, { target: { value: "入力中の回答" } });
    expect(setFreeResponse).toHaveBeenCalledWith(5, "入力中の回答");
  });

  it("focuses the selected answer or the first available answer from final review", () => {
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { selections: { 1: 2 }, answeredCount: 1 }),
    );
    render(<QuizRunner />);

    const selected = document.querySelector<HTMLElement>('#question-1 input[type="radio"]:checked');
    const unanswered = document.querySelector<HTMLElement>('#question-2 input[type="radio"]');
    expect(selected).not.toBeNull();
    expect(unanswered).not.toBeNull();
    const selectedFocus = vi.spyOn(selected as HTMLElement, "focus");
    const unansweredFocus = vi.spyOn(unanswered as HTMLElement, "focus");
    const firstHeading = document.querySelector<HTMLElement>("#question-1 h2");
    const secondHeading = document.querySelector<HTMLElement>("#question-2 h2");
    expect(firstHeading).not.toBeNull();
    expect(secondHeading).not.toBeNull();
    firstHeading!.scrollIntoView = vi.fn();
    secondHeading!.scrollIntoView = vi.fn();

    fireEvent.click(screen.getByRole("button", { name: "第1問「設問1」を編集" }));
    expect(selectedFocus).toHaveBeenCalledWith({ preventScroll: true });
    fireEvent.click(screen.getByRole("button", { name: "第2問「設問2」を編集" }));
    expect(unansweredFocus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("falls back to the question heading when its answer controls are unavailable", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, answeredCount: 5 },
      ),
    );
    render(<QuizRunner />);

    const firstQuestion = document.getElementById("question-1");
    const heading = firstQuestion?.querySelector<HTMLElement>("h2");
    expect(firstQuestion).not.toBeNull();
    expect(heading).not.toBeNull();
    firstQuestion!.querySelectorAll("input[type=radio]").forEach((input) => input.remove());
    (heading as HTMLElement).scrollIntoView = vi.fn();
    const headingFocus = vi.spyOn(heading as HTMLElement, "focus");

    fireEvent.click(screen.getByRole("button", { name: "第1問「設問1」を編集" }));

    expect(headingFocus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("uses fallback recovery guidance when an answering phase has no message", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "answering", refreshRequired: true }));
    const { rerender } = render(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "保存済み回答が更新されています。回答案は保持しています。再確認後に送信できます。",
    );

    mockUseQuizSession.mockReturnValue(session({ kind: "answering", retryRequired: true }));
    rerender(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "回答は保存できませんでした。回答案は保持しています。同じ内容を再送してください。",
    );
    expect(screen.getByRole("button", { name: "未回答の設問に回答してください" })).toBeDisabled();
  });

  it("keeps submit disabled and the incomplete draft visible", () => {
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { selections: { 1: 0 }, answeredCount: 1 }),
    );
    render(<QuizRunner />);

    expect(screen.getByText("未回答 4問", { exact: true })).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "未回答の設問に回答してください" });
    expect(submit).toBeDisabled();
    expect(document.getElementById("answer-1-0")).toBeChecked();
  });

  it("keeps a complete draft visible while results are published", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", publishedLock: true },
        {
          selections: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 0 },
          answeredCount: 5,
        },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByText("全5問に回答しました。", { exact: true })).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "5問の回答を確定する" });
    expect(submit).toBeDisabled();
    for (const [questionId, choiceIndex] of Object.entries({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 0 })) {
      expect(document.getElementById(`answer-${questionId}-${choiceIndex}`)).toBeChecked();
    }
  });

  it("keeps incomplete answer recovery without offering submit after an error message", () => {
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering", message: "保存状態を確認してください。" }),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("alert")).toHaveTextContent("回答内容を確認してください");
    expect(screen.getByRole("button", { name: "未回答の設問に回答してください" })).toBeDisabled();
  });

  it("shows a long free response preview and its full text, including unanswered free text", () => {
    const quizzes = selectedQuizzes.map((quiz, index) =>
      index >= 3
        ? { ...quiz, question: { ...quiz.question, answerType: "freeText" as const, choices: [] } }
        : quiz,
    );
    const longAnswer = "あ".repeat(181);
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { quizzes, selections: { 1: 0, 2: 0, 3: 0 }, freeResponses: { 5: longAnswer } },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByText(`${"あ".repeat(180)}…`, { exact: true })).toBeInTheDocument();
    const fullResponse = screen.getByText("全文を表示（181文字）").closest("details");
    expect(fullResponse).not.toBeNull();
    fireEvent.click(within(fullResponse as HTMLElement).getByText("全文を表示（181文字）"));
    expect(
      within(fullResponse as HTMLElement).getByText(longAnswer, { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText("自由記述は未入力です。")).toBeInTheDocument();
  });

  it("keeps reauthentication guidance for submission and load failures, and blocks stale recovery actions", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "submission-error", message: "回答状況を確認できません。" },
        { access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } } },
      ),
    );
    const { rerender } = render(<QuizRunner />);
    expect(screen.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("再ログイン後に状態を確認");

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "load-error", message: "設問を読み込めません。" },
        { access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } } },
      ),
    );
    rerender(<QuizRunner />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "設問を読み込めません。再ログイン後に状態を確認",
    );

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", message: "保存状態を再確認してください。", refreshRequired: true },
        { access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } } },
      ),
    );
    rerender(<QuizRunner />);
    expect(
      screen.getByRole("button", { name: "再ログイン後に保存済み回答を再確認する" }),
    ).toBeDisabled();
  });

  it("shows generic reauthentication guidance while refreshing", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "refreshing" },
        { access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } } },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "再ログイン後、現在の状態を確認してから次の操作を行ってください。回答は自動送信されません。",
    );
  });

  it.each([
    ["submitting", { kind: "submitting" }],
    ["refreshing", { kind: "refreshing" }],
  ] as const)("keeps the draft visible while %s is in progress", (label, phase) => {
    mockUseQuizSession.mockReturnValue(
      session(phase, {
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    render(<QuizRunner />);

    const expectedStatus =
      label === "submitting" ? "回答を送信しています…" : "保存済み回答を確認しています…";
    const expectedGuidance =
      label === "submitting"
        ? "送信が完了するまで、回答の変更や再送はできません。"
        : "確認が終わるまで、回答の変更や送信はできません。";
    expect(screen.getByRole("status")).toHaveTextContent(expectedStatus);
    expect(screen.getByRole("status")).toHaveTextContent(expectedGuidance);
    const submit = screen.getByRole("button", {
      name: /回答を送信しています|保存済み回答を確認しています/,
    });
    expect(submit).toBeDisabled();
    for (let questionId = 1; questionId <= 5; questionId += 1) {
      expect(document.getElementById(`answer-${questionId}-0`)).toBeChecked();
    }
  });

  it("explains when a free-text question has a legacy selected answer", () => {
    const quizzes = selectedQuizzes.map((quiz, index) =>
      index === 4
        ? { ...quiz, question: { ...quiz.question, answerType: "freeText" as const, choices: [] } }
        : quiz,
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { quizzes, legacyAnswerIds: [5] }),
    );
    render(<QuizRunner />);
    expect(screen.getByText(/以前の保存回答は旧選択式です/)).toBeInTheDocument();
  });

  it("hides participant results when the results response cannot be parsed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error("invalid response");
      },
    } as unknown as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
  });

  it("preserves participant results when a later results request cannot be parsed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error("invalid response");
        },
      } as unknown as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    const resultsLink = await screen.findByRole("link", { name: "自分の結果を見る" });

    const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(resultsLink).toBeInTheDocument();
      expectCompletionStatus();
    } finally {
      if (originalVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });

  it("preserves the confirmed results CTA when visible state lacks the required result fields", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: "visible" }) } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    const resultsLink = await screen.findByRole("link", { name: "自分の結果を見る" });

    triggerVisibleTabRefresh();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(resultsLink).toBeInTheDocument();
    expectCompletionStatus();
  });

  it("refreshes publication on return to the tab and clears the CTA after a confirmed waiting response", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: "waiting" }) } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    const resultsLink = await screen.findByRole("link", { name: "自分の結果を見る" });

    expect(screen.queryByRole("button", { name: /公開状況/ })).not.toBeInTheDocument();
    triggerVisibleTabRefresh();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(resultsLink).not.toBeInTheDocument());
    expectCompletionStatus();
  });

  it("removes the results CTA and keeps the completion copy when results are unavailable", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: "unavailable" }),
      } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    await screen.findByRole("link", { name: "自分の結果を見る" });

    triggerVisibleTabRefresh();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expectCompletionStatus();
  });

  it("clears the results CTA and offers reauthentication after a 401 while keeping completion copy", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    await screen.findByRole("link", { name: "自分の結果を見る" });

    triggerVisibleTabRefresh();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expectCompletionStatus();
    expect(screen.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeInTheDocument();
    expect(screen.getByLabelText("4桁PIN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再ログインする" })).toBeInTheDocument();
  });

  it("does not offer another assisted participant when the owner is ineligible", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          assistedParticipant: { participant: null, hasSubmission: false, eligible: false },
        },
      ),
    );
    render(<QuizRunner />);

    expect(screen.queryByRole("button", { name: "代理回答を行う" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "代理回答を修正する" })).not.toBeInTheDocument();
  });

  it("resumes the one linked participant and changes its completion action after saving", () => {
    const resumeAssisted = vi.fn();
    const returnToOwner = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          assistedParticipant: {
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: false,
            eligible: false,
          },
          resumeAssisted,
          returnToOwner,
        },
      ),
    );
    const { rerender } = render(<QuizRunner />);

    expect(screen.getByText("代理回答者さんの回答を再開できます。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "代理回答を行う" }));
    expect(resumeAssisted).toHaveBeenCalledOnce();

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          assistedParticipant: {
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: true,
            eligible: false,
          },
        },
      ),
    );
    rerender(<QuizRunner />);
    expect(screen.getByRole("button", { name: "代理回答を修正する" })).toBeInTheDocument();
    expect(screen.queryByText("代理回答者さんの回答を再開できます。")).not.toBeInTheDocument();
  });

  it("shows the in-progress assisted status and disables duplicate starts", () => {
    const startAssisted = vi.fn();
    const returnToOwner = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          assistedBusy: true,
          assistedError:
            "代理回答の状態を確認できませんでした。時間をおいて再読み込みしてください。",
          startAssisted,
          returnToOwner,
        },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "代理回答の状態を確認できませんでした。時間をおいて再読み込みしてください。",
    );
    expect(screen.getByRole("button", { name: "回答状態を確認しています…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "回答状態を確認しています…" }));
    expect(startAssisted).not.toHaveBeenCalled();
    expect(returnToOwner).not.toHaveBeenCalled();
  });

  it("switches the displayed name and classification when returning to the owner", () => {
    const assistedParticipant = {
      participant: { id: 18, name: "代理回答者" },
      hasSubmission: false,
      eligible: false,
    };
    function SwitchableAnswerer() {
      const [answerMode, setAnswerMode] = useState<"owner" | "assisted">("assisted");
      mockUseQuizSession.mockReturnValue(
        session(
          { kind: "answering" },
          {
            answerMode,
            assistedParticipant,
            returnToOwner: () => setAnswerMode("owner"),
          },
        ),
      );
      return <QuizRunner />;
    }
    render(<SwitchableAnswerer />);

    const { definition, field: answererField } = getAnswererNameField(screen.getByRole("banner"));
    expect(definition).toHaveTextContent("代理回答者");
    expect(within(answererField).getByText("代理回答", { exact: true })).toBeInTheDocument();
    expect(definition).toHaveClass("min-w-0", "break-words");
    expect(answererField).toHaveClass("min-w-0");
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    const { definition: ownerName, field: ownerAnswererField } = getAnswererNameField(
      screen.getByRole("banner"),
    );
    expect(ownerName).toHaveTextContent("参加者");
    expect(within(ownerAnswererField).queryByText("本人の回答")).not.toBeInTheDocument();
    expect(screen.queryByText("代理回答者")).not.toBeInTheDocument();
    expect(screen.queryByText("代理回答", { exact: true })).not.toBeInTheDocument();
  });

  it("uses the owner's registered name without a classification while answering", () => {
    mockUseQuizSession.mockReturnValue(session({ kind: "answering" }));
    render(<QuizRunner />);

    const { definition, field: answererField } = getAnswererNameField(screen.getByRole("banner"));
    expect(definition).toHaveTextContent("参加者");
    expect(within(answererField).queryByText("本人の回答")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未回答の設問に回答してください" })).toBeDisabled();
  });

  it("uses a generic owner name when the registered name is empty", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        { access: { kind: "ready", participant: { id: 7, name: "" } } },
      ),
    );
    render(<QuizRunner />);

    const { definition, field: answererField } = getAnswererNameField(screen.getByRole("main"));
    expect(definition).toHaveTextContent("本人");
    expect(within(answererField).queryByText("本人の回答")).not.toBeInTheDocument();
  });

  it.each([
    ["status missing", null],
    ["participant missing", { participant: null, hasSubmission: false, eligible: false }],
  ])("uses a generic assisted identity at completion when %s", (_label, assistedParticipant) => {
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { answerMode: "assisted", assistedParticipant }),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    const { definition, field: answererField } = getAnswererNameField(screen.getByRole("main"));
    expect(definition).toHaveTextContent("代理回答者");
    expect(within(answererField).getByText("代理回答", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("参加者")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/participants/results?scope=assisted",
      expect.anything(),
    );
  });

  it.each([
    ["status missing", null],
    ["participant missing", { participant: null, hasSubmission: false, eligible: false }],
  ])(
    "uses a generic assisted identity in the answer header when %s",
    (_label, assistedParticipant) => {
      mockUseQuizSession.mockReturnValue(
        session({ kind: "answering" }, { answerMode: "assisted", assistedParticipant }),
      );
      render(<QuizRunner />);

      const { definition, field: answererField } = getAnswererNameField(screen.getByRole("banner"));
      expect(definition).toHaveTextContent("代理回答者");
      expect(within(answererField).getByText("代理回答", { exact: true })).toBeInTheDocument();
      expect(screen.queryByText("参加者")).not.toBeInTheDocument();
    },
  );

  it("shows reauthentication on the assisted sign-in screen after session expiry", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          assistedScreen: "login",
          access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } },
        },
      ),
    );
    render(<QuizRunner />);

    const completionRegion = screen.getByRole("region", { name: "回答済み" });
    expect(screen.getByRole("heading", { level: 1, name: "回答済み" })).toBeInTheDocument();
    expect(
      within(completionRegion).getByRole("heading", { level: 2, name: "回答済み" }),
    ).toBeInTheDocument();
    expect(within(completionRegion).getByText(/再ログインしてください/)).toBeInTheDocument();
    expect(within(completionRegion).getByText(/回答は自動送信されません/)).toBeInTheDocument();
    expect(within(completionRegion).getByLabelText("4桁PIN")).toBeInTheDocument();
    expect(
      within(completionRegion).getByRole("button", { name: "再ログインする" }),
    ).toBeInTheDocument();
  });

  it("shows a server assisted-login message before the form has a local error", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          assistedScreen: "login",
          assistedError:
            "代理回答の状態を確認できませんでした。時間をおいて再読み込みしてください。",
        },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "代理回答の状態を確認できませんでした。時間をおいて再読み込みしてください。",
    );
  });

  it("offers owner reauthentication after completion without enabling assisted registration", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        { access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } } },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByLabelText("4桁PIN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再ログインする" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "代理回答を行う" })).not.toBeInTheDocument();
  });

  it("prevents leaving the assisted login screen while its registration is pending", () => {
    const startAssisted = vi.fn();
    const returnToOwner = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        { assistedScreen: "login", assistedBusy: true, startAssisted, returnToOwner },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("button", { name: "回答を準備しています…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "自分の回答に戻る" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("本来回答する人のお名前").closest("form")!);
    expect(startAssisted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    expect(returnToOwner).not.toHaveBeenCalled();
  });

  it("shows a name-only form error when starting an assisted response fails", async () => {
    const startAssisted = vi
      .fn()
      .mockRejectedValueOnce(new Error("登録できませんでした"))
      .mockRejectedValueOnce("unknown failure");
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { assistedScreen: "login", startAssisted }),
    );
    render(<QuizRunner />);

    fireEvent.change(screen.getByLabelText("本来回答する人のお名前"), {
      target: { value: "代理回答者" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "回答をはじめる" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("登録できませんでした");
    fireEvent.submit(screen.getByRole("button", { name: "回答をはじめる" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "回答を開始できませんでした。入力内容をご確認ください。",
    );
  });

  it("ignores an older results payload when visibility queues a newer request", async () => {
    const stalePayload = deferred<{ state: string }>();
    const currentPayload = deferred<{ state: string }>();
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: () => stalePayload.promise } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => currentPayload.promise,
      } as unknown as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      stalePayload.resolve(visibleResultsPayload);
      await stalePayload.promise;
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
      currentPayload.resolve(visibleResultsPayload);
      expect(await screen.findByRole("link", { name: "自分の結果を見る" })).toBeInTheDocument();
    } finally {
      if (originalVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });

  it("drains a results payload that resolves after the runner unmounts", async () => {
    const payload = deferred<{ state: string }>();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => payload.promise,
    } as unknown as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    const view = render(<QuizRunner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    view.unmount();
    payload.resolve(visibleResultsPayload);
    await payload.promise;
    await Promise.resolve();
  });

  it("does not hide visible results when a superseded results request rejects", async () => {
    const stalePayload = deferred<{ state: string }>();
    const currentPayload = deferred<{ state: string }>();
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => stalePayload.promise } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => currentPayload.promise,
      } as unknown as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    const resultsLink = await screen.findByRole("link", { name: "自分の結果を見る" });

    const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      document.dispatchEvent(new Event("visibilitychange"));
      stalePayload.reject(new Error("stale response failed"));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      expect(resultsLink).toBeInTheDocument();
      currentPayload.resolve(visibleResultsPayload);
      expect(await screen.findByRole("link", { name: "自分の結果を見る" })).toBeInTheDocument();
    } finally {
      if (originalVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });

  it("drains a rejected results payload after the runner unmounts", async () => {
    const payload = deferred<{ state: string }>();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => payload.promise,
    } as unknown as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    const view = render(<QuizRunner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    view.unmount();
    payload.reject(new Error("late response failed"));
    await payload.promise.catch(() => undefined);
    await Promise.resolve();
  });
});

describe("runIfSubmissionAllowed", () => {
  it("runs the action only when submission is allowed and unblocked", () => {
    const action = vi.fn(() => "saved");

    expect(runIfSubmissionAllowed(false, false, action)).toBeUndefined();
    expect(runIfSubmissionAllowed(true, true, action)).toBeUndefined();
    expect(action).not.toHaveBeenCalled();

    expect(runIfSubmissionAllowed(true, false, action)).toBe("saved");
    expect(action).toHaveBeenCalledOnce();
  });
});
