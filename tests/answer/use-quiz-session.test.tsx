import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useQuizSession } from "@/app/answer/use-quiz-session";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, fetchLatestAnswerSubmission: vi.fn(async () => null) };
});
import { fetchLatestAnswerSubmission } from "@/lib/api/client";

describe("useQuizSession hook", () => {
  const participant = { id: 7, name: "参加者" };
  const question = (id: number) => ({
    id,
    question: `Question ${id}?`,
    choices: ["A", "B", "C", "D"],
    answerType: "selected" as const,
  });
  const submissionId = "00000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    vi.mocked(fetchLatestAnswerSubmission).mockClear();
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValue(null);
    let uuidSequence = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
    );
  });

  function setupFetch(
    overrides: {
      batch?: (body: Record<string, unknown>) => unknown | Promise<unknown>;
      getSubmission?: () => unknown | Promise<unknown>;
      freeTextFifth?: boolean;
    } = {},
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session") {
        return { ok: true, json: async () => ({ participant }) };
      }
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return {
          ok: true,
          json: async () =>
            id === 5 && overrides.freeTextFifth
              ? { ...question(id), choices: [], answerType: "freeText" }
              : question(id),
        };
      }
      if (url.startsWith("/api/answers/batch") && !init?.method) {
        const result = await overrides.getSubmission?.();
        return { ok: true, json: async () => result };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const result = await overrides.batch?.(body);
        return { ok: true, json: async () => result ?? { submissionId, revision: 1 } };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function start() {
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("ready"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    return hook;
  }

  async function answerAll(result: { current: ReturnType<typeof useQuizSession> }) {
    for (const quiz of result.current.quizzes) {
      act(() => result.current.select(quiz.question.id, 2));
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries loading from the retained question cursor", async () => {
    let failed = false;
    const requested: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      requested.push(url);
      const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
      if (id === 3 && !failed) {
        failed = true;
        return { ok: false, status: 500, json: async () => ({ message: "temporary failure" }) };
      }
      return { ok: true, json: async () => question(id) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("ready"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("load-error"));
    act(() => hook.result.current.retryLoad());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(requested).toEqual([
      "/api/questions/next",
      "/api/questions/next?afterId=1",
      "/api/questions/next?afterId=2",
      "/api/questions/next?afterId=2",
      "/api/questions/next?afterId=3",
      "/api/questions/next?afterId=4",
    ]);
    expect(hook.result.current.quizzes.map(({ question: item }) => item.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("loads five questions, keeps selections local, blocks incomplete submit, then posts one batch", async () => {
    const fetchMock = setupFetch();
    const { result } = await start();
    expect(result.current.quizzes.map(({ question: item }) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/participants/session",
      "/api/questions/next",
      "/api/questions/next?afterId=1",
      "/api/questions/next?afterId=2",
      "/api/questions/next?afterId=3",
      "/api/questions/next?afterId=4",
    ]);

    act(() => result.current.select(1, 2));
    act(() => void result.current.saveAnswers());
    expect(result.current.selections[1]).toBe(2);
    expect(result.current.answeredCount).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/answers/batch")).toBe(false);

    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(result.current.answeredCount).toBe(5);
    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]?.[1]?.body));
    expect(body).toMatchObject({ submissionId, expectedRevision: 0 });
    expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.answers).toHaveLength(5);
    expect(body.answers.map((answer: { questionId: number }) => answer.questionId)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(body.answers.map((answer: { selectedIndex: number }) => answer.selectedIndex)).toEqual(
      result.current.quizzes.map(({ shuffled }) => shuffled.choiceIndices[2]),
    );
  });

  it("locks duplicate submits while a batch request is pending", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const fetchMock = setupFetch({ batch: () => gate });
    const { result } = await start();
    await answerAll(result);
    act(() => {
      void result.current.saveAnswers();
      void result.current.saveAnswers();
    });
    await waitFor(() => expect(result.current.phase.kind).toBe("submitting"));
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    await act(async () => release({ submissionId, revision: 1 }));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
  });

  it("retries an uncertain batch with the same operation ID and exact payload", async () => {
    const attempts: string[] = [];
    let shouldFail = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        attempts.push(String(init.body));
        if (shouldFail) {
          shouldFail = false;
          throw new Error("network failure");
        }
        return { ok: true, json: async () => ({ submissionId, revision: 1 }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("answering");
    expect(result.current.phase).toMatchObject({ retryRequired: true });
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
  });

  it("restores saved answers by choice index, revises the same submission, and recovers a conflict with GET", async () => {
    const fetchMock = setupFetch({
      batch: async (body) => {
        if (body.expectedRevision === 1) return { submissionId, revision: 2 };
        return { submissionId, revision: 1 };
      },
      getSubmission: () => ({
        submissionId,
        revision: 1,
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected",
          selectedIndex: 1,
          freeText: null,
        })),
      }),
    });
    const { result } = await start();
    const firstAttemptId = result.current.submissionId;
    const firstChoice = result.current.quizzes[0]!.shuffled.choiceIndices.indexOf(1);
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");

    act(() => result.current.editAnswers());
    expect(result.current.answeredCount).toBe(5);
    expect(result.current.selections[1]).toBe(2);
    act(() => result.current.select(1, firstChoice));
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
    );
    const firstBody = JSON.parse(String(posts[0]?.[1]?.body));
    const revisedBody = JSON.parse(String(posts[1]?.[1]?.body));
    expect(firstBody.submissionId).toBe(firstAttemptId);
    expect(revisedBody.submissionId).toBe(firstAttemptId);
    expect(revisedBody.expectedRevision).toBe(1);
    expect(revisedBody.answers[0].selectedIndex).toBe(1);

    // Simulate an optimistic concurrency conflict, followed by restoring canonical display indices.
    let conflictSubmissionId = "";
    const conflictFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?"))
        return {
          ok: true,
          json: async () => ({
            submissionId: conflictSubmissionId,
            revision: 3,
            answers: [1, 2, 3, 4, 5].map((questionId) => ({
              questionId,
              answerKind: "selected",
              selectedIndex: 3,
              freeText: null,
            })),
          }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", conflictFetch);
    const conflictHook = await start();
    conflictSubmissionId = conflictHook.result.current.submissionId!;
    await answerAll(conflictHook.result);
    await act(async () => conflictHook.result.current.saveAnswers());
    expect(conflictHook.result.current.phase.kind).toBe("answering");
    expect(conflictHook.result.current.phase).toMatchObject({
      message: expect.stringContaining("保存済み回答"),
    });
    expect(conflictHook.result.current.savedSelections[1]).toBe(
      conflictHook.result.current.quizzes[0]!.shuffled.choiceIndices.indexOf(3),
    );
    expect(
      conflictFetch.mock.calls.some(([url]) =>
        String(url).startsWith("/api/answers/batch?submissionId="),
      ),
    ).toBe(true);
  });

  it("replaces a legacy Q5 answer with new free text when revising a saved submission", async () => {
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValue({
      submissionId,
      revision: 4,
      answers: [
        ...[1, 2, 3, 4].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 1,
          freeText: null,
        })),
        {
          questionId: 5,
          answerKind: "legacy" as const,
          selectedIndex: 2,
          freeText: null,
        },
      ],
    });
    const fetchMock = setupFetch({
      freeTextFifth: true,
      batch: () => ({ submissionId, revision: 5 }),
    });
    const { result } = renderHook(() => useQuizSession());

    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.revision).toBe(4);
    expect(result.current.legacyAnswerIds).toEqual([5]);
    expect(result.current.freeResponses[5]).toBeUndefined();

    act(() => result.current.editAnswers());
    expect(result.current.phase.kind).toBe("answering");
    act(() => result.current.setFreeResponse(5, "新しい自由記載回答"));
    await act(async () => result.current.saveAnswers());

    expect(result.current.phase.kind).toBe("complete");
    expect(result.current.revision).toBe(5);
    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]?.[1]?.body));
    expect(body).toMatchObject({ submissionId, expectedRevision: 4 });
    expect(body.answers[4]).toEqual({ questionId: 5, freeText: "新しい自由記載回答" });
    expect(body.answers[4]).not.toHaveProperty("selectedIndex");
    expect(body.answers[4]).not.toHaveProperty("answerKind");
  });

  it("locks correction when a successful POST returns a different submission ID", async () => {
    const fetchMock = setupFetch({
      batch: (body) =>
        body.expectedRevision === 0
          ? { submissionId, revision: 1 }
          : { submissionId: "00000000-0000-4000-8000-000000000002", revision: 2 },
    });
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });

    act(() => result.current.editAnswers());
    act(() => result.current.select(1, 0));
    await act(async () => result.current.saveAnswers());

    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
    expect(result.current.revision).toBe(1);
    act(() => result.current.editAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/answers/batch")).toHaveLength(2);
  });

  it("shows login after session lookup failure and keeps login errors visible", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: "名前またはPINが違います" }),
        };
      throw new Error("session unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.access.kind).toBe("login"));
    expect(result.current.access).toMatchObject({
      message: "参加状態を確認できませんでした。お名前とPINを入力してください。",
    });
    await act(async () => {
      await expect(result.current.login("参加者", "0000")).rejects.toThrow(
        "名前またはPINが違います",
      );
    });
    expect(result.current.access).toMatchObject({
      kind: "login",
      message: "名前またはPINが違います",
    });
  });

  it("offers a shortage state when fewer than five questions remain", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/next") return { ok: true, json: async () => question(1) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.access.kind).toBe("ready"));
    await waitFor(() => expect(result.current.phase.kind).toBe("shortage"));
    expect(result.current.quizzes.map(({ question: item }) => item.id)).toEqual([1]);
  });

  it("keeps an explicitly rejected draft editable and gives changed answers a new retry operation", async () => {
    const attempts: Array<Record<string, unknown>> = [];
    let rejectFirst = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        attempts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (rejectFirst) {
          rejectFirst = false;
          return {
            ok: false,
            status: 400,
            json: async () => ({ message: "回答を確認してください" }),
          };
        }
        return { ok: true, json: async () => ({ submissionId, revision: 1 }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({
      kind: "answering",
      message: "回答を確認してください",
      retryRequired: false,
    });
    expect(result.current.answeredCount).toBe(5);
    act(() => result.current.select(1, 1));
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.operationId).not.toBe(attempts[1]?.operationId);
  });

  it("retains Q5 free text and resends the same operation after same-participant reauthentication", async () => {
    const attempts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return {
          ok: true,
          json: async () =>
            id === 5
              ? { ...question(5), choices: [], answerType: "freeText" as const }
              : question(id),
        };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        attempts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (attempts.length > 1)
          return { ok: true, json: async () => ({ submissionId, revision: 1 }) };
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: "ログイン期限が切れました" }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      act(() => result.current.select(quiz.question.id, 2));
    }
    act(() => result.current.setFreeResponse(5, "  監査済みの端末を利用します。  "));
    await act(async () => result.current.saveAnswers());
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    expect(result.current.answeredCount).toBe(5);
    expect(result.current.freeResponses[5]).toBe("  監査済みの端末を利用します。  ");

    await act(async () => result.current.login("参加者", "1234"));
    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    expect(result.current.answeredCount).toBe(5);
    expect(result.current.freeResponses[5]).toBe("  監査済みの端末を利用します。  ");
    expect(vi.mocked(fetchLatestAnswerSubmission)).toHaveBeenCalledTimes(2);

    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId);
    expect(attempts[1]?.answers).toEqual(attempts[0]?.answers);
    expect(attempts[1]?.answers).toContainEqual({
      questionId: 5,
      freeText: "監査済みの端末を利用します。",
    });
  });

  it("clears the previous participant draft when reauthentication succeeds as another participant", async () => {
    const otherParticipant = { id: 8, name: "別の参加者" };
    const attempts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({
            participant: otherParticipant,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        attempts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return attempts.length === 1
          ? { ok: false, status: 401, json: async () => ({ message: "expired" }) }
          : { ok: true, json: async () => ({ submissionId, revision: 1 }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    const previousSubmissionId = result.current.submissionId;
    await act(async () => result.current.saveAnswers());
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });

    await act(async () => result.current.login("別の参加者", "5678"));
    await waitFor(() =>
      expect(result.current.access).toEqual({ kind: "ready", participant: otherParticipant }),
    );
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(result.current.selections).toEqual({});
    expect(result.current.answeredCount).toBe(0);
    expect(result.current.submissionId).not.toBe(previousSubmissionId);
    expect(vi.mocked(fetchLatestAnswerSubmission)).toHaveBeenCalledTimes(2);

    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.operationId).not.toBe(attempts[0]?.operationId);
  });

  it("retains a draft when conflict refresh fails, then refreshes saved answers on request", async () => {
    let getFails = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?")) {
        if (getFails) {
          getFails = false;
          return {
            ok: false,
            status: 503,
            json: async () => ({ message: "一時的に確認できません" }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            submissionId,
            revision: 4,
            answers: [1, 2, 3, 4, 5].map((questionId) => ({
              questionId,
              answerKind: "selected",
              selectedIndex: 0,
              freeText: null,
            })),
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });
    expect(result.current.answeredCount).toBe(5);
    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.phase).toMatchObject({
      kind: "answering",
      message: expect.stringContaining("編集中の回答案は保持されています"),
    });
    expect(result.current.phase).not.toHaveProperty("refreshRequired");
    expect(result.current.revision).toBe(4);
    expect(result.current.answeredCount).toBe(5);
  });

  it("clears participant data after switching and restores access if session deletion fails", async () => {
    let deletionFails = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        if (deletionFails) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true };
      }
      if (_url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (_url.startsWith("/api/questions/next")) {
        const id = Number(_url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      throw new Error(`Unexpected request: ${_url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    deletionFails = true;
    await act(async () => {
      await expect(result.current.switchParticipant()).rejects.toThrow();
    });
    expect(result.current.access).toEqual({ kind: "ready", participant });
    deletionFails = false;
    await act(async () => result.current.switchParticipant());
    expect(result.current.access).toEqual({ kind: "login" });
    expect(result.current.phase).toEqual({ kind: "ready" });
    expect(result.current.quizzes).toEqual([]);
    expect(result.current.selections).toEqual({});
    expect(result.current.submissionId).toBeNull();
  });

  it("ignores actions that do not match the current session phase", async () => {
    vi.mocked(fetchLatestAnswerSubmission).mockReset().mockResolvedValue(null);
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    act(() => {
      result.current.select(1, 0);
      void result.current.saveAnswers();
      void result.current.refreshSavedAnswers();
      result.current.editAnswers();
      result.current.retryLoad();
      void result.current.switchParticipant();
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/questions/next")),
    ).toBe(false);
    await waitFor(() => expect(result.current.access.kind).toBe("ready"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    await waitFor(() => expect(result.current.quizzes).toHaveLength(5));
    const initialPhase = result.current.phase;
    const initialSelections = result.current.selections;
    act(() => {
      void result.current.saveAnswers();
      void result.current.refreshSavedAnswers();
      result.current.editAnswers();
      result.current.retryLoad();
    });
    expect(result.current.phase).toEqual(initialPhase);
    expect(result.current.selections).toEqual(initialSelections);
  });

  it("blocks selection while a submit is pending", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    setupFetch({ batch: () => gate });
    const { result } = await start();
    await answerAll(result);
    await act(async () => {
      const saving = result.current.saveAnswers();
      result.current.select(1, 3);
      expect(result.current.selections[1]).toBe(2);
      release({ submissionId, revision: 1 });
      await saving;
    });
    expect(result.current.phase.kind).toBe("complete");
  });

  it("keeps completion locked when conflict recovery returns a different submission", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?"))
        return {
          ok: true,
          json: async () => ({
            submissionId: "00000000-0000-4000-8000-000000000002",
            revision: 2,
            answers: [1, 2, 3, 4, 5].map((questionId) => ({
              questionId,
              answerKind: "selected",
              selectedIndex: 0,
              freeText: null,
            })),
          }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
    expect(result.current.answeredCount).toBe(5);
    act(() => result.current.editAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });
  });

  it("requires reauthentication when conflict recovery and manual refresh return 401", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: false,
          status: 401,
          json: async () => ({
            message: "認証が必要です",
            participant,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?"))
        return { ok: false, status: 401, json: async () => ({ message: "認証が必要です" }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });
    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    await act(async () => {
      await expect(result.current.login("参加者", "1234")).rejects.toThrow("認証が必要です");
    });
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
  });

  it("starts a session after login and does not replace reauthentication with a failed login state", async () => {
    let sessionExists = false;
    let loginFails = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST") {
        if (loginFails)
          return { ok: false, status: 401, json: async () => ({ message: "PIN error" }) };
        sessionExists = true;
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      }
      if (url === "/api/participants/session")
        return {
          ok: true,
          json: async () => ({ participant: sessionExists ? participant : null }),
        };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 401, json: async () => ({ message: "expired" }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.access.kind).toBe("login"));
    await act(async () => result.current.login("参加者", "1234"));
    expect(result.current.access).toEqual({ kind: "ready", participant });
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.access.kind).toBe("reauthentication");
    loginFails = true;
    await act(async () => {
      await expect(result.current.login("参加者", "0000")).rejects.toThrow("PIN error");
    });
    expect(result.current.access.kind).toBe("reauthentication");
  });

  it("retains, retries, and edits a fifth-question free-text answer", async () => {
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return {
          ok: true,
          json: async () =>
            id === 5 ? { ...question(5), choices: [], answerType: "freeText" } : question(id),
        };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (posts.length === 1)
          return { ok: false, status: 503, json: async () => ({ message: "一時的な通信エラー" }) };
        return { ok: true, json: async () => ({ submissionId, revision: 1 }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      act(() => result.current.select(quiz.question.id, 1));
    }
    act(() => result.current.setFreeResponse(5, "  承認済みの環境を上司に確認します。  "));
    expect(result.current.answeredCount).toBe(5);

    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    expect(result.current.freeResponses[5]).toBe("  承認済みの環境を上司に確認します。  ");
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    const retriedPayload = posts[1];
    expect(retriedPayload?.operationId).toBe(posts[0]?.operationId);
    expect(retriedPayload?.answers).toContainEqual({
      questionId: 5,
      freeText: "承認済みの環境を上司に確認します。",
    });
    if (!retriedPayload) throw new Error("Expected a retry payload");
    const submittedFifthAnswer = (
      retriedPayload.answers as { questionId: number; selectedIndex?: number; freeText?: string }[]
    ).find(({ questionId }) => questionId === 5);
    expect(submittedFifthAnswer).toEqual({
      questionId: 5,
      freeText: "承認済みの環境を上司に確認します。",
    });

    act(() => result.current.editAnswers());
    expect(result.current.freeResponses[5]).toBe("  承認済みの環境を上司に確認します。  ");
  });

  it("revisits the latest saved submission in completion and restores answers for correction", async () => {
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 3,
      answers: [
        ...[1, 2, 3, 4].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: questionId % 4,
          freeText: null,
        })),
        {
          questionId: 5,
          answerKind: "freeText" as const,
          selectedIndex: null,
          freeText: "回答を保存しました。",
        },
      ],
    });
    setupFetch({ freeTextFifth: true });
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.revision).toBe(3);
    expect(result.current.selections).toEqual(
      Object.fromEntries(
        result.current.quizzes
          .slice(0, 4)
          .map(({ question, shuffled }) => [
            question.id,
            shuffled.choiceIndices.indexOf(question.id % 4),
          ]),
      ),
    );
    expect(result.current.freeResponses[5]).toBe("回答を保存しました。");
    expect(result.current.restoreError).toBeNull();

    act(() => result.current.editAnswers());
    expect(result.current.phase.kind).toBe("answering");
    expect(result.current.selections).toEqual(result.current.savedSelections);
  });

  it("keeps malformed latest submissions complete and disables answer restoration", async () => {
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 1,
      answers: [],
    });
    setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.restoreError).toMatch(/復元できません/);
    expect(result.current.submissionId).toBe(submissionId);
  });

  it("does not start an attempt after a latest-submission failure and retries the lookup", async () => {
    vi.mocked(fetchLatestAnswerSubmission)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(null);
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("submission-error"));
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/questions/next")),
    ).toBe(false);

    act(() => result.current.retrySubmissionCheck());
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(fetchLatestAnswerSubmission).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/questions/next")).toBe(true);
  });
});
