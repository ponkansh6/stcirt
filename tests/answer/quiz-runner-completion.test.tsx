import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
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

const visibleResultsPayload = {
  state: "visible",
  rank: 1,
  isAggregationTarget: true,
  participantCount: 1,
  score: 1,
  maxScore: 1,
  questions: [{ position: 0, question: "設問", answer: { kind: "unanswered" } }],
};
const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it("shows only publication loading until the first valid result response", async () => {
    const editAnswers = vi.fn();
    const openAssistedLogin = vi.fn();
    const pendingResult = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/api/answers/batch")
          ? Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ resultsVisible: false }),
            })
          : pendingResult.promise,
      ),
    );
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        { editAnswers, openAssistedLogin, revision: 1, submissionId: "submission-1" },
      ),
    );
    render(<RunnerPage />);
    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "回答済み" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "代理回答を行う" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    expect(editAnswers).not.toHaveBeenCalled();

    await act(async () => {
      pendingResult.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });

    expect(
      screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "代理回答を行う" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "代理回答を行う" }));
    expect(openAssistedLogin).toHaveBeenCalledOnce();
  });

  it.each(["visible", "unavailable"] as const)(
    "hides correction on the first completion render for %s results while the batch check is pending",
    async (state) => {
      const pendingBatch = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) =>
          String(input).includes("/api/answers/batch")
            ? pendingBatch.promise
            : Promise.resolve({
                ok: true,
                status: 200,
                json: async () => (state === "visible" ? visibleResultsPayload : { state }),
              }),
        ),
      );
      mockUseQuizSession.mockReturnValue(
        session({ kind: "complete" }, { revision: 1, submissionId: "submission-1" }),
      );

      render(<RunnerPage />);

      expect(await screen.findByRole("heading", { name: "回答済み" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
      expect(
        screen.queryByText("披露宴までは修正ボタンから回答の変更が可能です。"),
      ).not.toBeInTheDocument();

      await act(async () => {
        pendingBatch.resolve({
          ok: true,
          status: 200,
          json: async () => ({ resultsVisible: true }),
        } as Response);
      });
      expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    },
  );

  it("does not restore correction when an unlocked batch response arrives after publication", async () => {
    const pendingBatch = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/api/answers/batch")
          ? pendingBatch.promise
          : Promise.resolve({
              ok: true,
              status: 200,
              json: async () => visibleResultsPayload,
            }),
      ),
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { revision: 1, submissionId: "submission-1" }),
    );

    render(<RunnerPage />);

    expect(await screen.findByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    await act(async () => {
      pendingBatch.resolve({
        ok: true,
        status: 200,
        json: async () => ({ resultsVisible: false }),
      } as Response);
    });
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("披露宴までは修正ボタンから回答の変更が可能です。"),
    ).not.toBeInTheDocument();
  });

  it.each(["visible", "unavailable"] as const)(
    "does not show correction when the batch check unlocks before %s results arrive",
    async (state) => {
      const pendingResult = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) =>
          String(input).includes("/api/answers/batch")
            ? Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ resultsVisible: false }),
              })
            : pendingResult.promise,
        ),
      );
      mockUseQuizSession.mockReturnValue(
        session({ kind: "complete" }, { revision: 1, submissionId: "submission-1" }),
      );

      render(<RunnerPage />);

      expect(
        screen.getByText("結果の公開状況を確認しています…", { exact: true }),
      ).toBeInTheDocument();
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await act(async () => {
        pendingResult.resolve({
          ok: true,
          status: 200,
          json: async () => (state === "visible" ? visibleResultsPayload : { state }),
        } as Response);
      });

      expect(await screen.findByRole("heading", { name: "回答済み" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    },
  );

  it("shows correction only after waiting results and an unlocked batch response are confirmed", async () => {
    const pendingBatch = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/api/answers/batch")
          ? pendingBatch.promise
          : Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ state: "waiting" }),
            }),
      ),
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { revision: 1, submissionId: "submission-1" }),
    );

    render(<RunnerPage />);

    expect(await screen.findByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("披露宴までは修正ボタンから回答の変更が可能です。"),
    ).not.toBeInTheDocument();

    await act(async () => {
      pendingBatch.resolve({
        ok: true,
        status: 200,
        json: async () => ({ resultsVisible: false }),
      } as Response);
    });
    expect(await screen.findByRole("button", { name: "回答を修正する" })).toBeInTheDocument();
    expect(
      screen.getByText("披露宴までは修正ボタンから回答の変更が可能です。"),
    ).toBeInTheDocument();
  });

  it("keeps completion visible without correction when the batch visibility request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/api/answers/batch")
          ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
          : Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ state: "waiting" }),
            }),
      ),
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { revision: 1, submissionId: "submission-1" }),
    );

    render(<RunnerPage />);

    expect(await screen.findByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
  });

  it("keeps a new assisted answer available while waiting is confirmed and the batch check is unknown", async () => {
    const pendingResult = deferred<Response>();
    const pendingBatch = deferred<Response>();
    const openAssistedLogin = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/api/answers/batch") ? pendingBatch.promise : pendingResult.promise,
      ),
    );
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          revision: 1,
          submissionId: "submission-1",
          openAssistedLogin,
        },
      ),
    );

    render(<RunnerPage />);

    await act(async () => {
      pendingResult.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });
    const assistedButton = await screen.findByRole("button", { name: "代理回答を行う" });
    expect(assistedButton).toBeInTheDocument();
    fireEvent.click(assistedButton);
    expect(openAssistedLogin).toHaveBeenCalledOnce();

    await act(async () => {
      // A refresh is not part of the completion flow; resolve the deferred batch to leave no request pending.
      pendingBatch.resolve({
        ok: true,
        status: 200,
        json: async () => ({ resultsVisible: false }),
      } as Response);
    });
  });

  it.each(["visible", "unavailable"] as const)(
    "hides the new assisted answer action for %s results",
    async (state) => {
      const openAssistedLogin = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) =>
          String(input).includes("/api/answers/batch")
            ? Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ resultsVisible: false }),
              })
            : Promise.resolve({
                ok: true,
                status: 200,
                json: async () => (state === "visible" ? visibleResultsPayload : { state }),
              }),
        ),
      );
      mockUseQuizSession.mockReturnValue(
        session(
          { kind: "complete" },
          {
            revision: 1,
            submissionId: "submission-1",
            assistedParticipant: {
              participant: { id: 18, name: "代理回答者" },
              hasSubmission: false,
              eligible: false,
            },
            openAssistedLogin,
          },
        ),
      );

      render(<RunnerPage />);

      expect(await screen.findByRole("heading", { name: "回答済み" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "代理回答を行う" })).not.toBeInTheDocument();
    },
  );

  it("keeps an existing assisted answer disabled while its batch visibility is unknown", async () => {
    const pendingBatch = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/api/answers/batch")
          ? pendingBatch.promise
          : Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ state: "waiting" }),
            }),
      ),
    );
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          revision: 1,
          submissionId: "assisted-submission-1",
          assistedParticipant: {
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: true,
            eligible: false,
          },
        },
      ),
    );

    render(<RunnerPage />);

    const assistedButton = await screen.findByRole("button", { name: "代理回答を修正する" });
    expect(assistedButton).toBeDisabled();
    await act(async () => {
      pendingBatch.resolve({
        ok: true,
        status: 200,
        json: async () => ({ resultsVisible: true }),
      } as Response);
    });
    expect(screen.queryByRole("button", { name: "代理回答を修正する" })).not.toBeInTheDocument();
  });

  it("reopens a completed answer set for editing with its saved radio answer and neutral copy", async () => {
    const editAnswers = vi.fn();
    const saveAnswers = vi.fn();
    const savedSelections = { 1: 3, 2: 0, 3: 2, 4: 3, 5: 0 };
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
        revision: 1,
        submissionId: "submission-1",
        savedSelections,
        editAnswers,
        saveAnswers,
      },
    );
    mockUseQuizSession.mockImplementation(() => currentSession);
    const { rerender } = render(<RunnerPage />);

    expect(await screen.findByRole("heading", { name: "回答済み" })).toBeVisible();
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
    [
      "unavailable results",
      { ok: true, status: 200, json: async () => ({ state: "unavailable" }) },
    ],
    ["unknown results", { ok: true, status: 200, json: async () => ({ state: "unknown" }) }],
    ["temporary server error", { ok: false, status: 503, json: async () => ({}) }],
    ["expired authentication", { ok: false, status: 401, json: async () => ({}) }],
  ])("handles %s publication response", async (_label, response) => {
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
    if (_label === "private results" || _label === "unavailable results") {
      expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
      expect(
        screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
      ).not.toBeInTheDocument();
    } else if (_label === "unknown results") {
      expect(
        screen.getByText("結果の公開状況を確認しています…", { exact: true }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "回答済み" })).not.toBeInTheDocument();
    } else if (_label === "expired authentication") {
      expect(screen.getByRole("region", { name: "参加状態の確認が必要です" })).toBeInTheDocument();
      expect(
        screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
      ).not.toBeInTheDocument();
    } else {
      expect(
        screen.getByText("結果の公開状況を確認しています…", { exact: true }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "回答済み" })).not.toBeInTheDocument();
    }
  });

  it("ignores a delayed publication response after owner scope changes to assisted", async () => {
    const ownerResult = deferred<Response>();
    const assistedResult = deferred<Response>();
    let resultRequest = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes("/api/answers/batch")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ resultsVisible: false }),
          });
        }
        resultRequest += 1;
        return resultRequest === 1 ? ownerResult.promise : assistedResult.promise;
      }),
    );
    let currentSession = session({ kind: "complete" });
    mockUseQuizSession.mockImplementation(() => currentSession);
    const { rerender } = render(<RunnerPage />);

    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    await act(async () => {
      currentSession = {
        ...currentSession,
        answerMode: "assisted",
        access: { kind: "ready", participant: { id: 7, name: "参加者" } },
      };
      rerender(<RunnerPage />);
    });
    expect(resultRequest).toBe(2);

    await act(async () => {
      ownerResult.resolve({
        ok: true,
        status: 200,
        json: async () => visibleResultsPayload,
      } as Response);
    });
    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();

    await act(async () => {
      assistedResult.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });
    expect(
      screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
  });

  it("does not reuse a confirmed CTA after ready reauthentication and return to ready", async () => {
    const pendingAfterReauthentication = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => visibleResultsPayload })
      .mockImplementationOnce(() => pendingAfterReauthentication.promise);
    vi.stubGlobal("fetch", fetchMock);
    const completePhase = { kind: "complete" };
    let currentSession = session(completePhase);
    mockUseQuizSession.mockImplementation(() => currentSession);
    const { rerender } = render(<RunnerPage />);

    expect(await screen.findByRole("link", { name: "自分の結果を見る" })).toBeInTheDocument();
    await act(async () => {
      currentSession = {
        ...currentSession,
        access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } },
      };
      rerender(<RunnerPage />);
    });
    expect(screen.getByRole("region", { name: "参加状態の確認が必要です" })).toBeInTheDocument();

    await act(async () => {
      currentSession = {
        ...currentSession,
        access: { kind: "ready", participant: { id: 7, name: "参加者" } },
      };
      rerender(<RunnerPage />);
    });
    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();

    await act(async () => {
      pendingAfterReauthentication.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });
    expect(
      screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
  });

  it("retries publication lookup after form authentication recovers a results API 401", async () => {
    const pendingAfterLogin = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockImplementationOnce(() => pendingAfterLogin.promise);
    vi.stubGlobal("fetch", fetchMock);
    const login = vi.fn(async () => 7);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }, { login }));
    render(<RunnerPage />);

    const reauthentication = await screen.findByRole("region", {
      name: "参加状態の確認が必要です",
    });
    fireEvent.change(within(reauthentication).getByLabelText("4桁PIN"), {
      target: { value: "0123" },
    });
    fireEvent.click(within(reauthentication).getByRole("button", { name: "再ログインする" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("参加者", "0123"));

    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole("region", { name: "参加状態の確認が必要です" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      pendingAfterLogin.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });
    expect(
      screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
  });

  it("does not let a late response from an earlier completion interval confirm the next one", async () => {
    const firstCompletionResult = deferred<Response>();
    const secondCompletionResult = deferred<Response>();
    let resultRequest = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        resultRequest += 1;
        return resultRequest === 1 ? firstCompletionResult.promise : secondCompletionResult.promise;
      }),
    );
    const completePhase = { kind: "complete" };
    let currentSession = session(completePhase);
    mockUseQuizSession.mockImplementation(() => currentSession);
    const { rerender } = render(<RunnerPage />);

    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    await act(async () => {
      currentSession = { ...currentSession, phase: { kind: "answering" } };
      rerender(<RunnerPage />);
    });
    await act(async () => {
      currentSession = { ...currentSession, phase: completePhase };
      rerender(<RunnerPage />);
    });
    expect(resultRequest).toBe(2);
    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();

    await act(async () => {
      firstCompletionResult.resolve({
        ok: true,
        status: 200,
        json: async () => visibleResultsPayload,
      } as Response);
    });
    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();

    await act(async () => {
      secondCompletionResult.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });
    expect(
      screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
  });

  it("keeps the initial completion surface in loading after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));

    render(<RunnerPage />);

    await waitFor(() => {
      expect(
        screen.getByText("結果の公開状況を確認しています…", { exact: true }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "回答済み" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "代理回答を行う" })).not.toBeInTheDocument();
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
    expect(reauthenticate).toHaveClass("bg-primary");
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("本来回答する人のお名前")).toBeInTheDocument();
    expect(screen.queryByLabelText("4桁PIN")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("本来回答する人のお名前"), {
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

    expect(await screen.findByRole("heading", { name: "回答済み" })).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
    expect(editAnswers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "自分の回答に戻る" }));
    expect(returnToOwner).toHaveBeenCalledOnce();
  });

  it("hides the assisted answer action for published results without a manual status button", async () => {
    const editAnswers = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => visibleResultsPayload })
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) }),
    );
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }, { editAnswers }));

    render(<RunnerPage />);

    const resultLink = await screen.findByRole("link", { name: "自分の結果を見る" });
    expect(resultLink).toHaveAttribute("href", "/results");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /公開状況/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "代理回答を行う" })).not.toBeInTheDocument();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "代理回答を行う" })).not.toBeInTheDocument();
    expect(resultLink).toBeInTheDocument();
  });
});
