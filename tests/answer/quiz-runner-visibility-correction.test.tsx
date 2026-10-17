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
    vi.restoreAllMocks();
    if (visibilityStateDescriptor) {
      Object.defineProperty(document, "visibilityState", visibilityStateDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("shows the assisted result link only after the target has submitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => visibleResultsPayload,
      }),
    );
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

    expect(await screen.findByRole("link", { name: "自分の結果を見る" })).toHaveAttribute(
      "href",
      "/results",
    );
    expect(screen.queryByRole("link", { name: "代理回答の結果を見る" })).not.toBeInTheDocument();
  });

  it("fails closed while a saved submission visibility lookup is pending, then unlocks only on confirmation", async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const select = vi.fn();
    const saveAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          revision: 1,
          submissionId: "submission-1",
          selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          answeredCount: 5,
          select,
          saveAnswers,
        },
      ),
    );
    render(<RunnerPage />);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/answers/batch?submissionId=submission-1",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(
      screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "5問の回答を確定する" })).toBeDisabled();
    expect(screen.getByText(/確認できるまで編集はできません/)).toBeVisible();
    expect(select).not.toHaveBeenCalled();
    expect(saveAnswers).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ resultsVisible: false }) });
      await pending.promise;
    });
    await waitFor(() =>
      expect(
        screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).disabled),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "5問の回答を確定する" })).toBeEnabled();
  });

  it.each([
    ["lookup failure", { ok: false, json: async () => ({}) }],
    ["malformed visibility", { ok: true, json: async () => ({ resultsVisible: "false" }) }],
    ["null visibility payload", { ok: true, json: async () => null }],
  ])("keeps saved answers locked after a %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          revision: 2,
          submissionId: "submission-2",
          selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          answeredCount: 5,
        },
      ),
    );
    render(<RunnerPage />);
    await waitFor(() => expect(screen.getByText(/確認できるまで編集はできません/)).toBeVisible());
    expect(
      screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled),
    ).toBe(true);
    expect(screen.getAllByRole("radio")[0]).toBeChecked();
    expect(screen.getByRole("button", { name: "5問の回答を確定する" })).toBeDisabled();
  });

  it("locks a saved submission only after a confirmed visible response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ resultsVisible: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ resultsVisible: false }) });
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { revision: 1, submissionId: "submission-3", selections: { 1: 0 } },
      ),
    );
    render(<RunnerPage />);
    expect(await screen.findByText(/結果が公開されているため、回答を修正できません/)).toBeVisible();
    expect(
      screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled),
    ).toBe(true);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).disabled),
      ).toBe(true),
    );
  });

  it("locks correction on the completed page after visibility is confirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ resultsVisible: true }),
      }),
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "complete" }, { revision: 1, submissionId: "submission-complete" }),
    );

    render(<RunnerPage />);

    expect(await screen.findByText(/結果が公開されているため、回答は修正できません/)).toBeVisible();
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeDisabled();
  });

  it("skips interval refreshes while a visibility request is pending", async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    let intervalCallback: (() => void) | undefined;
    const intervalHandle = window.setInterval(() => {}, 60_000);
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      intervalCallback = handler as () => void;
      // The test's window handle is numeric, while Vitest uses Node's Timeout type here.
      return intervalHandle as unknown as ReturnType<typeof setInterval>;
    });
    mockUseQuizSession.mockReturnValue(
      session({ kind: "answering" }, { revision: 1, submissionId: "submission-pending" }),
    );

    render(<RunnerPage />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(intervalCallback).toBeDefined();
    act(() => intervalCallback?.());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ resultsVisible: false }) });
      await pending.promise;
    });
  });

  it("ignores a visibility response that arrives after the effect becomes inactive", async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    const clearPublishedLock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { revision: 1, submissionId: "submission-inactive-fetch", clearPublishedLock },
      ),
    );
    const { rerender } = render(<RunnerPage />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          access: { kind: "checking" },
          revision: 1,
          submissionId: "submission-inactive-fetch",
          clearPublishedLock,
        },
      ),
    );
    rerender(<RunnerPage />);
    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ resultsVisible: false }) });
      await pending.promise;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clearPublishedLock).not.toHaveBeenCalled();
  });

  it("ignores visibility JSON that resolves after the effect becomes inactive", async () => {
    const pendingJson = deferred<unknown>();
    const json = vi.fn(() => pendingJson.promise);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json });
    const clearPublishedLock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { revision: 1, submissionId: "submission-inactive-json", clearPublishedLock },
      ),
    );
    const { rerender } = render(<RunnerPage />);
    await waitFor(() => expect(json).toHaveBeenCalledOnce());

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          access: { kind: "checking" },
          revision: 1,
          submissionId: "submission-inactive-json",
          clearPublishedLock,
        },
      ),
    );
    rerender(<RunnerPage />);
    await act(async () => {
      pendingJson.resolve({ resultsVisible: false });
      await pendingJson.promise;
    });

    expect(clearPublishedLock).not.toHaveBeenCalled();
  });

  it("does not update visibility state when an inactive request rejects", async () => {
    let rejectRequest!: (error: Error) => void;
    const pending = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(
      (_resolve, reject) => {
        rejectRequest = reject;
      },
    );
    const fetchMock = vi.fn().mockReturnValue(pending);
    const clearPublishedLock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        { revision: 1, submissionId: "submission-inactive-error", clearPublishedLock },
      ),
    );
    const { rerender } = render(<RunnerPage />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering" },
        {
          access: { kind: "checking" },
          revision: 1,
          submissionId: "submission-inactive-error",
          clearPublishedLock,
        },
      ),
    );
    rerender(<RunnerPage />);
    await act(async () => {
      rejectRequest(new Error("request failed"));
      await pending.catch(() => undefined);
    });

    expect(clearPublishedLock).not.toHaveBeenCalled();
  });

  it("queues one tab-return refresh and ignores the stale in-flight completion response", async () => {
    const firstResponse = deferred<{ ok: boolean; json: () => Promise<{ state: string }> }>();
    const secondResponse = deferred<{ ok: boolean; json: () => Promise<{ state: string }> }>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    mockUseQuizSession.mockReturnValue(session({ kind: "complete" }));

    render(<RunnerPage />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstResponse.resolve({ ok: true, json: async () => visibleResultsPayload });
      await firstResponse.promise;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();

    await act(async () => {
      secondResponse.resolve({ ok: true, json: async () => ({ state: "waiting" }) });
      await secondResponse.promise;
    });
    expect(screen.queryByRole("link", { name: "自分の結果を見る" })).not.toBeInTheDocument();
  });

  it("keeps correction disabled when saved answers could not be restored", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "complete" },
        {
          restoreError: "保存済み回答と現在の設問が一致しないため、回答を復元できません。",
        },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("回答を復元できません");
    expect(screen.getByRole("button", { name: "回答を修正する" })).toBeDisabled();
  });

  it("preserves the draft and provides explicit controls after save conflict or saved-answer refresh failure", () => {
    const refreshSavedAnswers = vi.fn();
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", message: "状態を再確認してください。", refreshRequired: true },
        { selections: { 1: 1 }, answeredCount: 1, refreshSavedAnswers },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("回答案は保持しています");
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "保存済み回答を再確認する" }));
    expect(refreshSavedAnswers).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "保存済み回答を再確認してください" })).toBeDisabled();
  });
});
