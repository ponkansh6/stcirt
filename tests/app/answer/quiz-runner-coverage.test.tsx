import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";

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
  score: 1,
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

  it("preserves the last confirmed results link after a later request is rejected and offers retry", async () => {
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
      expect(screen.getByRole("alert")).toHaveTextContent("表示中の状態は保持しています");
    } finally {
      if (originalVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
    expect(screen.getByRole("button", { name: "公開状況を再確認する" })).toBeInTheDocument();
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
      expect(screen.getByRole("alert")).toHaveTextContent("表示中の状態は保持しています");
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

    fireEvent.click(screen.getByRole("button", { name: "公開状況を再確認する" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(resultsLink).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("表示中の状態は保持しています");
  });

  it("rechecks publication manually and clears the CTA only after a confirmed waiting response", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: "waiting" }) } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    const resultsLink = await screen.findByRole("link", { name: "自分の結果を見る" });

    fireEvent.click(screen.getByRole("button", { name: "公開状況を再確認する" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(resultsLink).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("結果はまだ公開されていません");
  });

  it("removes the results CTA and shows the confirmed unavailable state", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: "unavailable" }),
      } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    await screen.findByRole("link", { name: "自分の結果を見る" });

    fireEvent.click(screen.getByRole("button", { name: "公開状況を再確認する" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("結果は現在確認できません");
  });

  it("clears the results CTA and reports session expiry after a 401", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<QuizRunner />);
    await screen.findByRole("link", { name: "自分の結果を見る" });

    fireEvent.click(screen.getByRole("button", { name: "公開状況を再確認する" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("セッションの有効期限が切れました");
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
