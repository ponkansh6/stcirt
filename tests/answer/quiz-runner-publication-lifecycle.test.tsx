import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import QuizRunner from "@/app/answer/quiz-runner";
import GlobalHeader from "@/app/GlobalHeader";
import { useParticipantResultsVisibility } from "@/app/answer/use-participant-results-visibility";

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
const completePhase = { kind: "complete" } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function publicationFetchMock(responses: Array<unknown>) {
  return vi.fn((input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/answers/batch")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ resultsVisible: false }),
      });
    }
    return Promise.resolve(responses.shift() ?? { ok: false, status: 503, json: async () => ({}) });
  });
}

function publicationRequestCount(fetchMock: ReturnType<typeof publicationFetchMock>) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).startsWith("/api/participants/results"),
  ).length;
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
    revision: 0,
    submissionId: null,
    answeredCount: 0,
    restoreError: null,
    saveConfirmed: (phase as { kind?: string }).kind === "complete",
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

function ParticipantResultsProbe({
  onRetry,
  participantId = 7,
}: {
  onRetry: (retry: () => void) => void;
  participantId?: number;
}) {
  const visibility = useParticipantResultsVisibility(
    completePhase,
    { kind: "ready", participant: { id: participantId, name: "参加者" } },
    "owner",
  );
  onRetry(visibility.retry);
  return <div data-testid="lookup-status">{visibility.lookupStatus}</div>;
}

describe("QuizRunner publication lookup lifecycle", () => {
  beforeEach(() => mockUseQuizSession.mockReset());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (visibilityStateDescriptor) {
      Object.defineProperty(document, "visibilityState", visibilityStateDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("ignores non-persisted pageshow and suppresses resume retry after an initial error", async () => {
    const fetchMock = publicationFetchMock([{ ok: false, status: 503, json: async () => ({}) }]);
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);
    await screen.findByRole("button", { name: "もう一度確認する" });

    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: false });
    window.dispatchEvent(pageShow);
    const persistedPageShow = new Event("pageshow");
    Object.defineProperty(persistedPageShow, "persisted", { value: true });
    window.dispatchEvent(persistedPageShow);

    expect(publicationRequestCount(fetchMock)).toBe(1);
    expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeInTheDocument();
  });

  it("does not start a publication retry while the lookup is not in error", async () => {
    const initialResponse = deferred<Response>();
    const fetchMock = vi.fn(() => initialResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const retryRef: { current: (() => void) | null } = { current: null };
    const captureRetry = (currentRetry: () => void) => {
      retryRef.current = currentRetry;
    };
    const response = {
      ok: true,
      status: 200,
      json: async () => ({ state: "waiting" }),
    } as Response;

    try {
      await act(async () => {
        render(<ParticipantResultsProbe onRetry={captureRetry} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(screen.getByTestId("lookup-status")).toHaveTextContent("pending");
      retryRef.current?.();
      expect(fetchMock).toHaveBeenCalledOnce();

      await act(async () => {
        initialResponse.resolve(response);
        await initialResponse.promise;
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId("lookup-status")).toHaveTextContent("settled");
      retryRef.current?.();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        initialResponse.resolve(response);
        await initialResponse.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  });

  it("keeps the current scope controller when an older request settles late", async () => {
    const oldResponse = deferred<Response>();
    const currentResponse = deferred<Response>();
    const requestSignals: AbortSignal[] = [];
    let requestCount = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignals.push(init?.signal as AbortSignal);
      requestCount += 1;
      return requestCount === 1 ? oldResponse.promise : currentResponse.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    const view = render(<ParticipantResultsProbe onRetry={onRetry} />);

    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requestCount).toBe(1);

      await act(async () => {
        view.rerender(<ParticipantResultsProbe onRetry={onRetry} participantId={8} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requestCount).toBe(2);
      expect(requestSignals[0]).toHaveProperty("aborted", true);
      const currentSignal = requestSignals[1];
      expect(currentSignal).toBeDefined();
      expect(currentSignal).toHaveProperty("aborted", false);

      await act(async () => {
        oldResponse.resolve({
          ok: true,
          status: 200,
          json: async () => ({ state: "visible" }),
        } as Response);
        await oldResponse.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requestSignals[1]).toHaveProperty("aborted", false);
    } finally {
      view.unmount();
      if (requestSignals[1]) expect(requestSignals[1]).toHaveProperty("aborted", true);
      await act(async () => {
        oldResponse.resolve({
          ok: true,
          status: 200,
          json: async () => ({ state: "waiting" }),
        } as Response);
        currentResponse.resolve({
          ok: true,
          status: 200,
          json: async () => ({ state: "waiting" }),
        } as Response);
        await Promise.all([oldResponse.promise, currentResponse.promise]);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  });

  it("keeps confirmed publication state quiet after a background refresh failure", async () => {
    const saveAnswers = vi.fn();
    let resultRequest = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/answers/batch")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ resultsVisible: false }),
        });
      }
      resultRequest += 1;
      return resultRequest === 1
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) })
        : Promise.reject(new Error("offline"));
    });
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { saveAnswers, revision: 1, submissionId: "submission-1" }),
    );
    render(<RunnerPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "回答を修正する" })).toBeInTheDocument(),
    );
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(resultRequest).toBe(2));

    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "もう一度確認する" })).not.toBeInTheDocument();
    expect(screen.queryByText(/結果の公開状況を確認できませんでした/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeInTheDocument();
    expect(saveAnswers).not.toHaveBeenCalled();
  });

  it("queues one refresh when visibility and BFCache resume happen during a confirmed GET", async () => {
    const pendingRefresh = deferred<Response>();
    let resultRequest = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/answers/batch")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ resultsVisible: false }),
        });
      }
      resultRequest += 1;
      if (resultRequest === 2) return pendingRefresh.promise;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { revision: 1, submissionId: "submission-1" }),
    );
    render(<RunnerPage />);
    await waitFor(() => expect(publicationRequestCount(fetchMock)).toBe(1));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(publicationRequestCount(fetchMock)).toBe(2));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    fireEvent(document, new Event("visibilitychange"));
    expect(publicationRequestCount(fetchMock)).toBe(2);

    await act(async () => {
      pendingRefresh.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });

    await waitFor(() => expect(publicationRequestCount(fetchMock)).toBe(3));
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "もう一度確認する" })).not.toBeInTheDocument();
  });

  it("starts one visibility refresh on persisted pageshow after a result is confirmed", async () => {
    const pendingRefresh = deferred<Response>();
    let resultRequest = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/answers/batch")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ resultsVisible: false }),
        });
      }
      resultRequest += 1;
      if (resultRequest === 1) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
      }
      return pendingRefresh.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);

    await waitFor(() => expect(resultRequest).toBe(1));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await waitFor(() => expect(resultRequest).toBe(2));
    expect(resultRequest).toBe(2);

    await act(async () => {
      pendingRefresh.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
      await pendingRefresh.promise;
    });
    expect(resultRequest).toBe(2);
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
  });
});
