import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ResultsPanel from "@/app/results/results-panel";

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalVisibilityState) {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

const visibleResult = {
  state: "visible" as const,
  rank: 2,
  score: 1.5,
  questions: [
    {
      position: 0,
      question: "最初の問題",
      answer: {
        kind: "selected" as const,
        value: "選択した回答",
        correctness: "incorrect" as const,
      },
    },
    {
      position: 4,
      question: "自由記述の問題",
      answer: { kind: "freeText" as const, value: "自由記述回答", score: 0.75 },
    },
  ],
};

const mockPoll = (payload: unknown) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    }),
  );
};

const setVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ResultsPanel", () => {
  it("uses the server state initially, skips hidden-tab changes, and refreshes on return", async () => {
    mockPoll(visibleResult);
    setVisibility("visible");

    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位")).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
    setVisibility("hidden");
    expect(fetch).not.toHaveBeenCalled();
    setVisibility("visible");

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/participants/results", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("queues one trailing refresh when tab return happens during a request", async () => {
    const firstResponse = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const secondResponse = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<ResultsPanel initial={visibleResult} />);
    setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstResponse.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
      await firstResponse.promise;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("2位")).toBeVisible();

    await act(async () => {
      secondResponse.resolve({ ok: true, status: 200, json: async () => visibleResult });
      await secondResponse.promise;
    });
    expect(screen.getByText("2位")).toBeVisible();
  });

  it("ignores a poll response superseded while its JSON body is pending", async () => {
    const response = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const secondResponse = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>();
    const body = deferred<unknown>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockReturnValueOnce(secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");
    const json = vi.fn(() => body.promise);
    await act(async () => {
      response.resolve({ ok: true, status: 200, json });
      await response.promise;
    });
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));

    setVisibility("visible");
    await act(async () => {
      body.resolve({ ...visibleResult, rank: 99 });
      await body.promise;
    });

    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.queryByText("99位")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondResponse.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
      await secondResponse.promise;
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("回答中"));
    expect(screen.queryByText("99位")).not.toBeInTheDocument();
  });

  it("ignores a rejected refresh after a newer refresh has been queued", async () => {
    const oldResponse = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>();
    const newResponse = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldResponse.reject(new Error("superseded request failed"));
      await oldResponse.promise.catch(() => undefined);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      newResponse.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...visibleResult, rank: 3 }),
      });
      await newResponse.promise;
    });

    expect(screen.getByText("3位")).toBeVisible();
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("removes rank and score and shows 回答中 when a refresh observes that results are private", async () => {
    mockPoll({ state: "waiting" });

    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("1.5点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(screen.getByText("不正解")).toBeVisible();
    expect(screen.getByText("自由記述回答")).toBeVisible();
    expect(screen.getByText(/記録済みスコア:/)).toHaveTextContent("0.75");

    expect(fetch).not.toHaveBeenCalled();
    setVisibility("visible");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("回答中"));
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
    expect(screen.queryByText("1.5点")).not.toBeInTheDocument();
    expect(screen.queryByText("最初の問題")).not.toBeInTheDocument();
    expect(screen.queryByText("選択した回答")).not.toBeInTheDocument();
    expect(screen.queryByText("不正解")).not.toBeInTheDocument();
    expect(screen.queryByText("自由記述回答")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/participants/results", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it.each([
    { label: "unknown state", payload: { state: "unexpected" } },
    { label: "invalid rank", payload: { ...visibleResult, rank: 0 } },
    { label: "negative score", payload: { ...visibleResult, score: -1 } },
    { label: "score above question count", payload: { ...visibleResult, score: 6 } },
    { label: "empty questions", payload: { ...visibleResult, questions: [] } },
    {
      label: "malformed answer",
      payload: {
        ...visibleResult,
        questions: [
          { position: 0, question: "問題", answer: { kind: "unexpected" } },
          {
            position: 4,
            question: "自由記述の問題",
            answer: { kind: "freeText", value: "自由記述回答", score: 0.75 },
          },
        ],
      },
    },
  ])(
    "preserves prior result and exposes retry when a refresh returns an $label payload",
    async ({ payload }) => {
      mockPoll(payload);

      render(<ResultsPanel initial={visibleResult} />);

      expect(screen.getByText("2位")).toBeVisible();
      expect(screen.getByText("1.5点")).toBeVisible();
      expect(screen.getByText("最初の問題")).toBeVisible();
      expect(screen.getByText("選択した回答")).toBeVisible();

      expect(fetch).not.toHaveBeenCalled();
      setVisibility("visible");
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("表示中の内容は保持しています"),
      );
      expect(screen.getByText("2位")).toBeVisible();
      expect(screen.getByText("1.5点")).toBeVisible();
      expect(screen.getByText("最初の問題")).toBeVisible();
      expect(screen.getByText("選択した回答")).toBeVisible();
    },
  );

  it("renders each question's answer and correctness without exposing other participants", () => {
    mockPoll({ state: "waiting" });
    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("1.5点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(screen.getByText("不正解")).toBeVisible();
    expect(screen.getByText("自由記述回答")).toBeVisible();
    expect(screen.queryByText("全体ランキング")).not.toBeInTheDocument();
  });

  it("shows the unavailable state without inventing a zero score for a participant with no snapshot entry", () => {
    mockPoll({ state: "unavailable" });

    render(<ResultsPanel initial={{ state: "unavailable" }} />);

    expect(screen.getByRole("heading", { name: "結果を確認できません" })).toBeVisible();
    expect(screen.queryByText("0点")).not.toBeInTheDocument();
    expect(screen.getByText("あなたの結果はまだ準備されていません。")).toBeVisible();
  });

  it.each([
    { label: "unknown state", initial: { state: "unexpected" } },
    {
      label: "malformed answer",
      initial: {
        ...visibleResult,
        questions: [{ ...visibleResult.questions[0], answer: { kind: "selected" } }],
      },
    },
  ])("falls back to unavailable for an invalid initial $label payload", ({ initial }) => {
    mockPoll({ state: "waiting" });

    render(
      <ResultsPanel
        initial={initial as unknown as Parameters<typeof ResultsPanel>[0]["initial"]}
      />,
    );

    expect(screen.getByRole("heading", { name: "結果を確認できません" })).toBeVisible();
    expect(screen.getByText("あなたの結果はまだ準備されていません。")).toBeVisible();
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
  });

  it("shows the unauthenticated recovery prompt and clears it after a successful session refresh", async () => {
    mockPoll({ state: "waiting" });

    render(<ResultsPanel initial={{ state: "unauthenticated" }} />);

    expect(screen.getByRole("heading", { name: "参加者セッションを確認できません" })).toBeVisible();
    expect(screen.getByRole("link", { name: "回答画面へ戻る" })).toHaveAttribute("href", "/answer");
    setVisibility("visible");

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("回答中"));
    expect(screen.queryByText("参加者セッションを確認できません")).not.toBeInTheDocument();
  });

  it("returns to the session prompt when polling reports an expired session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, json: async () => ({ state: "waiting" }) }),
    );
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "参加者セッションを確認できません" }),
      ).toBeVisible(),
    );
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回答画面へ戻る" })).toHaveAttribute("href", "/answer");
  });

  it("refreshes manually and removes protected result details after a confirmed waiting response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: "waiting" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("回答中"));
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
    expect(screen.queryByText("最初の問題")).not.toBeInTheDocument();
  });

  it("keeps the last confirmed result when the API returns a server error or the request rejects", async () => {
    const unavailableJson = vi.fn(async () => ({ state: "unavailable" }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: unavailableJson })
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("2位")).toBeVisible();

    setVisibility("visible");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "結果を確認できません" })).not.toBeInTheDocument();
    expect(unavailableJson).not.toHaveBeenCalled();

    setVisibility("visible");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("回答中"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the confirmed result and exposes retry after a current request rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("表示中の内容は保持しています"),
    );
    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not start an unmounted queued refresh after JSON parsing rejects", async () => {
    const response = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<ResultsPanel initial={visibleResult} />);
    setVisibility("visible");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.unmount();
    const staleJson = vi.fn(async () => visibleResult);
    await act(async () => {
      response.resolve({ ok: true, status: 200, json: staleJson });
      await response.promise;
      await Promise.resolve();
    });
    expect(staleJson).not.toHaveBeenCalled();

    const body = deferred<unknown>();
    const pendingJson = vi.fn(() => body.promise);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: pendingJson });
    const second = render(<ResultsPanel initial={visibleResult} />);
    setVisibility("visible");
    await waitFor(() => expect(pendingJson).toHaveBeenCalledTimes(1));
    setVisibility("visible");
    second.unmount();
    await act(async () => {
      body.reject(new Error("body was interrupted"));
      await body.promise.catch(() => undefined);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingJson).toHaveBeenCalledTimes(1);
  });

  it("preserves the last confirmed result when a successful response contains invalid JSON", async () => {
    mockPoll(null);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("{", { status: 200 }));
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("表示中の内容は保持しています"),
    );
    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("1.5点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });

  it("preserves the last confirmed result after parsing a successful response with a null payload", async () => {
    const json = vi.fn(async () => null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("表示中の内容は保持しています"),
    );
    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("1.5点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });

  it("renders selected unavailable, correct, free-text without a score, unanswered, and legacy answers explicitly", () => {
    mockPoll({ state: "waiting" });
    render(
      <ResultsPanel
        initial={{
          state: "visible",
          rank: 1,
          score: 2,
          questions: [
            {
              position: 0,
              question: "選択回答の判定待ち",
              answer: { kind: "selected", value: "確認中の回答", correctness: "unavailable" },
            },
            {
              position: 1,
              question: "正解の問題",
              answer: { kind: "selected", value: "正しい回答", correctness: "correct" },
            },
            {
              position: 2,
              question: "スコア未記録の自由記述",
              answer: { kind: "freeText", value: "自由記述", score: null },
            },
            { position: 3, question: "未回答の問題", answer: { kind: "unanswered" } },
            { position: 4, question: "詳細がない問題", answer: { kind: "legacy" } },
          ],
        }}
      />,
    );

    expect(screen.getByText("回答を確認できません")).toBeVisible();
    expect(screen.getByText("正解")).toBeVisible();
    expect(screen.getByText("設問別スコアは記録されていません")).toBeVisible();
    expect(screen.getByText("未回答")).toBeVisible();
    expect(screen.getByText("この回答の詳細は確認できません")).toBeVisible();
  });

  it.each([
    { label: "a null question", question: null },
    {
      label: "a negative question position",
      question: { ...visibleResult.questions[0], position: -1 },
    },
    { label: "a non-string question", question: { ...visibleResult.questions[0], question: 4 } },
    { label: "a non-record answer", question: { ...visibleResult.questions[0], answer: null } },
  ])("preserves the confirmed result after a refresh contains $label", async ({ question }) => {
    mockPoll({ ...visibleResult, questions: [question] });
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("表示中の内容は保持しています"),
    );
    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("1.5点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });
});
