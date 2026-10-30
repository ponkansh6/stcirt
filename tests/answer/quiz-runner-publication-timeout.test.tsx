import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
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

  it("ends only the publication GET at its read timeout and keeps the state unknown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const rejectOnAbort = () => reject(new Error("aborted"));
          if (init?.signal?.aborted) rejectOnAbort();
          else init?.signal?.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);

    expect(
      screen.getByText("結果の公開状況を確認しています…", { exact: true }),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeInTheDocument();
    expect(screen.getByText(/確認できませんでした/)).toBeInTheDocument();
    expect(
      screen.queryByText("結果の公開状況を確認しています…", { exact: true }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toHaveProperty("aborted", true);
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
  });

  it("does not start another GET while an abort-ignoring request remains pending after timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pendingResult = deferred<Response>();
    const fetchMock = vi.fn(() => pendingResult.promise);
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    try {
      render(<RunnerPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "もう一度確認する" }));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeInTheDocument();
    } finally {
      await act(async () => {
        pendingResult.resolve({
          ok: true,
          status: 200,
          json: async () => ({ state: "waiting" }),
        } as Response);
        await pendingResult.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  });

  it("discards a participant-results response that arrives after its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pendingResult = deferred<Response>();
    const fetchMock = vi.fn(() => pendingResult.promise);
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    try {
      render(<RunnerPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeInTheDocument();

      await act(async () => {
        pendingResult.resolve({
          ok: true,
          status: 200,
          json: async () => ({ state: "waiting" }),
        } as Response);
        await pendingResult.promise;
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
      expect(screen.getByText(/確認できませんでした/)).toBeInTheDocument();
    } finally {
      await act(async () => {
        pendingResult.resolve({
          ok: false,
          status: 503,
          json: async () => ({}),
        } as Response);
        await pendingResult.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  });

  it("keeps a JSON body that resolves after the GET deadline unknown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pendingBody = deferred<{ state: string }>();
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => pendingBody.promise } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await act(async () => {
      pendingBody.resolve({ state: "waiting" });
      await pendingBody.promise;
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "もう一度確認する" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答を修正する" })).not.toBeInTheDocument();
  });

  it("exposes manual retry after an expired BFCache lookup and performs it once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
    let resultRequest = 0;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      resultRequest += 1;
      if (resultRequest === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);
    vi.clearAllTimers();
    vi.setSystemTime(Date.now() + 15_001);

    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    await act(async () => {
      window.dispatchEvent(pageShow);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const retry = screen.getByRole("button", { name: "もう一度確認する" });
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.getByText(/確認できませんでした/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toHaveProperty("aborted", true);
    expect(resultRequest).toBe(1);

    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resultRequest).toBe(2);
    expect(screen.getByRole("status")).toHaveTextContent("結果の公開状況を確認しました。");
    expect(resultRequest).toBe(2);
    expect(screen.queryByRole("button", { name: "もう一度確認する" })).not.toBeInTheDocument();
  });

  it("clears the GET deadline when a valid response settles just before timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pendingResult = deferred<Response>();
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, _init?: RequestInit) => pendingResult.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });

    await act(async () => {
      pendingResult.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      } as Response);
    });
    expect(screen.queryByRole("button", { name: "もう一度確認する" })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByRole("button", { name: "もう一度確認する" })).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "結果の公開状況を確認できませんでした。回答は再送せず、公開状況だけをもう一度確認できます。",
      ),
    ).not.toBeInTheDocument();
  });

  it("does not automatically restart a confirmed background GET after its timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const saveAnswers = vi.fn();
    let resultRequest = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      resultRequest += 1;
      if (resultRequest === 1) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }, { saveAnswers }));
    render(<RunnerPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    expect(resultRequest).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(resultRequest).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(resultRequest).toBe(2);
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "もう一度確認する" })).not.toBeInTheDocument();
    expect(screen.queryByText(/結果の公開状況を確認できませんでした/)).not.toBeInTheDocument();
    expect(saveAnswers).not.toHaveBeenCalled();
  });

  it("restarts one expired background GET on BFCache resume even if both resume events fire", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
    let resultRequest = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      resultRequest += 1;
      if (resultRequest === 1 || resultRequest === 3) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));
    render(<RunnerPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    expect(resultRequest).toBe(2);
    vi.clearAllTimers();
    vi.setSystemTime(Date.now() + 15_001);
    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    await act(async () => {
      window.dispatchEvent(pageShow);
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resultRequest).toBe(3);
    expect(screen.getByRole("heading", { name: "回答済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "もう一度確認する" })).not.toBeInTheDocument();
  });
});
