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
      expect(screen.getByRole("alert")).toHaveTextContent("結果の公開状態は現在確認できません。");
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

    const resultsLink = await screen.findByRole("link", { name: "代理回答者の結果を見る" });
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
      expect(screen.getByRole("alert")).toHaveTextContent("結果の公開状態は現在確認できません。");
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
    expect(screen.getByRole("alert")).toHaveTextContent("結果の公開状態は現在確認できません。");
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
    expect(screen.getByRole("status")).toHaveTextContent(
      "結果は主催者が公開するまで表示されません。",
    );
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

    triggerVisibleTabRefresh();
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

    triggerVisibleTabRefresh();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("セッションの有効期限が切れました");
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
          assistedError: "ほかの人の回答状態を確認できませんでした。",
          startAssisted,
          returnToOwner,
        },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "ほかの人の回答状態を確認できませんでした。",
    );
    expect(screen.getByRole("button", { name: "回答状態を確認しています…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "回答状態を確認しています…" }));
    expect(startAssisted).not.toHaveBeenCalled();
    expect(returnToOwner).not.toHaveBeenCalled();
  });

  it("shows the assisted respondent while answering and returns to the owner", () => {
    const returnToOwner = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          answerMode: "assisted",
          assistedParticipant: {
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: false,
            eligible: false,
          },
          returnToOwner,
        },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByText("回答者：代理回答者（代理回答）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    expect(returnToOwner).toHaveBeenCalledOnce();
  });

  it.each([
    ["status missing", null],
    ["participant missing", { participant: null, hasSubmission: false, eligible: false }],
  ])("uses a generic assisted identity at completion when %s", (_label, assistedParticipant) => {
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { answerMode: "assisted", assistedParticipant }),
    );
    render(<QuizRunner />);

    expect(screen.getByText("全5問の回答を記録しました。")).toBeInTheDocument();
    expect(screen.getByText("回答者：ほかの人（代理回答）")).toBeInTheDocument();
    expect(screen.queryByText("回答者：参加者（本人の回答）")).not.toBeInTheDocument();
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

      expect(screen.getByText("回答者：ほかの人（代理回答）")).toBeInTheDocument();
      expect(screen.queryByText("回答者：参加者（本人の回答）")).not.toBeInTheDocument();
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

    expect(screen.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeInTheDocument();
    expect(screen.getByLabelText("4桁PIN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再ログインする" })).toBeInTheDocument();
  });

  it("shows a server assisted-login message before the form has a local error", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        { assistedScreen: "login", assistedError: "ほかの人の回答状態を確認できませんでした。" },
      ),
    );
    render(<QuizRunner />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "ほかの人の回答状態を確認できませんでした。",
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
    fireEvent.submit(screen.getByLabelText("回答する人のお名前").closest("form")!);
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

    fireEvent.change(screen.getByLabelText("回答する人のお名前"), {
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
