import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireParticipantReauthentication,
  useQuizSession,
  type AccessState,
} from "@/app/answer/use-quiz-session";
import {
  ApiError as ApiErrorClass,
  type AnswerSubmission,
  type AssistedParticipantState,
  type Participant,
} from "@/lib/api/client";

const api = vi.hoisted(() => ({
  createParticipantSession: vi.fn(),
  deleteParticipantSession: vi.fn(),
  fetchAnswerBootstrap: vi.fn(),
  fetchAnswerSubmission: vi.fn(),
  fetchAssistedParticipant: vi.fn(),
  fetchExamQuestions: vi.fn(),
  fetchLatestAnswerSubmission: vi.fn(),
  fetchParticipantSession: vi.fn(),
  createAssistedParticipant: vi.fn(),
  submitAnswerBatch: vi.fn(),
}));

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, ...api };
});

const participant: Participant = { id: 7, name: "参加者" };
const otherParticipant: Participant = { id: 8, name: "別の参加者" };
const assistedParticipant: Participant = { id: 18, name: "代理回答者" };
const submissionId = "00000000-0000-4000-8000-000000000001";

describe("requireParticipantReauthentication", () => {
  it("requires reauthentication for the owner whose request failed", () => {
    const current: AccessState = { kind: "ready", participant };

    const next = requireParticipantReauthentication(current, participant.id);

    expect(next).toEqual({ kind: "reauthentication", participant });
    expect(next).not.toBe(current);
    if (next.kind === "reauthentication") expect(next.participant).toBe(participant);
  });

  it("does not expire a different participant's ready session", () => {
    const current: AccessState = { kind: "ready", participant: otherParticipant };

    expect(requireParticipantReauthentication(current, participant.id)).toBe(current);
  });

  it.each([
    ["checking", { kind: "checking" }],
    ["login", { kind: "login", message: "another login is in progress" }],
    ["switching", { kind: "switching", participant }],
    ["reauthentication", { kind: "reauthentication", participant }],
  ] as const)("preserves the current %s state", (_label, current) => {
    expect(requireParticipantReauthentication(current, participant.id)).toBe(current);
  });
});

const question = (id: number, answerType: "selected" | "freeText" = "selected") => ({
  id,
  question: `Question ${id}`,
  choices: answerType === "freeText" ? [] : ["A", "B", "C", "D"],
  answerType,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const apiError = (status: number, message: string) =>
  new ApiErrorClass({ status, message, code: null, retryAt: null });

function makeSubmission(overrides: Partial<AnswerSubmission> = {}): AnswerSubmission {
  const answers =
    overrides.answers ??
    [1, 2, 3, 4, 5].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: 0,
      freeText: null,
    }));
  const questionTypes = new Map(
    answers
      .filter((answer) => answer.questionId === 5 && answer.answerKind !== "selected")
      .map(({ questionId }) => [questionId, "freeText" as const]),
  );
  return {
    submissionId,
    revision: 1,
    restoreIntegrity: {
      status: "complete",
      questions: [1, 2, 3, 4, 5].map((id) => ({
        id,
        answerType: (questionTypes.get(id) ?? "selected") as "selected" | "freeText",
        choiceCount: questionTypes.has(id) ? 0 : 4,
      })),
    },
    answers,
    ...overrides,
  };
}

function makeBootstrap(
  mode: "owner" | "assisted" = "owner",
  submission: AnswerSubmission | null = null,
  freeTextFifth = false,
  ownerOverride: Participant = participant,
) {
  return {
    mode,
    owner: ownerOverride,
    participant: mode === "assisted" ? assistedParticipant : ownerOverride,
    submission,
    ...(submission === null
      ? {
          questions: [1, 2, 3, 4, 5].map((id) =>
            question(id, freeTextFifth && id === 5 ? "freeText" : "selected"),
          ),
        }
      : {}),
  };
}

async function enterAnswering(
  options: {
    latest?: AnswerSubmission | null;
    freeTextFifth?: boolean;
  } = {},
  expectedPhase: "answering" | "complete" = "answering",
) {
  api.fetchParticipantSession.mockResolvedValue(participant);
  api.fetchLatestAnswerSubmission.mockResolvedValue(options.latest ?? null);
  api.fetchAnswerBootstrap.mockResolvedValue(
    makeBootstrap("owner", options.latest ?? null, options.freeTextFifth),
  );
  api.fetchExamQuestions.mockResolvedValue(
    [1, 2, 3, 4, 5].map((id) =>
      question(id, options.freeTextFifth && id === 5 ? "freeText" : "selected"),
    ),
  );
  const hook = renderHook(() => useQuizSession());
  await waitFor(() => expect(hook.result.current.phase.kind).toBe(expectedPhase));
  return hook;
}

async function enterOwnerComplete() {
  api.fetchParticipantSession.mockResolvedValue(participant);
  api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
  const hook = renderHook(() => useQuizSession());
  await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
  await waitFor(() => expect(api.fetchAssistedParticipant).toHaveBeenCalledOnce());
  return hook;
}

type TestAssistedDraft = {
  schemaVersion: number;
  expiresAt: number;
  participantId: number;
  quizzes: {
    question: ReturnType<typeof question>;
    shuffled: { choices: string[]; choiceIndices: number[] };
  }[];
  selections: Record<number, number>;
  freeResponses: Record<number, string>;
  legacyAnswerIds: number[];
  submissionId: string;
  revision: number;
};

function makeAssistedDraft(overrides: Partial<TestAssistedDraft> = {}): TestAssistedDraft {
  const quizzes = [1, 2, 3, 4, 5].map((id) => {
    const item = question(id);
    return {
      question: item,
      shuffled: { choices: item.choices, choiceIndices: [0, 1, 2, 3] },
    };
  });
  return {
    schemaVersion: 1,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    participantId: assistedParticipant.id,
    quizzes,
    selections: { 1: 2 },
    freeResponses: {},
    legacyAnswerIds: [],
    submissionId: "00000000-0000-4000-8000-000000000018",
    revision: 2,
    ...overrides,
  };
}

function makeCurrentAssistedDraft(): TestAssistedDraft {
  const draft = makeAssistedDraft();
  return {
    ...draft,
    quizzes: draft.quizzes.map((quiz, index) =>
      index === 4
        ? {
            ...quiz,
            question: { ...quiz.question, answerType: "freeText" as const, choices: [] },
            shuffled: { choices: [], choiceIndices: [] },
          }
        : quiz,
    ),
    freeResponses: { 5: "Q5 response" },
  };
}

async function enterRefreshRequired(freeTextFifth = false) {
  const hook = await enterAnswering({ freeTextFifth });
  [1, 2, 3, 4].forEach((id) => act(() => hook.result.current.select(id, 0)));
  if (freeTextFifth) {
    act(() => hook.result.current.setFreeResponse(5, "draft"));
  } else {
    act(() => hook.result.current.select(5, 0));
  }
  api.submitAnswerBatch.mockRejectedValueOnce(apiError(409, "conflict"));
  api.fetchAnswerSubmission.mockRejectedValueOnce(new Error("could not reconcile"));
  await act(async () => hook.result.current.saveAnswers());
  return hook;
}

