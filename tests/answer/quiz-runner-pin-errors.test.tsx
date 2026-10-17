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

  it("normalizes PIN input, clears it during login, and prevents duplicate submissions while busy", async () => {
    let resolveLogin!: () => void;
    const pendingLogin = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login }),
    );
    render(<RunnerPage />);
    const name = screen.getByLabelText("受験者氏名");
    const pin = screen.getByLabelText("受験コード");
    fireEvent.change(name, { target: { value: "田中" } });
    fireEvent.change(pin, { target: { value: "0a12345" } });
    expect(pin).toHaveValue("0123");
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith("田中", "0123");
    expect(name).toHaveValue("田中");
    expect(pin).toHaveValue("");
    const busyButton = screen.getByRole("button", { name: "確認しています…" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    fireEvent.submit(pin.closest("form")!);
    expect(login).toHaveBeenCalledOnce();

    await act(async () => {
      resolveLogin();
      await pendingLogin;
    });
    expect(screen.getByRole("button", { name: "はじめる" })).toBeEnabled();
  });

  it("shows an ApiError retry time and marks the failed PIN invalid", async () => {
    const retryAt = "2030-06-01T12:30:00.000Z";
    const login = vi.fn().mockRejectedValue(
      new ApiError({
        status: 429,
        message: "PIN試行回数が上限です。",
        code: "RATE_LIMITED",
        retryAt,
      }),
    );
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login }),
    );
    render(<RunnerPage />);
    fireEvent.change(screen.getByLabelText("受験者氏名"), { target: { value: "田中" } });
    const pin = screen.getByLabelText("受験コード");
    fireEvent.change(pin, { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("PIN試行回数が上限です。");
    expect(alert).toHaveTextContent(new Date(retryAt).toLocaleString("ja-JP"));
    expect(pin).toHaveAttribute("aria-invalid", "true");
    expect(pin).toHaveValue("");
  });

  it("shows an authentication lookup message before any local form error", () => {
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "ready" },
        { access: { kind: "login", message: "参加状態を確認できませんでした。" } },
      ),
    );
    render(<RunnerPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("参加状態を確認できませんでした。");
    expect(screen.getByLabelText("受験者氏名")).toHaveAttribute(
      "aria-describedby",
      "participant-form-message",
    );
    expect(screen.getByLabelText("受験コード")).toHaveAttribute(
      "aria-describedby",
      "participant-pin-hint participant-form-message",
    );
  });

  it("shows API errors without retry times and falls back for non-Error login failures", async () => {
    const login = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({
          status: 401,
          message: "PINが正しくありません。",
          code: null,
          retryAt: null,
        }),
      )
      .mockRejectedValueOnce(
        new ApiError({
          status: 429,
          message: "再試行時間を確認できません。",
          code: "RATE_LIMITED",
          retryAt: "not-a-date",
        }),
      )
      .mockRejectedValueOnce("unknown failure");
    mockUseQuizSession.mockReturnValue(
      session({ kind: "ready" }, { access: { kind: "login" }, login }),
    );
    render(<RunnerPage />);
    fireEvent.change(screen.getByLabelText("受験者氏名"), { target: { value: "田中" } });
    fireEvent.change(screen.getByLabelText("受験コード"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PINが正しくありません。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("以降に再試行できます");

    fireEvent.change(screen.getByLabelText("受験コード"), { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("再試行時間を確認できません。"),
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("以降に再試行できます");

    fireEvent.change(screen.getByLabelText("受験コード"), { target: { value: "0000" } });
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "参加できませんでした。入力内容をご確認ください。",
      ),
    );
    expect(screen.getByLabelText("受験者氏名")).toHaveValue("田中");
    expect(screen.getByLabelText("受験コード")).toHaveValue("");
  });
});
