import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useQuizSession } from "@/app/answer/use-quiz-session";

describe("useQuizSession hook", () => {
  const question = (id: number) => ({
    id,
    question: `Question ${id}?`,
    choices: ["A", "B", "C", "D"],
  });

  const answerResult = {
    isCorrect: true,
    correctIndex: 0,
    explanation: "API grading fields are ignored by the session UI.",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and holds the first five questions in ascending cursor order", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const match = url.match(/afterId=(\d+)/);
      const id = match ? Number(match[1]) + 1 : 1;
      return { ok: true, json: async () => question(id) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("question"));

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/questions/next",
      "/api/questions/next?afterId=1",
      "/api/questions/next?afterId=2",
      "/api/questions/next?afterId=3",
      "/api/questions/next?afterId=4",
    ]);
    expect(result.current.quiz?.question).toEqual(question(1));
    expect(result.current.recordedCount).toBe(0);
  });

  it("shows shortage when fewer than five questions are available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return id <= 2 ? { ok: true, json: async () => question(id) } : { status: 404, ok: false };
      }),
    );

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("shortage"));
    expect(result.current.quiz?.question).toEqual(question(1));
  });

  it("keeps acquired questions and retries only the missing suffix after a network error", async () => {
    let failed = false;
    const fetchMock = vi.fn(async (url: string) => {
      const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
      if (id === 3 && !failed) {
        failed = true;
        throw new Error("Network failure");
      }
      return { ok: true, json: async () => question(id) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("error"));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase.kind).toBe("question"));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls.slice(3).map(([url]) => url)).toEqual([
      "/api/questions/next?afterId=2",
      "/api/questions/next?afterId=3",
      "/api/questions/next?afterId=4",
    ]);
  });

  it("confirms an answer, records it, and advances without exposing grading data", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      return { ok: true, json: async () => answerResult };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("question"));
    expect(result.current.quiz?.question.id).toBe(1);

    act(() => result.current.select(0));
    expect(result.current.phase).toEqual({ kind: "question", selectedIndex: 0 });
    await act(async () => result.current.confirm());

    expect(result.current.phase.kind).toBe("question");
    expect(result.current.quiz?.question.id).toBe(2);
    expect(result.current.recordedCount).toBe(1);
    await act(async () => result.current.confirm());
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/answers")).toHaveLength(1);
  });

  it("retains a failed selection and resends it only after explicit retry", async () => {
    let answerFailed = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      if (url === "/api/answers" && answerFailed) {
        answerFailed = false;
        throw new Error("Answer API error");
      }
      return { ok: true, json: async () => answerResult };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("question"));
    act(() => result.current.select(2));
    await act(async () => result.current.confirm());

    expect(result.current.phase).toMatchObject({ kind: "error", selectedIndex: 2 });
    expect(result.current.recordedCount).toBe(0);
    await act(async () => result.current.resendAnswer());
    expect(result.current.phase.kind).toBe("question");
    expect(result.current.quiz?.question.id).toBe(2);
    expect(result.current.recordedCount).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/answers")).toHaveLength(2);
  });

  it("completes after five successful records and does not repost completed answers", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/questions/next")) {
        const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
        return { ok: true, json: async () => question(id) };
      }
      return { ok: true, json: async () => answerResult };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("question"));
    for (let index = 0; index < 5; index += 1) {
      act(() => result.current.select(0));
      await act(async () => result.current.confirm());
      if (index < 4) {
        expect(result.current.phase.kind).toBe("question");
        expect(result.current.quiz?.question.id).toBe(index + 2);
      }
    }

    expect(result.current.phase.kind).toBe("complete");
    expect(result.current.recordedCount).toBe(5);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/answers")).toHaveLength(5);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/questions/next")),
    ).toHaveLength(5);
  });

  it("restart clears the session and fetches the first five questions again", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/answers") {
        return { ok: true, json: async () => answerResult };
      }
      const id = Number(url.match(/afterId=(\d+)/)?.[1] ?? 0) + 1;
      return { ok: true, json: async () => question(id) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("question"));
    act(() => result.current.select(1));
    await act(async () => result.current.confirm());
    await waitFor(() => expect(result.current.recordedCount).toBe(1));

    act(() => result.current.restart());
    await waitFor(() => expect(result.current.phase.kind).toBe("question"));
    expect(result.current.quiz?.question.id).toBe(1);
    expect(result.current.recordedCount).toBe(0);
    const questionCalls = fetchMock.mock.calls.filter(([url]) =>
      url.includes("/api/questions/next"),
    );
    expect(questionCalls.slice(5).map(([url]) => url)).toEqual([
      "/api/questions/next",
      "/api/questions/next?afterId=1",
      "/api/questions/next?afterId=2",
      "/api/questions/next?afterId=3",
      "/api/questions/next?afterId=4",
    ]);
  });
});
