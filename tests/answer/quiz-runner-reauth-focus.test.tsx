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

  it("moves focus to the explicit retry action after successful reauthentication", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      phase = { kind: "checking-submission" };
      rerender(<RunnerPage />);
    });

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(retry);
  });

  it("keeps the retry focus handoff when focus remains inside the reauthentication form", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    const nameInput = screen.getByLabelText("お名前");
    nameInput.focus();
    expect(document.activeElement).toBe(nameInput);

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      phase = { kind: "checking-submission" };
      rerender(<RunnerPage />);
    });

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(retry);
  });

  it("keeps the retry focus handoff when the active element is disconnected", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    const disconnectedElement = document.createElement("input");
    expect(disconnectedElement.isConnected).toBe(false);
    const activeElementSpy = vi.spyOn(document, "activeElement", "get");
    activeElementSpy.mockReturnValue(disconnectedElement);

    try {
      await act(async () => {
        resolveLogin(7);
        await pendingLogin;
        access = { kind: "ready", participant: { id: 7, name: "参加者" } };
        phase = { kind: "checking-submission" };
        rerender(<RunnerPage />);
      });
    } finally {
      activeElementSpy.mockRestore();
    }

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(retry);
  });

  it("does not focus the retry action when reauthentication returns directly to answering", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    const phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(retry);
  });

  it("cancels the retry focus handoff when focus leaves the reauthentication form", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    const questionLink = screen.getByRole("link", { name: "第2問へ移動、回答済み" });
    questionLink.focus();
    expect(document.activeElement).toBe(questionLink);

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      phase = { kind: "checking-submission" };
      rerender(<RunnerPage />);
    });

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(retry);
  });

  it("cancels the retry focus handoff if focus moves after reauthentication succeeds", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        answeredCount: 5,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));

    await act(async () => {
      resolveLogin(7);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 7, name: "参加者" } };
      phase = { kind: "checking-submission" };
      rerender(<RunnerPage />);
    });

    const outsideTarget = document.getElementById("global-header-navigation");
    expect(outsideTarget).not.toBeNull();
    outsideTarget!.tabIndex = -1;
    outsideTarget!.focus();
    expect(document.activeElement).toBe(outsideTarget);

    await act(async () => {
      phase = { kind: "answering", retryRequired: true };
      rerender(<RunnerPage />);
    });

    const retry = screen.getByRole("button", { name: "同じ回答を再送する" });
    expect(retry).toBeEnabled();
    expect(document.activeElement).toBe(outsideTarget);
    expect(document.activeElement).not.toBe(retry);
  });

  it("does not focus the retry action when reauthentication switches participants", async () => {
    let resolveLogin!: (participantId: number) => void;
    const pendingLogin = new Promise<number>((resolve) => {
      resolveLogin = resolve;
    });
    let access: object = {
      kind: "reauthentication",
      participant: { id: 7, name: "参加者" },
    };
    let phase: object = { kind: "answering", retryRequired: true };
    let selections: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let answeredCount = 5;
    const login = vi.fn(() => pendingLogin);
    mockUseQuizSession.mockImplementation(() =>
      session(phase, {
        access,
        login,
        selections,
        answeredCount,
      }),
    );
    const { rerender } = render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      resolveLogin(8);
      await pendingLogin;
      access = { kind: "ready", participant: { id: 8, name: "別の参加者" } };
      phase = { kind: "ready" };
      selections = {};
      answeredCount = 0;
      rerender(<RunnerPage />);
    });

    expect(screen.getByRole("status")).toHaveTextContent("保存済みの回答状況を確認しています");
    expect(screen.queryByRole("button", { name: "同じ回答を再送する" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus to the retry action after failed reauthentication", async () => {
    const login = vi.fn().mockRejectedValue(new Error("login failed"));
    mockUseQuizSession.mockReturnValue(
      session(
        { kind: "answering", retryRequired: true },
        {
          access: { kind: "reauthentication", participant: { id: 7, name: "参加者" } },
          login,
        },
      ),
    );
    render(<RunnerPage />);

    fireEvent.change(screen.getByLabelText("4桁PIN"), { target: { value: "0123" } });
    fireEvent.click(screen.getByRole("button", { name: "再ログインする" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "再ログイン後に回答を確定する" });
    expect(retry).toBeDisabled();
    expect(document.activeElement).not.toBe(retry);
  });
});
