import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuizSession } from "@/app/answer/use-quiz-session";
import {
  ApiError as ApiErrorClass,
  type AnswerSubmission,
  type Participant,
} from "@/lib/api/client";

const api = vi.hoisted(() => ({
  createParticipantSession: vi.fn(),
  deleteParticipantSession: vi.fn(),
  fetchAnswerSubmission: vi.fn(),
  fetchExamQuestions: vi.fn(),
  fetchLatestAnswerSubmission: vi.fn(),
  fetchNextQuestion: vi.fn(),
  fetchParticipantSession: vi.fn(),
  submitAnswerBatch: vi.fn(),
}));

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, ...api };
});

const participant: Participant = { id: 7, name: "参加者" };
const otherParticipant: Participant = { id: 8, name: "別の参加者" };
const submissionId = "00000000-0000-4000-8000-000000000001";
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
  return {
    submissionId,
    revision: 1,
    answers: [1, 2, 3, 4, 5].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: 0,
      freeText: null,
    })),
    ...overrides,
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
  api.fetchNextQuestion.mockImplementation(async (afterId?: number) => {
    const id = (afterId ?? 0) + 1;
    return question(id, options.freeTextFifth && id === 5 ? "freeText" : "selected");
  });
  const hook = renderHook(() => useQuizSession());
  await waitFor(() => expect(hook.result.current.phase.kind).toBe(expectedPhase));
  return hook;
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
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(submissionId);
    api.fetchParticipantSession.mockResolvedValue(null);
    api.fetchLatestAnswerSubmission.mockResolvedValue(null);
    api.fetchNextQuestion.mockImplementation(async (afterId?: number) =>
      question((afterId ?? 0) + 1),
    );
    api.fetchExamQuestions.mockImplementation(async (): Promise<ReturnType<typeof question>[]> => {
      const questions: ReturnType<typeof question>[] = [];
      for (let index = 0; index < 5; index += 1) {
        const next = await api.fetchNextQuestion(index === 0 ? undefined : questions.at(-1)?.id);
        if (!next) return questions;
        questions.push(next);
      }
      return questions;
    });
    api.createParticipantSession.mockResolvedValue({ participant });
    api.deleteParticipantSession.mockResolvedValue(undefined);
    api.submitAnswerBatch.mockResolvedValue({ submissionId, revision: 1 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("moves to login after a session lookup failure and exposes the original login error", async () => {
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
    api.fetchParticipantSession.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchParticipantSession).toHaveBeenCalledOnce());
    hook.unmount();
    pending.resolve(participant);
    await act(async () => pending.promise);
  });

  it("drains participant-session lookup failure after unmount", async () => {
    const pending = deferred<Participant | null>();
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
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestion.promise);
    const hook = renderHook(() => useQuizSession());
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
    api.createParticipantSession.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    let loggingIn!: Promise<void>;
    act(() => {
      loggingIn = hook.result.current.login("参加者", "1234");
    });
    hook.unmount();
    pending.resolve({ participant });
    await act(async () => loggingIn);
    expect(api.createParticipantSession).toHaveBeenCalledOnce();
  });

  it("does not apply a failed login after unmount", async () => {
    const pending = deferred<{ participant: Participant }>();
    api.createParticipantSession.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    let loggingIn!: Promise<void>;
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
    expect(hook.result.current.answeredCount).toBe(5);
    act(() => hook.result.current.editAnswers());
    expect(hook.result.current.phase.kind).toBe("answering");
    expect(Object.keys(hook.result.current.selections)).toHaveLength(5);
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

    expect(hook.result.current.freeResponses).toEqual({ 5: "保存済みの記述回答" });
    expect(hook.result.current.answeredCount).toBe(5);
  });

  it("loads a complete ordered exam with exactly one batch call", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchExamQuestions.mockResolvedValueOnce([1, 2, 3, 4, 5].map((id) => question(id)));

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(api.fetchExamQuestions).toHaveBeenCalledOnce();
    expect(hook.result.current.quizzes.map(({ question: item }) => item.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
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
  ])("does not start an exam from a $label batch", async ({ questions }) => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchExamQuestions.mockResolvedValueOnce(questions);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));
    expect(hook.result.current.quizzes).toEqual([]);
  });

  it("reports incomplete batch as a retryable load error", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchNextQuestion.mockResolvedValueOnce(question(1)).mockResolvedValueOnce(null);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));
    expect(hook.result.current.quizzes).toHaveLength(0);
  });

  it("marks a saved submission unrestorable when its questions are unavailable", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission());
    api.fetchNextQuestion.mockResolvedValueOnce(null);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    expect(hook.result.current.restoreError).toContain("設問を読み込めませんでした");
  });

  it("retries a failed load from the already loaded questions", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchNextQuestion
      .mockResolvedValueOnce(question(1))
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (afterId?: number) => question((afterId ?? 0) + 1));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));
    act(() => hook.result.current.retryLoad());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.quizzes).toHaveLength(5);
  });

  it("ignores repeated load retries while the first retry is pending", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchNextQuestion.mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));

    const pending = deferred<ReturnType<typeof question>>();
    api.fetchNextQuestion.mockReturnValueOnce(pending.promise);
    const callsBeforeRetry = api.fetchExamQuestions.mock.calls.length;
    act(() => {
      hook.result.current.retryLoad();
      hook.result.current.retryLoad();
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("loading"));
    expect(api.fetchExamQuestions).toHaveBeenCalledTimes(callsBeforeRetry + 1);

    pending.resolve(question(1));
    await act(async () => {
      await pending.promise;
    });
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
  });

  it("handles latest-submission authorization and transport errors, then retries the check", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchLatestAnswerSubmission.mockRejectedValueOnce(apiError(401, "expired"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    expect(hook.result.current.access.kind).toBe("login");

    api.createParticipantSession.mockResolvedValueOnce({ participant });
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    api.fetchLatestAnswerSubmission.mockRejectedValueOnce(new Error("offline"));
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
  });

  it("ignores repeated submission-check retries while the lookup is pending", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchLatestAnswerSubmission.mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("submission-error"));
    const pending = deferred<AnswerSubmission | null>();
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.retrySubmissionCheck());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("checking-submission"));
    act(() => hook.result.current.retrySubmissionCheck());
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledTimes(2);
    pending.resolve(null);
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
  });

  it("ignores participant resolution while a submission check is already in flight", async () => {
    const pendingLookup = deferred<AnswerSubmission | null>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pendingLookup.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("checking-submission"));

    api.createParticipantSession.mockResolvedValueOnce({ participant: otherParticipant });
    await act(async () => hook.result.current.login("別の参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.access).toMatchObject({
        kind: "ready",
        participant: otherParticipant,
      }),
    );
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce();

    hook.unmount();
    pendingLookup.resolve(null);
    await act(async () => {
      await pendingLookup.promise;
      await Promise.resolve();
    });
  });

  it("returns to login after latest-submission authorization expires", async () => {
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchLatestAnswerSubmission.mockRejectedValueOnce(apiError(401, "expired"));
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("login"));
    expect(hook.result.current.phase.kind).toBe("ready");
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
    act(() => hook.result.current.retrySubmissionCheck());
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce();
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
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestion.promise);
    const hook = renderHook(() => useQuizSession());
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
    const pending = deferred<AnswerSubmission | null>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce());
    hook.unmount();
    pending.resolve(null);
    await act(async () => {
      await pending.promise;
      // Let resolveParticipant finish its post-fetch mounted check.
      await Promise.resolve();
    });
    expect(api.fetchExamQuestions).not.toHaveBeenCalled();
  });

  it("does not update state when submission lookup rejects after unmount", async () => {
    const pending = deferred<AnswerSubmission | null>();
    api.fetchParticipantSession.mockResolvedValueOnce(participant);
    api.fetchLatestAnswerSubmission.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce());
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
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission());
    api.fetchExamQuestions.mockReturnValueOnce(pendingQuestion.promise);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(api.fetchExamQuestions).toHaveBeenCalledOnce());
    hook.unmount();
    pendingQuestion.resolve([1, 2, 3, 4, 5].map((id) => question(id)));
    await act(async () => {
      await pendingQuestion.promise;
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
    expect(hook.result.current.phase).toMatchObject({
      kind: "answering",
      retryRequired: false,
      message: "invalid",
    });
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

    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission({ revision: 0 }));
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
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission({ revision: 2 }));
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
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
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

    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission({ revision: 2 }));
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
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.phase).toMatchObject({ kind: "answering", retryRequired: false });
    expect(hook.result.current.phase).toMatchObject({ message: undefined });
  });

  it("resumes without a retry message when the saved revision is unchanged", async () => {
    const hook = await enterAnswering();
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());

    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission({ revision: 2 }));
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() =>
      expect(hook.result.current.phase).toMatchObject({
        kind: "answering",
        refreshRequired: true,
      }),
    );

    api.fetchAnswerSubmission.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.refreshSavedAnswers());
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(makeSubmission({ revision: 2 }));
    await act(async () => hook.result.current.login("参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.phase).toMatchObject({ kind: "answering", retryRequired: false });
    expect(hook.result.current.phase).toMatchObject({ message: undefined });
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

  it("includes restored free text in the answer count after conflict reconciliation", async () => {
    const hook = await enterAnswering({ freeTextFifth: true });
    [1, 2, 3, 4].forEach((id) => act(() => hook.result.current.select(id, 0)));
    act(() => hook.result.current.setFreeResponse(5, "draft"));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(409, "conflict"));
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

    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.freeResponses).toEqual({ 5: "persisted" });
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
    expect(api.fetchLatestAnswerSubmission).toHaveBeenCalledOnce();
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
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
  });

  it("marks a saved answer whose question is outside the loaded set as unrestorable", async () => {
    const answers = makeSubmission().answers.map((answer, index) =>
      index === 4 ? { ...answer, questionId: 99 } : answer,
    );
    const hook = await enterAnswering({ latest: makeSubmission({ answers }) }, "complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
  });

  it("marks an out-of-range saved choice as unrestorable", async () => {
    const answers = makeSubmission().answers.map((answer, index) =>
      index === 0 ? { ...answer, selectedIndex: 99 } : answer,
    );
    const hook = await enterAnswering({ latest: makeSubmission({ answers }) }, "complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
  });

  it("sets a restore error when refreshed saved answers are malformed", async () => {
    const hook = await enterRefreshRequired();
    api.fetchAnswerSubmission.mockResolvedValueOnce(makeSubmission({ answers: [] }));
    await act(async () => hook.result.current.refreshSavedAnswers());
    expect(hook.result.current.phase.kind).toBe("complete");
    expect(hook.result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
  });

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
    [1, 2, 3, 4, 5].forEach((id) => act(() => hook.result.current.select(id, 0)));
    api.submitAnswerBatch.mockRejectedValueOnce(apiError(401, "expired"));
    await act(async () => hook.result.current.saveAnswers());
    expect(hook.result.current.access.kind).toBe("reauthentication");
    api.createParticipantSession.mockResolvedValueOnce({ participant: otherParticipant });
    api.fetchLatestAnswerSubmission.mockResolvedValueOnce(null);
    await act(async () => hook.result.current.login("別の参加者", "1234"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    expect(hook.result.current.access).toMatchObject({
      kind: "ready",
      participant: otherParticipant,
    });
    expect(hook.result.current.selections).toEqual({});
  });
});
