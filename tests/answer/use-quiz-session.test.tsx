import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useQuizSession } from "@/app/answer/use-quiz-session";

describe("useQuizSession hook", () => {
  const participant = { id: 7, name: "参加者" };
  const question = (id: number) => ({
    id,
    question: `Question ${id}?`,
    choices: ["A", "B", "C", "D"],
  });
  const submissionId = "00000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    let uuidSequence = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
    );
  });

  function setupFetch(
    overrides: {
      batch?: (body: Record<string, unknown>) => unknown | Promise<unknown>;
      getSubmission?: () => unknown | Promise<unknown>;
    } = {},
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session") {
        return { ok: true, json: async () => ({ participant }) };
      }
      if (url.startsWith("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
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
    act(() => hook.result.current.start());
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
    act(() => hook.result.current.start());
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
        answers: [1, 2, 3, 4, 5].map((questionId) => ({ questionId, selectedIndex: 1 })),
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
            submissionId,
            revision: 3,
            answers: [1, 2, 3, 4, 5].map((questionId) => ({ questionId, selectedIndex: 3 })),
          }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", conflictFetch);
    const conflictHook = await start();
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
});