describe("useQuizSession state transitions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.sessionStorage.clear();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(submissionId);
    api.fetchParticipantSession.mockResolvedValue(null);
    api.fetchAnswerBootstrap.mockImplementation(async (mode: "owner" | "assisted") =>
      makeBootstrap(mode),
    );
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: null,
      hasSubmission: false,
      eligible: true,
    } satisfies AssistedParticipantState);
    api.createAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
    });
    api.fetchLatestAnswerSubmission.mockResolvedValue(null);
    api.fetchExamQuestions.mockResolvedValue([1, 2, 3, 4, 5].map((id) => question(id)));
    api.createParticipantSession.mockResolvedValue({ participant });
    api.deleteParticipantSession.mockResolvedValue(undefined);
    api.submitAnswerBatch.mockResolvedValue({ submissionId, revision: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("moves to login after a session lookup failure and exposes the original login error", async () => {
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.fetchParticipantSession.mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    expect(hook.result.current.access).toMatchObject({
      kind: "login",
      message: expect.any(String),
    });

    api.createParticipantSession.mockRejectedValueOnce(new Error("PINが違います"));
    await act(async () =>
      expect(hook.result.current.login("参加者", "0000")).rejects.toThrow("PINが違います"),
    );
    expect(hook.result.current.access).toMatchObject({ kind: "login", message: "PINが違います" });
  });

  it("drains participant-session lookup completion after unmount", async () => {
    const pending = deferred<Participant | null>();
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.fetchParticipantSession.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchParticipantSession).toHaveBeenCalledOnce());
    hook.unmount();
    pending.resolve(participant);
    await act(async () => pending.promise);
  });

  it("drains participant-session lookup failure after unmount", async () => {
    const pending = deferred<Participant | null>();
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.fetchParticipantSession.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchParticipantSession).toHaveBeenCalledOnce());
    hook.unmount();
    pending.reject(new Error("offline"));
    await act(async () => {
      await expect(pending.promise).rejects.toThrow("offline");
    });
  });

  it("drains a failed question load after unmount", async () => {
    const pendingQuestion = deferred<ReturnType<typeof question>[]>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("offline"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestion.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(api.fetchExamQuestions).toHaveBeenCalledOnce());
    hook.unmount();
    pendingQuestion.reject(new Error("offline"));
    await act(async () => {
      await expect(pendingQuestion.promise).rejects.toThrow("offline");
      await Promise.resolve();
    });
  });

  it("does not apply a successful login after unmount", async () => {
    const pending = deferred<{ participant: Participant }>();
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.createParticipantSession.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    let loggingIn!: Promise<number>;
    act(() => {
      loggingIn = hook.result.current.login("参加者", "1234");
    });
    hook.unmount();
    pending.resolve({ participant });
    await act(async () => {
      await expect(loggingIn).resolves.toBe(participant.id);
    });
    expect(api.createParticipantSession).toHaveBeenCalledOnce();
  });

  it("does not apply a failed login after unmount", async () => {
    const pending = deferred<{ participant: Participant }>();
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.createParticipantSession.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    let loggingIn!: Promise<number>;
    act(() => {
      loggingIn = hook.result.current.login("参加者", "1234");
    });
    hook.unmount();
    pending.reject(new Error("offline"));
    await act(async () => {
      await expect(loggingIn).rejects.toThrow("offline");
    });
  });

  it("uses the fallback login message for non-Error failures", async () => {
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    api.createParticipantSession.mockRejectedValueOnce({ reason: "offline" });
    await act(async () => {
      await expect(hook.result.current.login("参加者", "1234")).rejects.toEqual({
        reason: "offline",
      });
    });
    expect(hook.result.current.access).toMatchObject({
      kind: "login",
      message: "参加できませんでした。",
    });
  });

  it("ignores save and refresh requests while logged out without a submission", async () => {
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    expect(hook.result.current.submissionId).toBeNull();
    const phaseBefore = hook.result.current.phase;

    await act(async () => {
      await hook.result.current.saveAnswers();
      await hook.result.current.refreshSavedAnswers();
    });

    expect(api.submitAnswerBatch).not.toHaveBeenCalled();
    expect(api.fetchAnswerSubmission).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toEqual(phaseBefore);
  });

  it("loads a resumed submission, preserves revision, and supports correction and edit", async () => {
    const hook = await enterAnswering({ latest: makeSubmission() }, "complete");
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.revision).toBe(1);
    expect(hook.result.current.answeredCount).toBe(0);
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    await act(async () => hook.result.current.editAnswers(() => true));
    expect(api.fetchExamQuestions).toHaveBeenCalledOnce();
    expect(hook.result.current.phase.kind).toBe("answering");
    expect(Object.keys(hook.result.current.selections)).toHaveLength(5);
  });

  it("does not load an edit while participant switching is in progress", async () => {
    const hook = await enterAnswering({ latest: makeSubmission() }, "complete");
    const deletion = deferred<void>();
    api.deleteParticipantSession.mockReturnValueOnce(deletion.promise);
    let switching!: Promise<void>;
    act(() => {
      switching = hook.result.current.switchParticipant();
    });
    await waitFor(() => expect(hook.result.current.access.kind).toBe("switching"));

    await act(async () => hook.result.current.editAnswers(() => true));

    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    expect(hook.result.current.isPreparingEdit).toBe(false);
    deletion.resolve();
    await act(async () => switching);
  });

  it("restores free-text and legacy answers without counting legacy text as answered", async () => {
    const answers: AnswerSubmission["answers"] = [1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: 0,
      freeText: null,
    }));
    answers.push({
      questionId: 5,
      answerKind: "legacy" as const,
      selectedIndex: 2,
      freeText: null,
    });
    const hook = await enterAnswering(
      {
        latest: makeSubmission({ answers }),
        freeTextFifth: true,
      },
      "complete",
    );

    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    await act(async () => hook.result.current.editAnswers(() => true));
    expect(hook.result.current.legacyAnswerIds).toEqual([5]);
    expect(hook.result.current.freeResponses).toEqual({});
    expect(hook.result.current.answeredCount).toBe(4);
  });

  it("restores valid free text and includes it in the answered count", async () => {
    const answers: AnswerSubmission["answers"] = [1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: 0,
      freeText: null,
    }));
    answers.push({
      questionId: 5,
      answerKind: "freeText" as const,
      selectedIndex: null,
      freeText: "保存済みの記述回答",
    });
    const hook = await enterAnswering(
      {
        latest: makeSubmission({ answers }),
        freeTextFifth: true,
      },
      "complete",
    );

    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    await act(async () => hook.result.current.editAnswers(() => true));
    expect(hook.result.current.freeResponses).toEqual({ 5: "保存済みの記述回答" });
    expect(hook.result.current.answeredCount).toBe(5);
  });

  it("loads the complete ordered exam from one bootstrap without a separate batch call", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", null));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(api.fetchAnswerBootstrap).toHaveBeenCalledWith("owner");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    expect(hook.result.current.quizzes.map(({ question: item }) => item.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("falls back from a missing assisted target to owner bootstrap questions", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    api.fetchAnswerBootstrap
      .mockRejectedValueOnce(apiError(404, "assisted participant not found"))
      .mockResolvedValueOnce(makeBootstrap("owner"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.answerMode).toBe("owner");
    expect(hook.result.current.quizzes.map(({ question: item }) => item.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(1, "assisted");
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");
    expect(api.fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("ignores an initial owner bootstrap success after unmount", async () => {
    const pendingBootstrap = deferred<ReturnType<typeof makeBootstrap>>();
    api.fetchAnswerBootstrap.mockReturnValueOnce(pendingBootstrap.promise);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchAnswerBootstrap).toHaveBeenCalledOnce());
    const accessBeforeUnmount = hook.result.current.access;
    const phaseBeforeUnmount = hook.result.current.phase;
    hook.unmount();
    pendingBootstrap.resolve(makeBootstrap("owner"));
    await act(async () => pendingBootstrap.promise);

    expect(hook.result.current.access).toEqual(accessBeforeUnmount);
    expect(hook.result.current.phase).toEqual(phaseBeforeUnmount);
  });

  it("ignores owner fallback bootstrap success after an assisted saved submission when unmounted", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    const pendingOwnerBootstrap = deferred<ReturnType<typeof makeBootstrap>>();
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(makeBootstrap("assisted", makeSubmission()))
      .mockReturnValueOnce(pendingOwnerBootstrap.promise);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchAnswerBootstrap).toHaveBeenCalledTimes(2));
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(1, "assisted");
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");
    const accessBeforeUnmount = hook.result.current.access;
    const phaseBeforeUnmount = hook.result.current.phase;
    hook.unmount();
    pendingOwnerBootstrap.resolve(makeBootstrap("owner"));
    await act(async () => pendingOwnerBootstrap.promise);

    expect(hook.result.current.access).toEqual(accessBeforeUnmount);
    expect(hook.result.current.phase).toEqual(phaseBeforeUnmount);
    expect(api.fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it.each([
    { label: "partial", questions: [question(1), question(2), question(3), question(4)] },
    {
      label: "duplicate",
      questions: [question(1), question(2), question(2), question(4), question(5)],
    },
    {
      label: "out of order",
      questions: [question(2), question(1), question(3), question(4), question(5)],
    },
  ])(
    "does not start an exam from a $label batch and offers a working retry",
    async ({ questions }) => {
      api.fetchParticipantSession.mockResolvedValueOnce(participant);
      api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("offline"));
      api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
      api.fetchExamQuestions
        .mockResolvedValueOnce(questions)
        .mockResolvedValueOnce([1, 2, 3, 4, 5].map((id) => question(id)));

      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
      act(() => hook.result.current.retrySubmissionCheck());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));
      expect(hook.result.current.quizzes).toEqual([]);
      act(() => hook.result.current.retryLoad());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
      expect(hook.result.current.quizzes.map(({ question: item }) => item.id)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(api.fetchExamQuestions).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { label: "partial", questions: [question(1), question(2), question(3), question(4)] },
    {
      label: "duplicate",
      questions: [question(1), question(2), question(2), question(4), question(5)],
    },
    {
      label: "out of order",
      questions: [question(2), question(1), question(3), question(4), question(5)],
    },
  ])(
    "keeps a saved attempt locked when edit receives an invalid $label exam batch",
    async ({ questions }) => {
      api.fetchParticipantSession.mockResolvedValueOnce(participant);
      api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
      api.fetchExamQuestions
        .mockResolvedValueOnce(questions)
        .mockResolvedValueOnce([1, 2, 3, 4, 5].map((id) => question(id)));
      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

      await act(async () => hook.result.current.editAnswers(() => true));

      expect(hook.result.current.phase.kind).toBe("complete");
      expect(hook.result.current.editLoadError).toContain("設問を読み込めませんでした");
      expect(hook.result.current.saveConfirmed).toBe(true);
      expect(hook.result.current.selections).toEqual({});

      await act(async () => hook.result.current.retryEdit(() => true));

      expect(hook.result.current.phase.kind).toBe("answering");
      expect(hook.result.current.editLoadError).toBeNull();
      expect(Object.keys(hook.result.current.selections)).toHaveLength(5);
      expect(api.fetchExamQuestions).toHaveBeenCalledTimes(2);
    },
  );

  it("marks a saved submission unrestorable when its questions are unavailable", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", makeSubmission({ restoreIntegrity: { status: "invalid" } })),
    );
    api.fetchExamQuestions.mockResolvedValueOnce([]);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(hook.result.current.restoreError).toContain("整合性を確認できません");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("does not restore or edit a saved answer set whose current question manifest changed", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.fetchExamQuestions.mockResolvedValueOnce([11, 12, 13, 14, 15].map((id) => question(id)));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();

    await act(async () => hook.result.current.editAnswers(() => true));

    expect(api.fetchExamQuestions).toHaveBeenCalledOnce();
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
    expect(hook.result.current.saveConfirmed).toBe(false);
  });

  it("does not fetch questions unless the current visibility gate is unlocked", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    await act(async () => hook.result.current.editAnswers(() => false));

    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.saveConfirmed).toBe(true);
  });

  it("rechecks the live visibility gate before applying a loaded correction", async () => {
    const pendingQuestions = deferred<ReturnType<typeof question>[]>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestions.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    let canEdit = true;
    let edit!: Promise<void>;
    act(() => {
      edit = hook.result.current.editAnswers(() => canEdit);
    });
    await waitFor(() => expect(hook.result.current.isPreparingEdit).toBe(true));
    canEdit = false;
    pendingQuestions.resolve([1, 2, 3, 4, 5].map((id) => question(id)));
    await act(async () => edit);

    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.selections).toEqual({});
    expect(hook.result.current.saveConfirmed).toBe(true);
    expect(hook.result.current.isPreparingEdit).toBe(false);
  });

  it("loads saved correction questions once when edit is requested more than once", async () => {
    const pendingQuestions = deferred<ReturnType<typeof question>[]>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestions.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    let firstEdit!: Promise<void>;
    let secondEdit!: Promise<void>;
    act(() => {
      firstEdit = hook.result.current.editAnswers(() => true);
      secondEdit = hook.result.current.editAnswers(() => true);
    });
    await waitFor(() => expect(hook.result.current.isPreparingEdit).toBe(true));
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(api.fetchExamQuestions).toHaveBeenCalledOnce();
    pendingQuestions.resolve([1, 2, 3, 4, 5].map((id) => question(id)));
    await act(async () => {
      await firstEdit;
      await secondEdit;
    });
    expect(hook.result.current.phase.kind).toBe("answering");
    expect(hook.result.current.isPreparingEdit).toBe(false);
  });

  it("lets the participant retry a failed deferred question load", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.fetchExamQuestions
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([1, 2, 3, 4, 5].map((id) => question(id)));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    await act(async () => hook.result.current.editAnswers(() => true));
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.editLoadError).toBeTruthy();
    expect(hook.result.current.saveConfirmed).toBe(true);

    await act(async () => hook.result.current.retryEdit(() => true));

    expect(api.fetchExamQuestions).toHaveBeenCalledTimes(2);
    expect(hook.result.current.phase.kind).toBe("answering");
    expect(hook.result.current.editLoadError).toBeNull();
  });

  it("ignores edit retries when no correction load has failed", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    act(() => hook.result.current.retryEdit(() => true));

    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.saveConfirmed).toBe(true);
  });

  it("discards a deferred edit failure after switching away from its participant", async () => {
    const pendingQuestions = deferred<ReturnType<typeof question>[]>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestions.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    let oldEdit!: Promise<void>;
    act(() => {
      oldEdit = hook.result.current.editAnswers(() => true);
    });
    await waitFor(() => expect(hook.result.current.isPreparingEdit).toBe(true));
    await act(async () => hook.result.current.switchParticipant());
    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.phase.kind).toBe("ready");

    pendingQuestions.reject(new Error("late response"));
    await act(async () => oldEdit);

    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.phase.kind).toBe("ready");
    expect(hook.result.current.quizzes).toEqual([]);
    expect(hook.result.current.editLoadError).toBeNull();
    expect(hook.result.current.isPreparingEdit).toBe(false);
  });

  it("retries a failed load from the already loaded questions", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("offline"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
    api.fetchExamQuestions
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([1, 2, 3, 4, 5].map((id) => question(id)));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));
    act(() => hook.result.current.retryLoad());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.quizzes).toHaveLength(5);
  });

  it("blocks correction after retry finds a saved submission without restore integrity", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("bootstrap offline"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    const { restoreIntegrity: _restoreIntegrity, ...submissionWithoutIntegrity } = makeSubmission();
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(submissionWithoutIntegrity);

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    expect(hook.result.current.restoreError).toContain("保存済み回答の整合性を確認できません");
    expect(hook.result.current.selections).toEqual({});
    expect(hook.result.current.saveConfirmed).toBe(false);
  });

  it("requires reauthentication when retrying the latest lookup returns 401", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("bootstrap offline"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    api.fetchLatestAnswerSubmission.mockRejectedValueOnce(apiError(401, "expired"));

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));

    expect(hook.result.current.phase.kind).toBe("ready");
    expect(hook.result.current.access).toEqual({ kind: "reauthentication", participant });
  });

  it.each([
    ["HTTP 403", apiError(403, "forbidden")],
    ["a network error", new Error("offline")],
  ])(
    "keeps the submission check retryable when latest lookup returns %s",
    async (_label, error) => {
      api.fetchParticipantSession.mockResolvedValueOnce(participant);
      api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("bootstrap offline"));
      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
      api.fetchLatestAnswerSubmission.mockRejectedValueOnce(error);

      act(() => hook.result.current.retrySubmissionCheck());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

      expect(hook.result.current.access).toEqual({ kind: "ready", participant });
      expect(hook.result.current.phase).toMatchObject({
        kind: "submission-error",
        message: "回答状況を確認できませんでした。通信状態を確認して再試行してください。",
      });
    },
  );

  it("ignores repeated load retries while the first retry is pending", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("offline"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
    api.fetchExamQuestions.mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));

    const pending = deferred<ReturnType<typeof question>[]>();
    api.fetchExamQuestions.mockReturnValueOnce(pending.promise);
    const callsBeforeRetry = api.fetchExamQuestions.mock.calls.length;
    act(() => {
      hook.result.current.retryLoad();
      hook.result.current.retryLoad();
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("loading"));
    expect(api.fetchExamQuestions).toHaveBeenCalledTimes(callsBeforeRetry + 1);

    pending.resolve([1, 2, 3, 4, 5].map((id) => question(id)));
    await act(async () => {
      await pending.promise;
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
  });

  it("requires reauthentication after bootstrap authorization expires, then retries submission checks", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));
    expect(hook.result.current.access).toEqual({ kind: "reauthentication", participant });

    api.createParticipantSession.mockResolvedValueOnce({ participant });
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    api.fetchLatestAnswerSubmission.mockRejectedValueOnce(new Error("offline"));
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
  });

  it("purges the assisted draft and requests reauthentication when assisted bootstrap returns 401", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify(makeCurrentAssistedDraft()),
    );
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));

    expect(hook.result.current.phase.kind).toBe("ready");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("preserves the assisted draft and keeps bootstrap 403 retryable", async () => {
    const draft = makeCurrentAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

    expect(hook.result.current.access).toEqual({ kind: "ready", participant });
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.selections).toEqual(draft.selections);
  });

  it("keeps an assisted draft and blocks attempt startup after a malformed successful lookup", async () => {
    const draft = makeCurrentAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockRejectedValueOnce(
      new Error("Invalid response schema for fetch answer bootstrap"),
    );

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

    expect(hook.result.current.access).toEqual({ kind: "ready", participant });
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).not.toBeNull();
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.selections).toEqual(draft.selections);
    expect(hook.result.current.freeResponses).toEqual(draft.freeResponses);
  });

  it("retains the assisted draft for recovery while rejecting invalid saved integrity", async () => {
    const draft = makeCurrentAssistedDraft();
    const invalidSaved = makeSubmission({
      submissionId: draft.submissionId,
      revision: draft.revision,
      restoreIntegrity: { status: "invalid" },
    });
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted", invalidSaved));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    expect(hook.result.current.restoreError).toContain("整合性を確認できません");
    expect(hook.result.current.autoEditAssisted).toBe(false);
    expect(hook.result.current.saveConfirmed).toBe(false);
    expect(hook.result.current.selections).toEqual({});
    expect(hook.result.current.quizzes).toEqual([]);
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
    await act(async () => hook.result.current.editAnswers(() => true));
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.selections).toEqual({});
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("ignores repeated submission-check retries while the lookup is pending", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    const pending = deferred<AnswerSubmission | null>();
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("checking-submission"));
    act(() => hook.result.current.retrySubmissionCheck());
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce();
    pending.resolve(null);
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
  });

  it("keeps the new-epoch save lock when an old retry question load settles", async () => {
    const oldQuestions = deferred<ReturnType<typeof question>[]>();
    const newSave = deferred<{ submissionId: string; revision: number }>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("temporary bootstrap failure"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
    api.fetchExamQuestions.mockReturnValueOnce(oldQuestions.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(api.fetchExamQuestions).toHaveBeenCalledOnce());

    await act(async () => hook.result.current.switchParticipant());
    expect(hook.result.current.access.kind).toBe("login");
    api.createParticipantSession.mockResolvedValueOnce({ participant: otherParticipant });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", null, false, otherParticipant),
    );
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockReturnValueOnce(newSave.promise);
    let save!: Promise<void>;
    act(() => {
      save = hook.result.current.saveAnswers();
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submitting"));

    await act(async () => {
      oldQuestions.resolve([1, 2, 3, 4, 5].map((id) => question(id)));
      await oldQuestions.promise;
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submitting"));
    await act(async () => hook.result.current.saveAnswers());
    expect(api.submitAnswerBatch).toHaveBeenCalledOnce();
    expect(hook.result.current.phase.kind).toBe("submitting");

    await act(async () => {
      newSave.resolve({ submissionId, revision: 1 });
      await save;
    });
    expect(hook.result.current.phase.kind).toBe("complete");
  });

  it("does not start an owner resolver while assisted retry lookup is pending", async () => {
    const hook = await enterOwnerComplete();
    await act(async () => hook.result.current.startAssisted("代理回答者"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    const pendingLatest = deferred<AnswerSubmission | null>();
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pendingLatest.promise);
    const bootstrapCallsBeforeRetry = api.fetchAnswerBootstrap.mock.calls.length;

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("checking-submission"));
    act(() => hook.result.current.returnToOwner());

    expect(hook.result.current.answerMode).toBe("owner");
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce();
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCallsBeforeRetry);
    pendingLatest.resolve(null);
    await act(async () => pendingLatest.promise);
  });

  it("ignores a retry lookup result after unmount", async () => {
    const hook = await enterAnswering();
    const pendingLatest = deferred<AnswerSubmission | null>();
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pendingLatest.promise);
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("checking-submission"));
    const accessBeforeUnmount = hook.result.current.access;
    const phaseBeforeUnmount = hook.result.current.phase;
    hook.unmount();

    pendingLatest.resolve(makeSubmission());
    await act(async () => {
      await pendingLatest.promise;
      await Promise.resolve();
    });

    expect(hook.result.current.access).toEqual(accessBeforeUnmount);
    expect(hook.result.current.phase).toEqual(phaseBeforeUnmount);
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("ignores participant resolution while a submission check is already in flight", async () => {
    const pendingBootstrap = deferred<ReturnType<typeof makeBootstrap>>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockReturnValueOnce(pendingBootstrap.promise);
    api.fetchAnswerBootstrap.mockResolvedValueOnce({
      ...makeBootstrap("owner"),
      owner: otherParticipant,
      participant: otherParticipant,
    });
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchAnswerBootstrap).toHaveBeenCalledOnce());

    api.createParticipantSession.mockResolvedValueOnce({ participant: otherParticipant });
    await act(async () => hook.result.current.login("別の参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.access).toMatchObject({
        kind: "ready",
        participant: otherParticipant,
      }),
    );
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledTimes(2);
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(1, "owner");
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");

    hook.unmount();
    pendingBootstrap.resolve(makeBootstrap("owner"));
    await act(async () => {
      await pendingBootstrap.promise;
      await Promise.resolve();
    });
  });

  it("requires reauthentication after bootstrap authorization expires", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));
    expect(hook.result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(hook.result.current.phase.kind).toBe("ready");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    act(() => hook.result.current.retrySubmissionCheck());
    expect(api.fetchLatestAnswerSubmission).not.toHaveBeenCalled();
  });

  it("drains a successful submission response after unmount", async () => {
    const submit = deferred<{ submissionId: string; revision: number }>();
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockReturnValueOnce(submit.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.saveAnswers();
    });
    hook.unmount();
    submit.resolve({ submissionId, revision: 1 });
    await act(async () => saving);
  });

  it("stops question loading when the pending question resolves after unmount", async () => {
    const pendingQuestion = deferred<ReturnType<typeof question>[]>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("offline"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestion.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(api.fetchExamQuestions).toHaveBeenCalledOnce());
    hook.unmount();
    pendingQuestion.resolve([1, 2, 3, 4, 5].map((id) => question(id)));
    await act(async () => {
      await pendingQuestion.promise;
      // Let loadQuestions observe the completed batch after unmount.
      await Promise.resolve();
    });
    expect(api.fetchExamQuestions).toHaveBeenCalledOnce();
  });

  it("stops submission lookup updates after unmount", async () => {
    const pending = deferred<ReturnType<typeof makeBootstrap>>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchAnswerBootstrap).toHaveBeenCalledOnce());
    hook.unmount();
    pending.resolve(makeBootstrap("owner"));
    await act(async () => {
      await pending.promise;
      // Let resolveParticipant finish its post-fetch mounted check.
      await Promise.resolve();
    });
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("does not update state when submission lookup rejects after unmount", async () => {
    const pending = deferred<ReturnType<typeof makeBootstrap>>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchAnswerBootstrap).toHaveBeenCalledOnce());
    hook.unmount();
    pending.reject(new Error("offline"));
    await act(async () => {
      await expect(pending.promise).rejects.toThrow("offline");
      // Let resolveParticipant finish its post-rejection mounted check.
      await Promise.resolve();
    });
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("drains saved-submission question loading after unmount", async () => {
    const pendingQuestion = deferred<ReturnType<typeof question>[]>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestion.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    let editPromise!: Promise<void>;
    act(() => {
      editPromise = hook.result.current.editAnswers(() => true);
    });
    await waitFor(() => expect(api.fetchExamQuestions).toHaveBeenCalledOnce());
    hook.unmount();
    pendingQuestion.resolve([1, 2, 3, 4, 5].map((id) => question(id)));
    await act(async () => {
      await pendingQuestion.promise;
      await editPromise;
      await Promise.resolve();
    });
  });

  it("does not save incomplete answers, and saves a selected and free-text batch", async () => {
    const hook = await enterAnswering({ freeTextFifth: true });
    await act(async () => hook.result.current.saveAnswers());
    expect(api.submitAnswerBatch).not.toHaveBeenCalled();
    [1, 2, 3, 4].forEach((id) => act(() => hook.result.current.select(id, 0)));
    act(() => hook.result.current.setFreeResponse(5, "  written answer  "));
    expect(hook.result.current.answeredCount).toBe(5);
    await act(async () => hook.result.current.saveAnswers());
    expect(api.submitAnswerBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId,
        answers: expect.arrayContaining([{ questionId: 5, freeText: "written answer" }]),
      }),
      "owner",
    );
    expect(hook.result.current.phase.kind).toBe("complete");
  });

  it("ignores save reentry and selection changes while a save is pending", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    const pending = deferred<{ submissionId: string; revision: number }>();
    api.submitAnswerBatch.mockReturnValueOnce(pending.promise);
    let firstSave!: Promise<void>;
    act(() => {
      firstSave = hook.result.current.saveAnswers();
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submitting"));
    await act(async () => hook.result.current.saveAnswers());
    const latestLookupCount = api.fetchLatestAnswerSubmission.mock.calls.length;
    act(() => hook.result.current.retrySubmissionCheck());
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledTimes(latestLookupCount);
    act(() => hook.result.current.select(1, 2));
    expect(api.submitAnswerBatch).toHaveBeenCalledOnce();
    expect(hook.result.current.selections[1]).toBe(0);
    pending.resolve({ submissionId, revision: 1 });
    await act(async () => firstSave);
    expect(hook.result.current.phase.kind).toBe("complete");
  });

  it("does not reauthenticate a participant while switching", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    const pendingSave = deferred<{ submissionId: string; revision: number }>();
    const pendingDeletion = deferred<void>();
    api.submitAnswerBatch.mockReturnValueOnce(pendingSave.promise);
    api.deleteParticipantSession.mockReturnValueOnce(pendingDeletion.promise);
    let saving!: Promise<void>;
    let switching!: Promise<void>;
    act(() => {
      saving = hook.result.current.saveAnswers();
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submitting"));
    act(() => {
      switching = hook.result.current.switchParticipant();
    });
    await waitFor(() => expect(hook.result.current.access.kind).toBe("switching"));

    pendingSave.reject(apiError(401, "expired"));
    await act(async () => saving);
    expect(hook.result.current.access.kind).toBe("switching");
    expect(hook.result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });

    pendingDeletion.resolve();
    await act(async () => switching);
    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.phase.kind).toBe("ready");
  });

  it("uses the fallback message and marks non-Error save failures retryable", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce({ reason: "unknown" });
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.phase).toMatchObject({
      kind: "answering",
      retryRequired: true,
      message: "回答を保存できませんでした。入力内容を保持しています。",
    });
  });

  it("does not require retry for a definitive client-side save error", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(400, "invalid"));
    await act(async () => hook.result.current.saveAnswers());
    const phase = hook.result.current.phase;
    expect(phase).toMatchObject({ kind: "answering", message: "invalid" });
    if (phase.kind !== "answering") throw new Error("Expected answering phase");
    expect(phase.retryRequired).toBeFalsy();
  });

  it("counts a saved free response when a selected answer is changed", async () => {
    const hook = await enterAnswering({ freeTextFifth: true });
    act(() => hook.result.current.setFreeResponse(5, "記述回答"));
    act(() => hook.result.current.select(1, 2));
    expect(hook.result.current.answeredCount).toBe(2);
  });

  it("requires retry after an uncertain save and reuses the operation for the same draft", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(new Error("connection lost"));
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    const firstOperationId = api.submitAnswerBatch.mock.calls[0]![0].operationId;
    api.submitAnswerBatch.mockResolvedValueOnce({ submissionId, revision: 1 });
    await act(async () => hook.result.current.saveAnswers());
    expect(api.submitAnswerBatch.mock.calls[1]![0].operationId).toBe(firstOperationId);
    expect(hook.result.current.phase.kind).toBe("complete");
  });

  it("resumes the same participant's draft after reauthentication", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());
    const operationId = api.submitAnswerBatch.mock.calls[0]![0].operationId;
    expect(hook.result.current.access.kind).toBe("reauthentication");

    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", makeSubmission({ revision: 0 })),
    );
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.phase).toMatchObject({
        kind: "answering",
        retryRequired: true,
      }),
    );
    api.submitAnswerBatch.mockResolvedValueOnce({ submissionId, revision: 1 });
    await act(async () => hook.result.current.saveAnswers());
    expect(api.submitAnswerBatch.mock.calls[1]![0].operationId).toBe(operationId);
  });

  it("requires a saved-answer refresh when the same participant's revision advanced", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());
    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", makeSubmission({ revision: 2 })),
    );
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.phase).toMatchObject({
        kind: "answering",
        refreshRequired: true,
      }),
    );
    act(() => hook.result.current.select(1, 1));
    expect(hook.result.current.selections[1]).toBe(0);
    api.fetchAnswerSubmission.mockResolvedValueOnce(makeSubmission({ revision: 2 }));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.revision).toBe(2);
    expect(hook.result.current.phase.kind).toBe("answering");
  });

  it("keeps the retry draft when reauthentication finds no persisted submission", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());
    const questionCallCount = api.fetchExamQuestions.mock.calls.length;
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", null));
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.phase).toMatchObject({
        kind: "answering",
        retryRequired: true,
      }),
    );
    expect(hook.result.current.selections).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(api.fetchExamQuestions).toHaveBeenCalledTimes(questionCallCount);
  });

  it("resumes a reauthenticated draft without a retry message when no submission exists", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());

    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", makeSubmission({ revision: 2 })),
    );
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.phase).toMatchObject({
        kind: "answering",
        refreshRequired: true,
      }),
    );

    api.fetchAnswerSubmission.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.access.kind).toBe("reauthentication");
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", null));
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    const phase = hook.result.current.phase;
    expect(phase.kind).toBe("answering");
    if (phase.kind !== "answering") throw new Error("Expected answering phase");
    expect(phase.retryRequired).toBeFalsy();
    expect(phase.message).toBeUndefined();
  });

  it("resumes without a retry message when the saved revision is unchanged", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());

    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", makeSubmission({ revision: 2 })),
    );
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.phase).toMatchObject({
        kind: "answering",
        refreshRequired: true,
      }),
    );

    api.fetchAnswerSubmission.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.refreshSavedAnswers());
    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", makeSubmission({ revision: 2 })),
    );
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    const phase = hook.result.current.phase;
    expect(phase.kind).toBe("answering");
    if (phase.kind !== "answering") throw new Error("Expected answering phase");
    expect(phase.retryRequired).toBeFalsy();
    expect(phase.message).toBeUndefined();
  });

  it("does not allow edits while a retry is required", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(new Error("unknown result"));
    await act(async () => hook.result.current.saveAnswers());
    const firstId = api.submitAnswerBatch.mock.calls[0]![0].operationId;
    act(() => hook.result.current.select(1, 1));
    expect(hook.result.current.selections[1]).toBe(0);
    api.submitAnswerBatch.mockResolvedValueOnce({ submissionId, revision: 1 });
    await act(async () => hook.result.current.saveAnswers());
    expect(api.submitAnswerBatch.mock.calls[1]![0].operationId).toBe(firstId);
  });

  it("handles a submission identity mismatch as a restore error", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockResolvedValueOnce({ submissionId: "different", revision: 2 });
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
  });

  it("refreshes saved answers after conflict recovery and marks corrupt state as complete", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(409, "conflict"));
    api.fetchAnswerSubmission.mockRejectedValueOnce(new Error("offline"));
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });

    api.fetchAnswerSubmission.mockResolvedValueOnce(makeSubmission({ revision: 2 }));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.revision).toBe(2);
    expect(hook.result.current.phase.kind).toBe("answering");

    // Refreshing a malformed persisted answer set is terminal and blocks correction.
    act(() => hook.result.current.select(1, 1));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(409, "conflict"));
    api.fetchAnswerSubmission.mockResolvedValueOnce(makeSubmission({ answers: [] }));
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
  });

  it("keeps refresh required after a transport failure while refreshing saved answers", async () => {
    const hook = await enterRefreshRequired();
    api.fetchAnswerSubmission.mockRejectedValueOnce(new Error("refresh transport failed"));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.phase).toMatchObject({
      kind: "answering",
      refreshRequired: true,
      message: "refresh transport failed",
    });
  });

  it("preserves the local draft and refreshes canonical state after conflict reconciliation", async () => {
    const hook = await enterAnswering({ freeTextFifth: true });
    [1, 2, 3, 4].forEach((id) => act(() => hook.result.current.select(id, 0)));
    act(() => hook.result.current.setFreeResponse(5, "draft"));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(409, "conflict"));
    const persistedAnswers: AnswerSubmission["answers"] = [1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected",
      selectedIndex: questionId === 1 ? 1 : 0,
      freeText: null,
    }));
    persistedAnswers.push({
      questionId: 5,
      answerKind: "freeText",
      selectedIndex: null,
      freeText: "persisted",
    });
    api.fetchAnswerSubmission.mockResolvedValueOnce(
      makeSubmission({
        revision: 3,
        answers: persistedAnswers,
      }),
    );
    const canonicalSavedSelections = Object.fromEntries(
      persistedAnswers.flatMap((answer) => {
        const quiz = hook.result.current.quizzes.find(
          ({ question: currentQuestion }) => currentQuestion.id === answer.questionId,
        );
        if (answer.answerKind !== "selected" || answer.selectedIndex === null || !quiz) return [];
        return [[answer.questionId, quiz.shuffled.choiceIndices.indexOf(answer.selectedIndex)]];
      }),
    );

    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.freeResponses).toEqual({ 5: "draft" });
    expect(hook.result.current.selections).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 });
    expect(hook.result.current.savedSelections).toEqual(canonicalSavedSelections);
    expect(hook.result.current.revision).toBe(3);
    expect(hook.result.current.answeredCount).toBe(5);
  });

  it("includes restored free text in the answer count after an explicit refresh", async () => {
    const hook = await enterRefreshRequired(true);
    const persistedAnswers: AnswerSubmission["answers"] = [1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected",
      selectedIndex: 0,
      freeText: null,
    }));
    persistedAnswers.push({
      questionId: 5,
      answerKind: "freeText",
      selectedIndex: null,
      freeText: "persisted",
    });
    api.fetchAnswerSubmission.mockResolvedValueOnce(
      makeSubmission({
        answers: persistedAnswers,
      }),
    );
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.freeResponses).toEqual({ 5: "persisted" });
    expect(hook.result.current.answeredCount).toBe(5);
  });

  it("drains a saved-answer refresh that resolves after unmount", async () => {
    const hook = await enterRefreshRequired();
    const pending = deferred<AnswerSubmission>();
    api.fetchAnswerSubmission.mockReturnValueOnce(pending.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.refreshSavedAnswers();
    });
    hook.unmount();
    pending.resolve(makeSubmission({ revision: 2 }));
    await act(async () => {
      await refreshing;
      // The refresh callback has completed its mounted check and finally block.
      await Promise.resolve();
    });
  });

  it("drains a failed saved-answer refresh after unmount", async () => {
    const hook = await enterRefreshRequired();
    const pending = deferred<AnswerSubmission>();
    api.fetchAnswerSubmission.mockReturnValueOnce(pending.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.refreshSavedAnswers();
    });
    hook.unmount();
    pending.reject(new Error("offline"));
    await act(async () => refreshing);
  });

  it("ignores saved-answer refresh results after switching participants", async () => {
    const hook = await enterRefreshRequired();
    const previousRefreshCount = api.fetchAnswerSubmission.mock.calls.length;
    const pending = deferred<AnswerSubmission>();
    api.fetchAnswerSubmission.mockReturnValueOnce(pending.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.refreshSavedAnswers();
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("refreshing"));

    await act(async () => hook.result.current.switchParticipant());
    expect(hook.result.current.phase.kind).toBe("ready");
    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.quizzes).toEqual([]);
    expect(hook.result.current.selections).toEqual({});
    expect(hook.result.current.freeResponses).toEqual({});

    pending.resolve(makeSubmission({ revision: 2 }));
    await act(async () => refreshing);

    expect(hook.result.current.phase.kind).toBe("ready");
    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.submissionId).toBeNull();
    expect(hook.result.current.revision).toBe(0);
    expect(hook.result.current.quizzes).toEqual([]);
    expect(hook.result.current.selections).toEqual({});
    expect(hook.result.current.freeResponses).toEqual({});
    expect(api.fetchAnswerSubmission).toHaveBeenCalledTimes(previousRefreshCount + 1);
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledOnce();
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledWith("owner");
  });

  it("drains a conflict reconciliation response that resolves after unmount", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    const pending = deferred<AnswerSubmission>();
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(409, "conflict"));
    api.fetchAnswerSubmission.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.saveAnswers();
    });
    await waitFor(() => expect(api.fetchAnswerSubmission).toHaveBeenCalledOnce());
    hook.unmount();
    pending.resolve(makeSubmission({ revision: 2 }));
    await act(async () => saving);
  });

  it("drains a failed conflict reconciliation after unmount", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    const pending = deferred<AnswerSubmission>();
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(409, "conflict"));
    api.fetchAnswerSubmission.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.saveAnswers();
    });
    await waitFor(() => expect(api.fetchAnswerSubmission).toHaveBeenCalledOnce());
    hook.unmount();
    pending.reject(new Error("offline"));
    await act(async () => saving);
  });

  it("handles conflict reconciliation after switching clears the submission", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    const pendingSave = deferred<{ submissionId: string; revision: number }>();
    api.submitAnswerBatch.mockReturnValueOnce(pendingSave.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.saveAnswers();
    });
    await act(async () => hook.result.current.switchParticipant());
    pendingSave.reject(apiError(409, "conflict"));
    await act(async () => saving);
    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.phase.kind).toBe("ready");
    expect(api.fetchAnswerSubmission).not.toHaveBeenCalled();
  });

  it("requires reauthentication when refreshing saved answers returns 401", async () => {
    const hook = await enterRefreshRequired();
    api.fetchAnswerSubmission.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.access).toMatchObject({ kind: "reauthentication", participant });
    expect(hook.result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });
  });

  it("uses a fallback message for a non-Error saved-answer refresh failure", async () => {
    const hook = await enterRefreshRequired();
    api.fetchAnswerSubmission.mockRejectedValueOnce({ reason: "offline" });
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.phase).toMatchObject({
      kind: "answering",
      refreshRequired: true,
      message: "保存済み回答を読み込めませんでした。",
    });
  });

  it("ignores a second saved-answer refresh while the first request is pending", async () => {
    const hook = await enterRefreshRequired();
    const previousRefreshCount = api.fetchAnswerSubmission.mock.calls.length;
    const pending = deferred<AnswerSubmission>();
    api.fetchAnswerSubmission.mockReturnValueOnce(pending.promise);
    let firstRefresh!: Promise<void>;
    act(() => {
      firstRefresh = hook.result.current.refreshSavedAnswers();
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("refreshing"));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(api.fetchAnswerSubmission).toHaveBeenCalledTimes(previousRefreshCount + 1);
    pending.resolve(makeSubmission({ revision: 2 }));
    await act(async () => firstRefresh);
    expect(hook.result.current.phase.kind).toBe("answering");
  });

  it("marks a malformed saved selected answer as unrestorable", async () => {
    const malformed = makeSubmission({
      answers: makeSubmission().answers.map((answer, index) =>
        index === 0 ? { ...answer, selectedIndex: null } : answer,
      ),
    });
    const hook = await enterAnswering({ latest: malformed }, "complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答の整合性を確認できません");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("marks a saved answer whose question is outside the loaded set as unrestorable", async () => {
    const answers = makeSubmission().answers.map((answer, index) =>
      index === 4 ? { ...answer, questionId: 99 } : answer,
    );
    const hook = await enterAnswering({ latest: makeSubmission({ answers }) }, "complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答の整合性を確認できません");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("marks an out-of-range saved choice as unrestorable", async () => {
    const answers = makeSubmission().answers.map((answer, index) =>
      index === 0 ? { ...answer, selectedIndex: 99 } : answer,
    );
    const hook = await enterAnswering({ latest: makeSubmission({ answers }) }, "complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答の整合性を確認できません");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("sets a restore error when refreshed saved answers are malformed", async () => {
    const hook = await enterRefreshRequired();
    api.fetchAnswerSubmission.mockResolvedValueOnce(makeSubmission({ answers: [] }));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
  });

  it("rejects a refreshed selected answer that cannot map to a displayed choice", async () => {
    const hook = await enterRefreshRequired();
    const answers = makeSubmission().answers.map((answer, index) =>
      index === 0 ? { ...answer, selectedIndex: 99 } : answer,
    );
    api.fetchAnswerSubmission.mockResolvedValueOnce(makeSubmission({ answers }));

    await act(async () => hook.result.current.refreshSavedAnswers());

    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
    expect(hook.result.current.saveConfirmed).toBe(false);
    expect(hook.result.current.savedSelections).toEqual({});
  });

  it.each([
    {
      label: "question set mismatch",
      makeSubmission: () => {
        const answers = makeSubmission().answers.map((answer, index) =>
          index === 4 ? { ...answer, questionId: 99 } : answer,
        );
        return makeSubmission({ answers });
      },
      freeTextFifth: false,
    },
    {
      label: "invalid legacy answer",
      makeSubmission: () => {
        const answers = makeSubmission().answers.map((answer, index) =>
          index === 4
            ? { questionId: 5, answerKind: "legacy" as const, selectedIndex: null, freeText: null }
            : answer,
        );
        return makeSubmission({ answers });
      },
      freeTextFifth: true,
    },
    {
      label: "invalid free-text answer",
      makeSubmission: () => {
        const answers = makeSubmission().answers.map((answer, index) =>
          index === 4
            ? { questionId: 5, answerKind: "freeText" as const, selectedIndex: null, freeText: " " }
            : answer,
        );
        return makeSubmission({ answers });
      },
      freeTextFifth: true,
    },
    {
      label: "invalid selected answer",
      makeSubmission: () => {
        const answers = makeSubmission().answers.map((answer, index) =>
          index === 0
            ? {
                questionId: 1,
                answerKind: "freeText" as const,
                selectedIndex: null,
                freeText: "invalid",
              }
            : answer,
        );
        return makeSubmission({ answers });
      },
      freeTextFifth: false,
    },
  ])(
    "rejects a refreshed submission with $label",
    async ({ makeSubmission: malformed, freeTextFifth }) => {
      const hook = await enterRefreshRequired(freeTextFifth);
      api.fetchAnswerSubmission.mockResolvedValueOnce(malformed());

      await act(async () => hook.result.current.refreshSavedAnswers());

      expect(hook.result.current.phase.kind).toBe("complete");
      expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
      expect(hook.result.current.saveConfirmed).toBe(false);
    },
  );

  it("switches participant and clears the current exam", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    await act(async () => hook.result.current.switchParticipant());
    expect(api.deleteParticipantSession).toHaveBeenCalledOnce();
    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.quizzes).toEqual([]);
    expect(hook.result.current.submissionId).toBeNull();
  });

  it("does not clear local state when session deletion completes after unmount", async () => {
    const deletion = deferred<void>();
    const hook = await enterAnswering();
    api.deleteParticipantSession.mockReturnValueOnce(deletion.promise);
    let switching!: Promise<void>;
    act(() => {
      switching = hook.result.current.switchParticipant();
    });
    hook.unmount();
    deletion.resolve();
    await act(async () => switching);
    expect(api.deleteParticipantSession).toHaveBeenCalledOnce();
  });

  it("drains participant deletion failure after unmount", async () => {
    const deletion = deferred<void>();
    const hook = await enterAnswering();
    api.deleteParticipantSession.mockReturnValueOnce(deletion.promise);
    let switching!: Promise<void>;
    act(() => {
      switching = hook.result.current.switchParticipant();
    });
    hook.unmount();
    deletion.reject(new Error("offline"));
    await act(async () => {
      await expect(switching).rejects.toThrow("offline");
    });
  });

  it("restores the current access if participant switching fails", async () => {
    const hook = await enterAnswering();
    api.deleteParticipantSession.mockRejectedValueOnce(new Error("offline"));
    await act(async () =>
      expect(hook.result.current.switchParticipant()).rejects.toThrow("offline"),
    );
    expect(hook.result.current.access).toMatchObject({ kind: "ready", participant });
  });

  it("clears a draft when another participant authenticates after reauthentication", async () => {
    const hook = await enterAnswering();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", "participant-bound-draft");
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.access.kind).toBe("reauthentication");
    api.createParticipantSession.mockResolvedValueOnce({ participant: otherParticipant });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap("owner", null, false, otherParticipant),
    );
    await act(async () => hook.result.current.login("別の参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.access).toMatchObject({
      kind: "ready",
      participant: otherParticipant,
    });
    expect(hook.result.current.selections).toEqual({});
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
  });

  it("purges an assisted draft after startup authorization expires, including failed reauthentication", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify(makeAssistedDraft()),
    );
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.fetchAssistedParticipant.mockRejectedValueOnce(apiError(401, "expired"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();

    api.createParticipantSession.mockRejectedValueOnce(apiError(401, "invalid credentials"));
    await act(async () =>
      expect(hook.result.current.login("参加者", "0000")).rejects.toThrow("invalid credentials"),
    );
    expect(hook.result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
  });

  it("retains an assisted draft after a transient bootstrap failure and retries the saved scope", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    const draft = makeAssistedDraft();
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("offline"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

    expect(hook.result.current.answerMode).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.selections).toEqual(draft.selections);
  });

  it("retains an assisted draft and retries after an explicit bootstrap 403", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify(makeAssistedDraft()),
    );
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

    expect(hook.result.current.answerMode).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).not.toBeNull();
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.selections).toEqual(makeAssistedDraft().selections);
  });

  it("purges an assisted draft when no participant session remains", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify(makeAssistedDraft()),
    );
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.fetchParticipantSession.mockResolvedValue(null);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));

    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
  });

  it("starts a name-only assisted answer, saves it in its own scope, edits it, and returns to the owner", async () => {
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(makeBootstrap("assisted"))
      .mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));

    act(() => hook.result.current.openAssistedLogin());
    expect(hook.result.current.assistedScreen).toBe("login");
    await act(async () => hook.result.current.startAssisted("代理回答者"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(api.createAssistedParticipant).toHaveBeenCalledWith("代理回答者");
    expect(api.fetchAnswerBootstrap).toHaveBeenLastCalledWith("assisted");
    expect(hook.result.current).toMatchObject({
      answerMode: "assisted",
      assistedScreen: "active",
      access: { kind: "ready", participant },
    });
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBe("assisted");

    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 2));
    }
    await act(async () => hook.result.current.saveAnswers());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(hook.result.current.answerMode).toBe("owner");
    expect(hook.result.current.access).toEqual({ kind: "ready", participant });
    expect(api.submitAnswerBatch).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: hook.result.current.submissionId }),
      "assisted",
    );
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();

    expect(api.fetchAnswerBootstrap).toHaveBeenLastCalledWith("owner");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
  });

  it("resumes the one linked unfinished answer without creating another participant", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted"));

    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(api.createAssistedParticipant).not.toHaveBeenCalled();
    expect(api.fetchAnswerBootstrap).toHaveBeenLastCalledWith("assisted");
    expect(hook.result.current).toMatchObject({
      answerMode: "assisted",
      assistedParticipant: {
        participant: assistedParticipant,
        hasSubmission: false,
        eligible: false,
      },
    });
  });

  it("restores the linked completed answer directly into the assisted editor", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    const saved = makeSubmission({
      submissionId: "00000000-0000-4000-8000-000000000018",
      revision: 4,
      answers: [
        ...[1, 2, 3, 4].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: questionId - 1,
          freeText: null,
        })),
        { questionId: 5, answerKind: "legacy" as const, selectedIndex: 0, freeText: null },
      ],
    });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted", saved));
    api.fetchExamQuestions.mockResolvedValueOnce(
      [1, 2, 3, 4, 5].map((id) => question(id, id === 5 ? "freeText" : "selected")),
    );
    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(hook.result.current.autoEditAssisted).toBe(true);
    act(() => hook.result.current.clearAutoEditAssisted());
    expect(hook.result.current.autoEditAssisted).toBe(false);
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    await act(async () => hook.result.current.editAnswers(() => true));
    expect(api.fetchExamQuestions).toHaveBeenCalledOnce();
    expect(hook.result.current.phase.kind).toBe("answering");
    expect(hook.result.current.answerMode).toBe("assisted");
    expect(hook.result.current.submissionId).toBe("00000000-0000-4000-8000-000000000018");
    expect(hook.result.current.revision).toBe(4);
    expect(hook.result.current.savedSelections).toHaveProperty("1");
    expect(hook.result.current.selections).toEqual(hook.result.current.savedSelections);
    expect(hook.result.current.answeredCount).toBe(4);
    expect(hook.result.current.legacyAnswerIds).toEqual([5]);
    expect(api.fetchAnswerBootstrap).toHaveBeenLastCalledWith("assisted");
    act(() => hook.result.current.select(1, 0));
    expect(
      JSON.parse(window.sessionStorage.getItem("stcirt-assisted-answer-draft")!).legacyAnswerIds,
    ).toEqual([5]);
  });

  it("restores assisted free text and answered count directly into correction", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    const saved = makeSubmission({
      submissionId: "00000000-0000-4000-8000-000000000018",
      revision: 6,
      answers: [
        ...[1, 2, 3, 4].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: questionId - 1,
          freeText: null,
        })),
        {
          questionId: 5,
          answerKind: "freeText" as const,
          selectedIndex: null,
          freeText: "保存済みの代理回答",
        },
      ],
    });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted", saved));
    api.fetchExamQuestions.mockResolvedValueOnce(
      [1, 2, 3, 4, 5].map((id) => question(id, id === 5 ? "freeText" : "selected")),
    );

    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    await act(async () => hook.result.current.editAnswers(() => true));
    expect(api.fetchExamQuestions).toHaveBeenCalledOnce();
    expect(hook.result.current.phase.kind).toBe("answering");

    expect(hook.result.current.freeResponses).toEqual({ 5: "保存済みの代理回答" });
    expect(hook.result.current.answeredCount).toBe(5);
    expect(hook.result.current.revision).toBe(6);
  });

  it("returns to owner completion after a confirmed assisted save and distinguishes owner reload failure", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(makeBootstrap("assisted"))
      .mockRejectedValueOnce(new Error("owner reload failed"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission());
    api.submitAnswerBatch.mockImplementationOnce(async ({ submissionId: currentId }) => ({
      submissionId: currentId,
      revision: 1,
    }));

    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 0));
    }
    await act(async () => hook.result.current.saveAnswers());

    await waitFor(() => expect(hook.result.current.phase.kind).toBe("owner-return-error"));
    expect(hook.result.current.answerMode).toBe("owner");
    expect(api.submitAnswerBatch).toHaveBeenCalledWith(expect.any(Object), "assisted");
    expect(hook.result.current.phase).toMatchObject({
      kind: "owner-return-error",
      message: expect.stringContaining("代理回答は保存されました"),
    });

    await act(async () => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(api.fetchLatestAnswerSubmission).toHaveBeenLastCalledWith("owner");
    expect(api.submitAnswerBatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing restore integrity", makeSubmission({ restoreIntegrity: { status: "invalid" } })],
    [
      "invalid saved answers",
      makeSubmission({ answers: [], restoreIntegrity: { status: "invalid" } }),
    ],
  ] as const)(
    "keeps the successful assisted save visible when owner restoration hits %s",
    async (_failure, invalidSubmission) => {
      api.fetchAssistedParticipant.mockResolvedValue({
        participant: assistedParticipant,
        hasSubmission: false,
        eligible: false,
      });
      const hook = await enterOwnerComplete();
      api.fetchAnswerBootstrap
        .mockResolvedValueOnce(makeBootstrap("assisted"))
        .mockResolvedValueOnce(makeBootstrap("owner", invalidSubmission));

      await act(async () => hook.result.current.resumeAssisted());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
      for (const quiz of hook.result.current.quizzes) {
        act(() => hook.result.current.select(quiz.question.id, 0));
      }

      await act(async () => hook.result.current.saveAnswers());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("owner-return-error"));
      expect(hook.result.current.answerMode).toBe("owner");
      expect(hook.result.current.phase).toMatchObject({
        kind: "owner-return-error",
        message: expect.stringContaining(
          "代理回答は保存されましたが、自分の保存済み回答を確認できませんでした",
        ),
      });
      expect(api.fetchExamQuestions).not.toHaveBeenCalled();
      expect(api.submitAnswerBatch).toHaveBeenCalledWith(expect.any(Object), "assisted");
    },
  );

  it("clears owner-return recovery when a different participant reauthenticates", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(makeBootstrap("assisted"))
      .mockRejectedValueOnce(apiError(401, "expired"))
      .mockResolvedValueOnce(makeBootstrap("owner", null, false, otherParticipant));

    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 0));
    }
    await act(async () => hook.result.current.saveAnswers());
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        access: { kind: "reauthentication", participant },
        phase: { kind: "owner-return-error" },
      }),
    );

    api.createParticipantSession.mockResolvedValueOnce({ participant: otherParticipant });
    await act(async () => hook.result.current.login("別の参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        access: { kind: "ready", participant: otherParticipant },
        phase: { kind: "answering" },
        answerMode: "owner",
      }),
    );
    expect(api.fetchAnswerBootstrap).toHaveBeenLastCalledWith("owner");
  });

  it("reauthenticates after an owner reload 401 and retries owner status without resubmitting assisted answers", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(makeBootstrap("assisted"))
      .mockRejectedValueOnce(apiError(401, "expired"))
      .mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.submitAnswerBatch.mockImplementationOnce(async ({ submissionId: currentId }) => ({
      submissionId: currentId,
      revision: 1,
    }));

    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 0));
    }
    await act(async () => hook.result.current.saveAnswers());
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        answerMode: "owner",
        access: { kind: "reauthentication", participant },
        phase: { kind: "owner-return-error" },
      }),
    );
    expect(hook.result.current.phase).toMatchObject({
      kind: "owner-return-error",
      message: expect.stringContaining("代理回答は保存されました"),
    });

    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(api.fetchAnswerBootstrap).toHaveBeenLastCalledWith("owner");
    expect(api.submitAnswerBatch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.answerMode).toBe("owner");
  });

  it("clears assisted recovery after an owner reload 403", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(makeBootstrap("assisted"))
      .mockRejectedValueOnce(apiError(403, "forbidden"));
    api.submitAnswerBatch.mockImplementationOnce(async ({ submissionId: currentId }) => ({
      submissionId: currentId,
      revision: 1,
    }));

    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 0));
    }
    await act(async () => hook.result.current.saveAnswers());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("owner-return-error"));

    expect(hook.result.current.answerMode).toBe("owner");
    expect(hook.result.current.access).toMatchObject({ kind: "ready", participant });
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(api.submitAnswerBatch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a mismatched save response as assisted success or return to owner", async () => {
    const draft = makeAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValue(
      makeBootstrap(
        "assisted",
        makeSubmission({ submissionId: draft.submissionId, revision: draft.revision }),
      ),
    );
    api.submitAnswerBatch.mockResolvedValueOnce({
      submissionId: "00000000-0000-4000-8000-000000000099",
      revision: draft.revision + 1,
    });
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 0));
    }

    await act(async () => hook.result.current.saveAnswers());

    expect(hook.result.current).toMatchObject({
      answerMode: "assisted",
      phase: { kind: "complete" },
    });
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledWith("assisted");
    expect(api.fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(api.submitAnswerBatch).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).not.toBeNull();

    await act(async () => hook.result.current.editAnswers(() => true));
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(api.fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(api.submitAnswerBatch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.answerMode).toBe("assisted");
  });

  it("resubmits assisted corrections to the same submission revision and returns to owner completion", async () => {
    const draft = makeAssistedDraft({
      selections: { 1: 2 },
      revision: 2,
    });
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: true,
    });
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(
        makeBootstrap(
          "assisted",
          makeSubmission({ submissionId: draft.submissionId, revision: 2 }),
        ),
      )
      .mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
    api.submitAnswerBatch.mockResolvedValueOnce({
      submissionId: draft.submissionId,
      revision: 3,
    });

    await act(async () => hook.result.current.resumeAssisted());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      if (quiz.question.id !== 1) act(() => hook.result.current.select(quiz.question.id, 0));
    }
    await act(async () => hook.result.current.saveAnswers());
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        answerMode: "owner",
        phase: { kind: "complete" },
      }),
    );

    expect(api.submitAnswerBatch).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: draft.submissionId, expectedRevision: 2 }),
      "assisted",
    );
    expect(api.fetchAnswerBootstrap).toHaveBeenLastCalledWith("owner");
    expect(api.submitAnswerBatch).toHaveBeenCalledTimes(1);
  });

  it("clears a completed assisted reload and returns to the owner's completion", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify(makeAssistedDraft()),
    );
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });
    api.fetchExamQuestions.mockResolvedValue([1, 2, 3, 4, 5].map((id) => question(id)));
    api.fetchAnswerBootstrap
      .mockResolvedValueOnce(
        makeBootstrap(
          "assisted",
          makeSubmission({ submissionId: makeAssistedDraft().submissionId, revision: 3 }),
        ),
      )
      .mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        answerMode: "owner",
        phase: { kind: "complete" },
      }),
    );
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(1, "assisted");
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");
  });

  it("restores an assisted draft on revisit, persists edits, and removes it after save", async () => {
    const draft = makeAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current).toMatchObject({
      answerMode: "assisted",
      assistedScreen: "active",
      selections: { 1: 2 },
      answeredCount: 1,
      submissionId: draft.submissionId,
      revision: draft.revision,
    });
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledWith("assisted");
    expect(api.fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();

    for (const id of [2, 3, 4, 5]) act(() => hook.result.current.select(id, 1));
    const storedDraft = JSON.parse(
      window.sessionStorage.getItem("stcirt-assisted-answer-draft")!,
    ) as {
      schemaVersion: number;
      expiresAt: number;
      participantId: number;
      selections: Record<number, number>;
    };
    expect(storedDraft.schemaVersion).toBe(1);
    expect(storedDraft.expiresAt).toBeGreaterThan(Date.now());
    expect(storedDraft.participantId).toBe(assistedParticipant.id);
    expect(storedDraft.selections).toEqual({ 1: 2, 2: 1, 3: 1, 4: 1, 5: 1 });
    api.submitAnswerBatch.mockResolvedValueOnce({ submissionId: draft.submissionId, revision: 3 });
    await act(async () => hook.result.current.saveAnswers());
    expect(api.submitAnswerBatch).toHaveBeenCalledWith(expect.any(Object), "assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
  });

  it("restores older assisted drafts without legacy answer IDs", async () => {
    const { legacyAnswerIds: _legacyAnswerIds, ...draft } = makeAssistedDraft();
    void _legacyAnswerIds;
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.legacyAnswerIds).toEqual([]);
    expect(hook.result.current.selections).toEqual(draft.selections);
    expect(hook.result.current.submissionId).toBe(draft.submissionId);
  });

  const invalidAssistedDraftCases: ReadonlyArray<readonly [string, () => string]> = [
    ["expired", (): string => JSON.stringify(makeAssistedDraft({ expiresAt: Date.now() - 1 }))],
    [
      "unknown schema version",
      (): string => JSON.stringify(makeAssistedDraft({ schemaVersion: 99 })),
    ],
    [
      "wrong assisted participant",
      (): string => JSON.stringify(makeAssistedDraft({ participantId: 999 })),
    ],
    ["invalid shape", (): string => JSON.stringify(makeAssistedDraft({ selections: { 1: 99 } }))],
    [
      "legacy answer for a question outside the loaded exam",
      (): string => JSON.stringify(makeAssistedDraft({ legacyAnswerIds: [6] })),
    ],
    ["malformed JSON", (): string => "{"],
  ];

  it.each(invalidAssistedDraftCases)(
    "purges an %s assisted draft and starts a clean attempt",
    async (_label: string, makeValue: () => string) => {
      window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
      window.sessionStorage.setItem("stcirt-assisted-answer-draft", makeValue());
      api.fetchParticipantSession.mockResolvedValue(participant);
      api.fetchAssistedParticipant.mockResolvedValue({
        participant: assistedParticipant,
        hasSubmission: false,
        eligible: false,
      });
      api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted"));

      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

      expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
      expect(api.fetchExamQuestions).not.toHaveBeenCalled();
      expect(hook.result.current.selections).toEqual({});
    },
  );

  it("counts saved free-text responses when restoring an assisted draft", async () => {
    const base = makeAssistedDraft();
    const draft = {
      ...base,
      quizzes: base.quizzes.map((quiz, index) =>
        index === 4
          ? {
              ...quiz,
              question: { ...quiz.question, answerType: "freeText" as const, choices: [] },
              shuffled: { choices: [], choiceIndices: [] },
            }
          : quiz,
      ),
      selections: { 1: 2 },
      freeResponses: { 5: " saved response " },
    };
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(
      makeBootstrap(
        "assisted",
        makeSubmission({ submissionId: draft.submissionId, revision: draft.revision }),
      ),
    );

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.freeResponses).toEqual({ 5: " saved response " });
    expect(hook.result.current.answeredCount).toBe(2);
    act(() => hook.result.current.setFreeResponse(5, " edited response "));
    expect(
      JSON.parse(window.sessionStorage.getItem("stcirt-assisted-answer-draft")!).freeResponses,
    ).toEqual({ 5: " edited response " });
  });

  it("counts saved free-text answers when no assisted submission exists yet", async () => {
    const base = makeAssistedDraft();
    const draft = {
      ...base,
      quizzes: base.quizzes.map((quiz, index) =>
        index === 4
          ? {
              ...quiz,
              question: { ...quiz.question, answerType: "freeText" as const, choices: [] },
              shuffled: { choices: [], choiceIndices: [] },
            }
          : quiz,
      ),
      selections: {},
      freeResponses: { 5: "saved before submission" },
    };
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.freeResponses).toEqual({ 5: "saved before submission" });
    expect(hook.result.current.answeredCount).toBe(1);
  });

  it("does not open assisted login before the owner has completed the exam", async () => {
    const hook = await enterAnswering();

    act(() => hook.result.current.openAssistedLogin());

    expect(hook.result.current).toMatchObject({
      answerMode: "owner",
      assistedScreen: "closed",
      phase: { kind: "answering" },
    });
    expect(api.createAssistedParticipant).not.toHaveBeenCalled();
  });

  it("does not resume a linked participant after the owner session is signed out", async () => {
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = await enterOwnerComplete();
    const bootstrapCount = api.fetchAnswerBootstrap.mock.calls.length;
    await act(async () => hook.result.current.switchParticipant());

    await act(async () => hook.result.current.resumeAssisted());

    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.answerMode).toBe("owner");
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCount);
  });

  it("does not attempt to resume when no linked participant exists", async () => {
    const hook = await enterOwnerComplete();
    const bootstrapCount = api.fetchAnswerBootstrap.mock.calls.length;

    await act(async () => hook.result.current.resumeAssisted());

    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.answerMode).toBe("owner");
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCount);
    expect(api.createAssistedParticipant).not.toHaveBeenCalled();
  });

  it("ignores a rejected assisted registration after unmount", async () => {
    const hook = await enterOwnerComplete();
    const registration = deferred<{ participant: Participant; hasSubmission: boolean }>();
    api.createAssistedParticipant.mockReturnValueOnce(registration.promise);
    act(() => hook.result.current.openAssistedLogin());
    let starting!: Promise<void>;
    act(() => {
      starting = hook.result.current.startAssisted("代理回答者");
    });

    hook.unmount();
    registration.reject(new Error("late registration error"));
    await expect(starting).rejects.toThrow("late registration error");
  });

  it("does not reauthenticate a signed-out owner when the pending assisted request returns 401", async () => {
    const hook = await enterOwnerComplete();
    const registration = deferred<{ participant: Participant; hasSubmission: boolean }>();
    api.createAssistedParticipant.mockReturnValueOnce(registration.promise);
    act(() => hook.result.current.openAssistedLogin());
    let starting!: Promise<void>;
    act(() => {
      starting = hook.result.current.startAssisted("代理回答者");
    });

    await act(async () => hook.result.current.switchParticipant());
    registration.reject(apiError(401, "expired"));
    await act(async () => {
      await expect(starting).rejects.toMatchObject({ status: 401 });
    });

    expect(hook.result.current.access.kind).toBe("login");
    expect(hook.result.current.answerMode).toBe("owner");
  });

  it("does not switch away from assisted answers when the owner session has expired", async () => {
    const hook = await enterOwnerComplete();
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted"));
    act(() => hook.result.current.openAssistedLogin());
    await act(async () => hook.result.current.startAssisted("代理回答者"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 1));
    }
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));

    act(() => hook.result.current.returnToOwner());

    expect(hook.result.current).toMatchObject({
      answerMode: "assisted",
      access: { kind: "reauthentication", participant },
    });
  });

  it.each(["resolves", "rejects"] as const)(
    "ignores an assisted status request that %s after the hook unmounts",
    async (outcome) => {
      const pending = deferred<AssistedParticipantState>();
      api.fetchParticipantSession.mockResolvedValue(participant);
      api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));
      api.fetchAssistedParticipant.mockReturnValueOnce(pending.promise);
      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
      await waitFor(() => expect(api.fetchAssistedParticipant).toHaveBeenCalledOnce());

      hook.unmount();
      if (outcome === "resolves") {
        pending.resolve({
          participant: assistedParticipant,
          hasSubmission: false,
          eligible: false,
        });
        await act(async () => {
          await pending.promise;
          await Promise.resolve();
        });
      } else {
        pending.reject(new Error("status unavailable"));
        await act(async () => {
          await pending.promise.catch(() => undefined);
          await Promise.resolve();
        });
      }
    },
  );

  it("prefers a matching assisted draft over an unchanged server snapshot", async () => {
    const draft = makeAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValue(
      makeBootstrap(
        "assisted",
        makeSubmission({ submissionId: draft.submissionId, revision: draft.revision }),
      ),
    );

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.selections).toEqual(draft.selections);
    expect(hook.result.current.savedSelections).toEqual({});
    expect(hook.result.current.answeredCount).toBe(1);
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("discards a stale assisted draft when the linked answer has a newer revision", async () => {
    const draft = makeAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValue(
      makeBootstrap(
        "assisted",
        makeSubmission({ submissionId: draft.submissionId, revision: draft.revision + 1 }),
      ),
    );

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    expect(hook.result.current.revision).toBe(draft.revision + 1);
    expect(hook.result.current.selections).not.toEqual(draft.selections);
    expect(hook.result.current.savedSelections).toEqual(hook.result.current.selections);
  });

  it("falls back to the owner scope when the persisted assisted link no longer exists", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: null,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap
      .mockRejectedValueOnce(apiError(404, "assisted participant not found"))
      .mockResolvedValueOnce(makeBootstrap("owner", makeSubmission()));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    expect(hook.result.current.answerMode).toBe("owner");
    expect(hook.result.current.assistedScreen).toBe("closed");
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
  });

  it("keeps the assisted scope and draft when assisted bootstrap fails transiently", async () => {
    const draft = makeCurrentAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockRejectedValueOnce(new Error("assisted bootstrap failed"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

    expect(hook.result.current.answerMode).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledOnce();
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.selections).toEqual(draft.selections);
    expect(hook.result.current.freeResponses).toEqual(draft.freeResponses);
    expect(hook.result.current.answeredCount).toBe(2);
  });

  it("clears assisted scope and draft after a non-auth bootstrap failure with no session", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify(makeCurrentAssistedDraft()),
    );
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchParticipantSession.mockResolvedValueOnce(null);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));

    expect(hook.result.current.answerMode).toBe("owner");
    expect(hook.result.current.assistedScreen).toBe("closed");
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(api.fetchAssistedParticipant).not.toHaveBeenCalled();
  });

  it("keeps an assisted draft and shows a retry message when non-auth recovery cannot verify the session", async () => {
    const draft = makeCurrentAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchParticipantSession.mockRejectedValueOnce(new Error("offline"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));

    expect(hook.result.current.access).toMatchObject({
      kind: "login",
      message: expect.stringContaining("通信状態"),
    });
    expect(hook.result.current.answerMode).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
  });

  it.each([
    ["resolves", "resolve"],
    ["rejects", "reject"],
  ] as const)("ignores non-auth session lookup that %s after unmount", async (_label, outcome) => {
    const pendingSession = deferred<Participant | null>();
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchParticipantSession.mockReturnValueOnce(pendingSession.promise);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchParticipantSession).toHaveBeenCalledOnce());
    hook.unmount();

    if (outcome === "resolve") {
      pendingSession.resolve(participant);
      await act(async () => pendingSession.promise);
    } else {
      pendingSession.reject(new Error("offline"));
      await act(async () => {
        await expect(pendingSession.promise).rejects.toThrow("offline");
      });
    }
    expect(api.fetchAssistedParticipant).not.toHaveBeenCalled();
  });

  it.each([
    [401, "resolves"],
    [401, "rejects"],
    [403, "resolves"],
    [403, "rejects"],
  ] as const)(
    "ignores assisted-status request that %s after a bootstrap %i and unmount",
    async (status, outcome) => {
      window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
      api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(status, "bootstrap failure"));
      api.fetchParticipantSession.mockResolvedValueOnce(participant);
      const pendingStatus = deferred<AssistedParticipantState>();
      api.fetchAssistedParticipant.mockReturnValueOnce(pendingStatus.promise);

      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(api.fetchAssistedParticipant).toHaveBeenCalledOnce());
      hook.unmount();

      if (outcome === "resolves") {
        pendingStatus.resolve({
          participant: assistedParticipant,
          hasSubmission: false,
          eligible: false,
        });
        await act(async () => pendingStatus.promise);
      } else {
        pendingStatus.reject(new Error("offline"));
        await act(async () => {
          await expect(pendingStatus.promise).rejects.toThrow("offline");
        });
      }
    },
  );

  it("keeps assisted reauthentication when the optional status check fails", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAssistedParticipant.mockRejectedValueOnce(new Error("offline"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));

    expect(hook.result.current.answerMode).toBe("assisted");
    expect(hook.result.current.phase.kind).toBe("ready");
  });

  it("restores an assisted free-text draft when retry finds no submission", async () => {
    const draft = makeCurrentAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.freeResponses).toEqual(draft.freeResponses);
    expect(hook.result.current.answeredCount).toBe(2);
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("blocks assisted restoration when retry finds a matching submission without integrity", async () => {
    const draft = makeCurrentAssistedDraft();
    const { restoreIntegrity: _restoreIntegrity, ...submissionWithoutIntegrity } = makeSubmission({
      submissionId: draft.submissionId,
      revision: draft.revision,
    });
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(submissionWithoutIntegrity);

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));

    expect(hook.result.current.restoreError).toContain("整合性を確認できません");
    expect(hook.result.current.saveConfirmed).toBe(false);
    expect(hook.result.current.selections).toEqual({});
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
  });

  it("restores an assisted draft when retry finds its matching saved submission", async () => {
    const draft = makeCurrentAssistedDraft();
    const savedSubmission = makeSubmission({
      submissionId: draft.submissionId,
      revision: draft.revision,
      answers: [
        ...[1, 2, 3, 4].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 0,
          freeText: null,
        })),
        {
          questionId: 5,
          answerKind: "freeText" as const,
          selectedIndex: null,
          freeText: "Q5 response",
        },
      ],
    });
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: true,
      eligible: false,
    });

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(savedSubmission);

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.submissionId).toBe(draft.submissionId);
    expect(hook.result.current.revision).toBe(draft.revision);
    expect(hook.result.current.freeResponses).toEqual(draft.freeResponses);
    expect(hook.result.current.answeredCount).toBe(2);
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("returns to owner bootstrap when retry finds a different saved assisted submission", async () => {
    const draft = makeCurrentAssistedDraft();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    api.fetchAnswerBootstrap
      .mockRejectedValueOnce(apiError(403, "forbidden"))
      .mockResolvedValueOnce(makeBootstrap("owner"));
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(
      makeSubmission({ submissionId: "00000000-0000-4000-8000-000000000099", revision: 3 }),
    );

    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.answerMode).toBe("owner");
    expect(hook.result.current.quizzes).toHaveLength(5);
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce();
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(1, "assisted");
    expect(api.fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
  });

  it("ignores a failed assisted submission retry after unmount", async () => {
    api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(403, "forbidden"));
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchAssistedParticipant.mockResolvedValueOnce({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));

    const pendingLatest = deferred<AnswerSubmission | null>();
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pendingLatest.promise);
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce());
    hook.unmount();
    pendingLatest.reject(new Error("offline"));
    await act(async () => {
      await expect(pendingLatest.promise).rejects.toThrow("offline");
    });
  });

  it("keeps the owner completion usable after a transient assisted status failure", async () => {
    api.fetchAssistedParticipant.mockRejectedValueOnce(new Error("offline"));
    const hook = await enterOwnerComplete();

    await waitFor(() =>
      expect(hook.result.current.assistedError).toContain(
        "代理回答の状態を確認できませんでした。時間をおいて再読み込みしてください。",
      ),
    );
    expect(hook.result.current.access).toMatchObject({ kind: "ready", participant });
    expect(hook.result.current.phase.kind).toBe("complete");
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object JSON", "null"],
    ["wrong question count", JSON.stringify(makeAssistedDraft({ quizzes: [] }))],
    ["missing selections", JSON.stringify({ ...makeAssistedDraft(), selections: null })],
    ["invalid free responses", JSON.stringify({ ...makeAssistedDraft(), freeResponses: null })],
    ["missing submission ID", JSON.stringify({ ...makeAssistedDraft(), submissionId: 7 })],
    ["non-integer revision", JSON.stringify(makeAssistedDraft({ revision: 1.5 }))],
    [
      "duplicate question IDs",
      JSON.stringify(
        makeAssistedDraft({
          quizzes: makeAssistedDraft().quizzes.map((quiz, index, all) =>
            index === all.length - 1 ? { ...quiz, question: { ...quiz.question, id: 4 } } : quiz,
          ),
        }),
      ),
    ],
    [
      "unordered question IDs",
      JSON.stringify(
        makeAssistedDraft({
          quizzes: [
            makeAssistedDraft().quizzes[1],
            makeAssistedDraft().quizzes[0],
            ...makeAssistedDraft().quizzes.slice(2),
          ],
        }),
      ),
    ],
    [
      "invalid choice map",
      JSON.stringify(
        makeAssistedDraft({
          quizzes: makeAssistedDraft().quizzes.map((quiz, index) =>
            index === 0 ? { ...quiz, shuffled: { choices: [], choiceIndices: [0] } } : quiz,
          ),
        }),
      ),
    ],
    [
      "selected question without choices",
      JSON.stringify(
        makeAssistedDraft({
          quizzes: makeAssistedDraft().quizzes.map((quiz, index) =>
            index === 0
              ? {
                  ...quiz,
                  question: { ...quiz.question, choices: [] },
                  shuffled: { choices: [], choiceIndices: [] },
                }
              : quiz,
          ),
        }),
      ),
    ],
    [
      "duplicate shuffled choice",
      JSON.stringify(
        makeAssistedDraft({
          quizzes: makeAssistedDraft().quizzes.map((quiz, index) =>
            index === 0
              ? {
                  ...quiz,
                  shuffled: { choices: ["A", "A", "C", "D"], choiceIndices: [0, 1, 2, 3] },
                }
              : quiz,
          ),
        }),
      ),
    ],
    [
      "different shuffled choice set",
      JSON.stringify(
        makeAssistedDraft({
          quizzes: makeAssistedDraft().quizzes.map((quiz, index) =>
            index === 0
              ? {
                  ...quiz,
                  shuffled: { choices: ["A", "B", "C", "X"], choiceIndices: [0, 1, 2, 3] },
                }
              : quiz,
          ),
        }),
      ),
    ],
  ])("ignores corrupted assisted draft data: %s", async (_label, rawDraft) => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", String(rawDraft));
    api.fetchParticipantSession.mockResolvedValue(participant);
    api.fetchAssistedParticipant.mockResolvedValue({
      participant: assistedParticipant,
      hasSubmission: false,
      eligible: false,
    });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted"));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(hook.result.current.answerMode).toBe("assisted");
    expect(hook.result.current.selections).toEqual({});
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("turns an assisted status 401 into owner reauthentication", async () => {
    api.fetchAssistedParticipant.mockRejectedValueOnce(apiError(401, "expired"));
    const hook = await enterOwnerComplete();

    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));
    expect(hook.result.current.assistedError).toContain("セッションの有効期限が切れました");
  });

  it("clears an assisted draft when the completed owner's assisted-status check returns 403", async () => {
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", "stale draft");
    api.fetchAssistedParticipant.mockRejectedValueOnce(apiError(403, "forbidden"));

    const hook = await enterOwnerComplete();

    await waitFor(() =>
      expect(hook.result.current.assistedError).toContain("確認できませんでした"),
    );
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(hook.result.current.access).toEqual({ kind: "ready", participant });
  });

  it("clears an assisted draft when assisted registration returns 403", async () => {
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", "stale draft");
    const hook = await enterOwnerComplete();
    api.createAssistedParticipant.mockRejectedValueOnce(apiError(403, "forbidden"));
    act(() => hook.result.current.openAssistedLogin());

    await act(async () => {
      await expect(hook.result.current.startAssisted("代理回答者")).rejects.toThrow("forbidden");
    });

    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(hook.result.current.access).toEqual({ kind: "ready", participant });
    expect(hook.result.current.assistedScreen).toBe("login");
  });

  it("keeps the assisted sign-in screen visible and requests owner reauthentication after a 401", async () => {
    const hook = await enterOwnerComplete();
    api.createAssistedParticipant.mockRejectedValueOnce(apiError(401, "expired"));
    act(() => hook.result.current.openAssistedLogin());

    await act(async () => {
      await expect(hook.result.current.startAssisted("代理回答者")).rejects.toThrow("expired");
    });
    expect(hook.result.current).toMatchObject({
      answerMode: "owner",
      assistedScreen: "login",
      access: { kind: "reauthentication", participant },
      assistedError: "expired",
    });
  });

  it("uses a fallback message when assisted registration rejects with a non-Error value", async () => {
    const hook = await enterOwnerComplete();
    api.createAssistedParticipant.mockRejectedValueOnce("unexpected rejection");
    act(() => hook.result.current.openAssistedLogin());

    await act(async () => {
      await expect(hook.result.current.startAssisted("代理回答者")).rejects.toBe(
        "unexpected rejection",
      );
    });

    expect(hook.result.current.assistedError).toBe("代理回答を開始できませんでした。");
    expect(hook.result.current.assistedScreen).toBe("login");
  });

  it.each([401, 403])(
    "purges an assisted draft when participant-session lookup returns %i",
    async (status) => {
      window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
      window.sessionStorage.setItem(
        "stcirt-assisted-answer-draft",
        JSON.stringify(makeAssistedDraft()),
      );
      api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
      api.fetchParticipantSession.mockRejectedValueOnce(apiError(status, "unauthorized"));

      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));

      expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
      expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    },
  );

  it.each([
    ["a network error", new Error("offline")],
    ["an HTTP 503", apiError(503, "unavailable")],
  ])(
    "retains an assisted draft when participant-session lookup fails with %s",
    async (_label, lookupError) => {
      window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
      const draft = makeAssistedDraft();
      window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
      api.fetchAnswerBootstrap.mockRejectedValueOnce(apiError(401, "expired"));
      api.fetchParticipantSession.mockRejectedValueOnce(lookupError);

      const hook = renderHook(() => useQuizSession());
      await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));

      expect(hook.result.current.access).toMatchObject({
        kind: "login",
        message: expect.stringContaining("通信状態"),
      });
      expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBe("assisted");
      expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
        JSON.stringify(draft),
      );
    },
  );

  it("clears the assisted login error when returning to the completed owner answer", async () => {
    const hook = await enterOwnerComplete();
    api.createAssistedParticipant.mockRejectedValueOnce(new Error("一時的な登録失敗"));
    act(() => hook.result.current.openAssistedLogin());
    await act(async () => {
      await expect(hook.result.current.startAssisted("代理回答者")).rejects.toThrow(
        "一時的な登録失敗",
      );
    });
    expect(hook.result.current.assistedError).toBe("一時的な登録失敗");

    act(() => hook.result.current.returnToOwner());

    expect(hook.result.current).toMatchObject({
      answerMode: "owner",
      assistedScreen: "closed",
      assistedError: null,
      phase: { kind: "complete" },
    });
  });

  it("blocks duplicate registration and return-to-owner while the name request is pending", async () => {
    const hook = await enterOwnerComplete();
    const registration = deferred<{ participant: Participant; hasSubmission: boolean }>();
    api.createAssistedParticipant.mockReturnValueOnce(registration.promise);
    act(() => hook.result.current.openAssistedLogin());
    let starting!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      starting = hook.result.current.startAssisted("代理回答者");
      duplicate = hook.result.current.startAssisted("別の名前");
      hook.result.current.returnToOwner();
    });
    await expect(duplicate).rejects.toThrow("処理中です");

    expect(hook.result.current).toMatchObject({
      answerMode: "owner",
      assistedScreen: "login",
      assistedBusy: true,
    });
    expect(api.createAssistedParticipant).toHaveBeenCalledOnce();
    registration.resolve({ participant: assistedParticipant, hasSubmission: false });
    api.fetchAnswerBootstrap.mockResolvedValueOnce(makeBootstrap("assisted"));
    await act(async () => starting);
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.answerMode).toBe("assisted");
  });

  it("does not switch answer mode when an assisted registration resolves after unmount", async () => {
    const hook = await enterOwnerComplete();
    const registration = deferred<{ participant: Participant; hasSubmission: boolean }>();
    api.createAssistedParticipant.mockReturnValueOnce(registration.promise);
    act(() => hook.result.current.openAssistedLogin());
    let starting!: Promise<void>;
    act(() => {
      starting = hook.result.current.startAssisted("代理回答者");
    });

    hook.unmount();
    registration.resolve({ participant: assistedParticipant, hasSubmission: false });
    await starting;

    expect(api.fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
    expect(api.fetchAnswerBootstrap).toHaveBeenCalledWith("owner");
  });
});
