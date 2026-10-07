import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import ResultsPanel from "@/app/results/results-panel";

afterEach(() => vi.unstubAllGlobals());

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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ResultsPanel", () => {
  it("uses the server state initially, skips hidden-tab changes, and refreshes on return", async () => {
    mockPoll(visibleResult);

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
  ])("clears prior result when a refresh returns an $label payload", async ({ payload }) => {
    mockPoll(payload);

    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("1.5点")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();

    expect(fetch).not.toHaveBeenCalled();
    setVisibility("visible");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "結果を確認できません" })).toBeVisible(),
    );
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
    expect(screen.queryByText("1.5点")).not.toBeInTheDocument();
    expect(screen.queryByText("最初の問題")).not.toBeInTheDocument();
    expect(screen.queryByText("選択した回答")).not.toBeInTheDocument();
  });

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
});
