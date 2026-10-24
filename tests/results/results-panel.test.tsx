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
  participantCount: 5,
  score: 1.5,
  maxScore: 2,
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
  it("does not poll when the result scope is invalid", () => {
    mockPoll(visibleResult);
    render(<ResultsPanel initial={visibleResult} scope={null} />);

    setVisibility("visible");
    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("2位 / 5人")).toBeVisible();
  });

  it("polls the assisted result endpoint and labels the result for the assisted respondent", async () => {
    mockPoll(visibleResult);
    render(<ResultsPanel initial={visibleResult} scope="assisted" />);

    setVisibility("visible");

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/participants/results?scope=assisted", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(screen.getByRole("heading", { name: "代理回答の結果" })).toBeVisible();
    expect(screen.getByRole("link", { name: "自分の結果を見る" })).toHaveAttribute(
      "href",
      "/results",
    );
    expect(
      screen.getByRole("link", { name: "自分の結果を見る" }).getAttribute("href"),
    ).not.toContain("18");
  });

  it("shows the assisted result switch only when an assisted submission exists and keeps IDs out of links", () => {
    const { rerender } = render(
      <ResultsPanel initial={{ state: "waiting" }} scope="owner" hasAssistedSubmission={false} />,
    );
    expect(screen.queryByRole("link", { name: "代理回答の結果を見る" })).not.toBeInTheDocument();

    rerender(<ResultsPanel initial={{ state: "waiting" }} scope="owner" hasAssistedSubmission />);
    const assistedLink = screen.getByRole("link", { name: "代理回答の結果を見る" });
    expect(assistedLink).toHaveAttribute("href", "/results?scope=assisted");
    expect(assistedLink.getAttribute("href")).not.toMatch(/\d/);
  });

  it("uses the server state initially, skips hidden-tab changes, and refreshes on return", async () => {
    mockPoll(visibleResult);
    setVisibility("visible");

    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位 / 5人")).toBeVisible();
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
    expect(screen.getByText("2位 / 5人")).toBeVisible();

    await act(async () => {
      secondResponse.resolve({ ok: true, status: 200, json: async () => visibleResult });
      await secondResponse.promise;
    });
    expect(screen.getByText("2位 / 5人")).toBeVisible();
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

    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.queryByText("99位")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondResponse.resolve({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
      await secondResponse.promise;
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "集計期間中です。結果は公開後に確認できます。",
      ),
    );
    expect(screen.queryByRole("heading", { name: "結果を確認できません" })).not.toBeInTheDocument();
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

    expect(screen.getByText("3位 / 5人")).toBeVisible();
    expect(screen.queryByText("2位 / 5人")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("removes protected details and announces the transition into private waiting", async () => {
    mockPoll({ state: "waiting" });

    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.getByText("1.50点 / 2点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(screen.getByText("不正解")).toBeVisible();
    expect(screen.getByText("自由記述回答")).toBeVisible();
    expect(screen.getByText(/記録済みスコア:/)).toHaveTextContent("0.75");

    expect(fetch).not.toHaveBeenCalled();
    setVisibility("visible");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "集計期間中です。結果は公開後に確認できます。",
      ),
    );
    expect(screen.queryByText("2位 / 5人")).not.toBeInTheDocument();
    expect(screen.queryByText("1.50点")).not.toBeInTheDocument();
    expect(screen.queryByText("最初の問題")).not.toBeInTheDocument();
    expect(screen.queryByText("選択した回答")).not.toBeInTheDocument();
    expect(screen.queryByText("不正解")).not.toBeInTheDocument();
    expect(screen.queryByText("自由記述回答")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/participants/results", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("announces transitions from waiting to visible and unavailable results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => visibleResult })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: "unavailable" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={{ state: "waiting" }} />);

    setVisibility("visible");
    await waitFor(() => expect(screen.getByText("2位 / 5人")).toBeVisible());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("結果を表示しました。"),
    );

    setVisibility("visible");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "結果を確認できません" })).toBeVisible(),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "あなたの結果を確認できません。時間をおいて再読み込みしてください。",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

      expect(screen.getByText("2位 / 5人")).toBeVisible();
      expect(screen.getByText("1.50点 / 2点")).toBeVisible();
      expect(screen.getByText("最初の問題")).toBeVisible();
      expect(screen.getByText("選択した回答")).toBeVisible();

      expect(fetch).not.toHaveBeenCalled();
      setVisibility("visible");
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "あなたの結果" })).toBeVisible(),
      );
      expect(screen.getByText("2位 / 5人")).toBeVisible();
      expect(screen.getByText("1.50点 / 2点")).toBeVisible();
      expect(screen.getByText("最初の問題")).toBeVisible();
      expect(screen.getByText("選択した回答")).toBeVisible();
      expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした");
      expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
    },
  );

  it("renders each question's answer and correctness without exposing other participants", () => {
    mockPoll({ state: "waiting" });
    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.getByText("1.50点 / 2点")).toBeVisible();
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
  });

  it("keeps the initial waiting state free of a persistent message and live announcement", () => {
    mockPoll({ state: "waiting" });

    render(<ResultsPanel initial={{ state: "waiting" }} />);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(
      screen.queryByText("集計期間中です。結果は公開後に確認できます。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });

  it("announces manual transitions from waiting to visible and unavailable, resetting the waiting notice", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => visibleResult })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: "waiting" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: "unavailable" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={{ state: "waiting" }} />);

    const refresh = () => fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    const expectAnnouncement = async (message: string) => {
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-live", "polite");
    };

    refresh();
    await expectAnnouncement("集計期間中です。結果は公開後に確認できます。");

    refresh();
    await expectAnnouncement("結果を表示しました。");
    expect(screen.getByText("2位 / 5人")).toBeVisible();

    refresh();
    await expectAnnouncement("集計期間中です。結果は公開後に確認できます。");

    refresh();
    await expectAnnouncement("あなたの結果を確認できません。時間をおいて再読み込みしてください。");
    expect(screen.getByRole("heading", { name: "結果を確認できません" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    expect(screen.queryByText("2位 / 5人")).not.toBeInTheDocument();
  });

  it("shows the unauthenticated recovery prompt and clears it after a successful session refresh", async () => {
    mockPoll({ state: "waiting" });

    render(<ResultsPanel initial={{ state: "unauthenticated" }} />);

    expect(screen.getByRole("heading", { name: "参加者セッションを確認できません" })).toBeVisible();
    expect(screen.getByRole("link", { name: "回答画面へ戻る" })).toHaveAttribute("href", "/answer");
    setVisibility("visible");

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "集計期間中です。結果は公開後に確認できます。",
      ),
    );
    expect(screen.queryByRole("heading", { name: "結果を確認できません" })).not.toBeInTheDocument();
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

    act(() => setVisibility("visible"));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "参加者セッションを確認できません" }),
      ).toBeVisible(),
    );
    expect(screen.queryByText("2位 / 5人")).not.toBeInTheDocument();
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
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "集計期間中です。結果は公開後に確認できます。",
      ),
    );
    expect(screen.queryByRole("heading", { name: "結果を確認できません" })).not.toBeInTheDocument();
    expect(screen.queryByText("2位 / 5人")).not.toBeInTheDocument();
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
    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした");

    setVisibility("visible");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした");
    expect(screen.queryByRole("heading", { name: "結果を確認できません" })).not.toBeInTheDocument();
    expect(unavailableJson).not.toHaveBeenCalled();

    setVisibility("visible");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "集計期間中です。結果は公開後に確認できます。",
      ),
    );
    expect(screen.queryByRole("heading", { name: "結果を確認できません" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the confirmed result and exposes retry after a current request rejects", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした");
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "集計期間中です。結果は公開後に確認できます。",
      ),
    );
    expect(screen.queryByRole("heading", { name: "結果を確認できません" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("announces a manual refresh once and applies the new result when it resolves", async () => {
    const response = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const button = screen.getByRole("button", { name: "結果を再読み込み" });
    expect(button).toBeDisabled();
    expect(screen.getByText("2位 / 5人")).toBeVisible();
    const refreshStatus = screen.getByRole("status");
    expect(refreshStatus).toHaveTextContent("更新中…");
    expect(refreshStatus.closest("[aria-busy='true']")).toBeNull();
    expect(screen.getAllByText("更新中…")).toHaveLength(1);

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...visibleResult, rank: 1 }),
      });
      await response.promise;
    });

    await waitFor(() => expect(screen.getByText("1位 / 5人")).toBeVisible());
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("starts a manual refresh from the button and queues a duplicate before it settles", async () => {
    const firstResponse = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>();
    const trailingResponse = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(trailingResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    const button = screen.getByRole("button", { name: "結果を再読み込み" });
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeDisabled();

    await act(async () => {
      firstResponse.resolve({ ok: true, status: 200, json: async () => visibleResult });
      await firstResponse.promise;
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      trailingResponse.resolve({ ok: true, status: 200, json: async () => visibleResult });
      await trailingResponse.promise;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });

  it("keeps the confirmed result and restores manual refresh after a deferred rejection", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("更新中…");
    expect(screen.getByText("2位 / 5人")).toBeVisible();

    await act(async () => {
      response.reject(new Error("network unavailable"));
      await response.promise.catch(() => undefined);
    });

    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.queryByText("更新中…")).not.toBeInTheDocument();
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.getByText("1.50点 / 2点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした");
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });

  it("preserves the last confirmed result after parsing a successful response with a null payload", async () => {
    const json = vi.fn(async () => null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsPanel initial={visibleResult} />);

    setVisibility("visible");
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.getByText("1.50点 / 2点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした");
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });

  it("renders selected unavailable, correct, free-text without a score, unanswered, and legacy answers explicitly", () => {
    mockPoll({ state: "waiting" });
    render(
      <ResultsPanel
        initial={{
          state: "visible",
          rank: 1,
          participantCount: 1,
          score: 2,
          maxScore: 5,
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

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.getByText("2位 / 5人")).toBeVisible();
    expect(screen.getByText("1.50点 / 2点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした");
    expect(screen.getByRole("button", { name: "結果を再読み込み" })).toBeEnabled();
  });
});
