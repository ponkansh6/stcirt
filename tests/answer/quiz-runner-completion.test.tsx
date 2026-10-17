import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";
import GlobalHeader from "@/app/GlobalHeader";
import { ApiError } from "@/lib/api/client";

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

const visibleResultsPayload = {
  state: "visible",
  rank: 1,
  score: 1,
  questions: [{ position: 0, question: "設問", answer: { kind: "unanswered" } }],
};
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it("uses the saved-answer correction label when all five persisted answers are present", () => {
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          selections: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 0 },
          savedSelections: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 0 },
          answeredCount: 5,
          saveAnswers,
        },
      ),
    );
    render(<RunnerPage />);
    fireEvent.click(screen.getByRole("button", { name: "修正内容を確定する" }));
    expect(saveAnswers).toHaveBeenCalledOnce();
  });

  it("shows owner completion actions without a result link before publication is confirmed", () => {
    const editAnswers = vi.fn();
    const openAssistedLogin = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { editAnswers, openAssistedLogin }),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ホームへ" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代理回答を行う" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /公開状況/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "設問へ移動" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("回答を見直す場合は、同じ5問の回答を復元して修正できます。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/正解|不正解|合格|得点|正答率/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeDisabled();
    expect(
      screen.getByText("回答の公開状態を確認しています。確認できるまで編集はできません。"),
    ).toBeInTheDocument();
    expect(editAnswers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "代理回答を行う" }));
    expect(openAssistedLogin).toHaveBeenCalledOnce();
  });

  it("reopens a completed answer set for editing with its saved radio answer and neutral copy", async () => {
    const editAnswers = vi.fn();
    const saveAnswers = vi.fn();
    const savedSelections = { 1: 3, 2: 0, 3: 2, 4: 3, 5: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ resultsVisible: false }),
      }),
    );
    let currentSession = session(
      { kind: "complete" },
      {
        revision: 1,
        submissionId: "submission-1",
        savedSelections,
        editAnswers,
        saveAnswers,
      },
    );
    mockUseQuizSession.mockImplementation(() => currentSession);
    const { rerender } = render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "回答済み" })).toBeVisible();
    expect(screen.queryByText(/正解|不正解|合格|得点|正答率/)).not.toBeInTheDocument();
    const editButton = await screen.findByRole("button", { name: "回答を修正する" });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);
    expect(editAnswers).toHaveBeenCalledOnce();

    await act(async () => {
      currentSession = {
        ...currentSession,
        phase: { kind: "answering" },
        selections: { ...savedSelections },
        answeredCount: 5,
      };
      rerender(<RunnerPage />);
    });

    const firstQuestion = within(screen.getByRole("group", { name: /Question 1\?/ }));
    expect(firstQuestion.getByRole("radio", { name: /B1/ })).toBeChecked();
    expect(screen.queryByText(/正解|不正解|合格|得点|正答率/)).not.toBeInTheDocument();
    expect(saveAnswers).not.toHaveBeenCalled();
  });

  it.each([
    ["private results", { ok: true, status: 200, json: async () => ({ state: "waiting" }) }],
    ["unknown results", { ok: true, status: 200, json: async () => ({ state: "unknown" }) }],
    ["expired authentication", { ok: false, status: 401, json: async () => ({}) }],
  ])("hides result links for %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          assistedParticipant: {
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: false,
            eligible: false,
          },
        },
      ),
    );
    render(<RunnerPage />);

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "代理回答の結果を見る" })).not.toBeInTheDocument();
    });
  });

  it("does not require a publication lookup before a first revision can be submitted", () => {
    const saveAnswers = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, answeredCount: 5, saveAnswers },
      ),
    );
    render(<RunnerPage />);

    expect(fetchMock).not.toHaveBeenCalled();
    const submit = screen.getByRole("button", { name: "5問の回答を確定する" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(saveAnswers).toHaveBeenCalledOnce();
  });

  it("prioritizes reauthentication after completion while keeping correction secondary", async () => {
    const login = vi.fn(async () => 7);
    const editAnswers = vi.fn();
    const saveAnswers = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            String(input).includes("/api/answers/batch")
              ? { resultsVisible: false }
              : { state: "waiting" },
        }),
      ),
    );
    let currentSession = session(
      { kind: "complete" },
      {
        access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } },
        revision: 1,
        submissionId: "submission-1",
        login,
        editAnswers,
        saveAnswers,
      },
    );
    mockUseQuizSession.mockImplementation(() => currentSession);
    const { rerender } = render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    const reauthentication = screen.getByRole("region", {
      name: "参加状態の確認が必要です",
    });
    expect(within(reauthentication).getByRole("alert")).toHaveTextContent(
      "全5問の回答は記録されています",
    );
    expect(within(reauthentication).getByRole("alert")).toHaveTextContent(
      "回答は自動送信されません",
    );
    const reauthenticate = screen.getByRole("button", { name: "再ログインする" });
    const correctAnswers = screen.getByRole("button", { name: "回答を修正する" });
    expect(reauthenticate).toHaveClass("bg-primary");
    expect(correctAnswers).toHaveClass("border-2");
    expect(correctAnswers).toBeDisabled();
    expect(editAnswers).not.toHaveBeenCalled();
    expect(saveAnswers).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(reauthenticate);
    await waitFor(() => expect(login).toHaveBeenCalledWith("参加者", "0123"));
    expect(saveAnswers).not.toHaveBeenCalled();
    await act(async () => {
      currentSession = {
        ...currentSession,
        access: { kind: "ready", participant: { id: 7, name: "参加者" } },
      };
      rerender(<RunnerPage />);
    });
    const unlockedCorrection = await screen.findByRole("button", { name: "回答を修正する" });
    await waitFor(() => expect(unlockedCorrection).toBeEnabled());
    expect(saveAnswers).not.toHaveBeenCalled();
    fireEvent.click(unlockedCorrection);
    expect(editAnswers).toHaveBeenCalledOnce();
    expect(saveAnswers).not.toHaveBeenCalled();
  });

  it("provides a name-only assisted sign-in screen and returns to the owner's answers", () => {
    const startAssisted = vi.fn();
    const returnToOwner = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { assistedScreen: "login", startAssisted, returnToOwner }),
    );
    render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "代理回答" })).toBeInTheDocument();
    expect(screen.getByLabelText("回答する人のお名前")).toBeInTheDocument();
    expect(screen.queryByLabelText("4桁PIN")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("回答する人のお名前"), {
      target: { value: "代理回答者" },
    });
    fireEvent.click(screen.getByRole("button", { name: "回答をはじめる" }));
    expect(startAssisted).toHaveBeenCalledWith("代理回答者");
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    expect(returnToOwner).toHaveBeenCalledOnce();
  });

  it("explains that assisted answers were saved when reloading the owner fails", () => {
    const retrySubmissionCheck = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        {
          kind: "owner-return-error",
          message: "代理回答は保存されましたが、自分の回答状況を再読み込みできませんでした。",
        },
        { retrySubmissionCheck },
      ),
    );
    render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "代理回答を保存しました" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("代理回答は保存されました");
    fireEvent.click(screen.getByRole("button", { name: "自分の回答状況をもう一度確認する" }));
    expect(retrySubmissionCheck).toHaveBeenCalledOnce();
  });

  it("asks the owner to reauthenticate when recovery needs their session", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        {
          kind: "owner-return-error",
          message: "代理回答は保存されましたが、自分の回答状況を確認できませんでした。",
        },
        { access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } } },
      ),
    );
    render(<RunnerPage />);

    const reauthentication = screen.getByRole("region", {
      name: "参加状態の確認が必要です",
    });
    expect(
      within(reauthentication).getByRole("heading", {
        name: "参加状態の確認が必要です",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("お名前")).toHaveValue("参加者");
    expect(screen.getByLabelText("4桁PIN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "自分の回答状況をもう一度確認する" })).toBeDisabled();
  });

  it("offers correction of the saved assisted answer and a path back to the owner", async () => {
    const editAnswers = vi.fn();
    const returnToOwner = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            String(input).includes("/api/answers/batch")
              ? { resultsVisible: false }
              : visibleResultsPayload,
        }),
      ),
    );
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          answerMode: "assisted",
          revision: 1,
          submissionId: "assisted-submission-1",
          assistedParticipant: {
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: true,
            eligible: false,
          },
          editAnswers,
          returnToOwner,
        },
      ),
    );
    render(<RunnerPage />);

    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByText(/回答は完了しています。結果/)).not.toBeInTheDocument();
    const nameTerm = screen.getByRole("term");
    expect(nameTerm).toHaveTextContent("氏名");
    const nameField = nameTerm.closest("dl");
    expect(nameField).toBeInTheDocument();
    expect(within(nameField as HTMLElement).getByRole("definition")).toHaveTextContent(
      "代理回答者",
    );
    expect(screen.getByText("代理回答")).toBeInTheDocument();
    const ownerResultsLink = await screen.findByRole("link", { name: "自分の結果を見る" });
    expect(ownerResultsLink).toHaveAttribute("href", "/results");
    const assistedResultsLink = await screen.findByRole("link", {
      name: "代理回答の結果を見る",
    });
    expect(assistedResultsLink).toHaveAttribute("href", "/results?scope=assisted");
    const correctAnswers = await screen.findByRole("button", { name: "回答を修正する" });
    await waitFor(() => expect(correctAnswers).toBeEnabled());
    fireEvent.click(correctAnswers);
    expect(editAnswers).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    expect(returnToOwner).toHaveBeenCalledOnce();
  });

  it("keeps the assistant action beside published results without a manual status button", async () => {
    const editAnswers = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => visibleResultsPayload }),
    );
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }, { editAnswers }));

    render(<RunnerPage />);

    const resultLink = await screen.findByRole("link", { name: "自分の結果を見る" });
    expect(resultLink).toHaveAttribute("href", "/results");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /公開状況/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代理回答を行う" })).toBeInTheDocument();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeInTheDocument();
    expect(resultLink).toBeInTheDocument();
  });
});
