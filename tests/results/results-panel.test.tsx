import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import ResultsPanel from "@/app/results/results-panel";

afterEach(() => vi.unstubAllGlobals());

const visibleResult = {
  state: "visible" as const,
  rank: 2,
  score: 1,
  questions: [
    {
      position: 0,
      question: "最初の問題",
      answer: { kind: "selected" as const, value: "選択した回答", correctness: "correct" as const },
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

  it("removes all visible details and shows 回答中 when a refresh observes that results are private", async () => {
    mockPoll({ state: "waiting" });

    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("1点")).toBeVisible();
    expect(screen.getByText("問題 1")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();
    expect(screen.getByText("正解")).toBeVisible();

    expect(fetch).not.toHaveBeenCalled();
    setVisibility("visible");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("回答中"));
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
    expect(screen.queryByText("1点")).not.toBeInTheDocument();
    expect(screen.queryByText("問題 1")).not.toBeInTheDocument();
    expect(screen.queryByText("最初の問題")).not.toBeInTheDocument();
    expect(screen.queryByText("選択した回答")).not.toBeInTheDocument();
    expect(screen.queryByText("正解")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/participants/results", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it.each([
    { label: "unknown state", payload: { state: "unexpected" } },
    { label: "empty questions", payload: { ...visibleResult, questions: [] } },
    { label: "score above question count", payload: { ...visibleResult, score: 2 } },
    {
      label: "malformed question",
      payload: {
        ...visibleResult,
        questions: [{ position: -1, question: "不正な問題", answer: { kind: "unanswered" } }],
      },
    },
  ])("clears prior details when a refresh returns an $label payload", async ({ payload }) => {
    mockPoll(payload);

    render(<ResultsPanel initial={visibleResult} />);

    expect(screen.getByText("2位")).toBeVisible();
    expect(screen.getByText("最初の問題")).toBeVisible();
    expect(screen.getByText("選択した回答")).toBeVisible();

    expect(fetch).not.toHaveBeenCalled();
    setVisibility("visible");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "結果を確認できません" })).toBeVisible(),
    );
    expect(screen.queryByText("2位")).not.toBeInTheDocument();
    expect(screen.queryByText("1点")).not.toBeInTheDocument();
    expect(screen.queryByText("問題 1")).not.toBeInTheDocument();
    expect(screen.queryByText("最初の問題")).not.toBeInTheDocument();
    expect(screen.queryByText("選択した回答")).not.toBeInTheDocument();
  });

  it("renders each answer kind, correctness label, null score text, and one-based question number", () => {
    mockPoll({ state: "waiting" });

    render(
      <ResultsPanel
        initial={{
          state: "visible",
          rank: 1,
          score: 5,
          questions: [
            {
              position: 0,
              question: "正解の問題",
              answer: { kind: "selected", value: "選択 A", correctness: "correct" },
            },
            {
              position: 1,
              question: "不正解の問題",
              answer: { kind: "selected", value: "選択 B", correctness: "incorrect" },
            },
            {
              position: 2,
              question: "判定なしの問題",
              answer: { kind: "selected", value: "選択 C", correctness: "unavailable" },
            },
            {
              position: 3,
              question: "自由記述の問題",
              answer: { kind: "freeText", value: "自由記述回答", score: 0.75 },
            },
            {
              position: 4,
              question: "スコアなしの問題",
              answer: { kind: "freeText", value: "記録なし回答", score: null },
            },
            {
              position: 5,
              question: "未回答の問題",
              answer: { kind: "unanswered" },
            },
            {
              position: 6,
              question: "旧形式の問題",
              answer: { kind: "legacy" },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("問題 1")).toBeVisible();
    expect(screen.getByText("問題 7")).toBeVisible();
    expect(screen.getByText("選択 A")).toBeVisible();
    expect(screen.getByText("正解")).toBeVisible();
    expect(screen.getByText("選択 B")).toBeVisible();
    expect(screen.getByText("不正解")).toBeVisible();
    expect(screen.getByText("回答を確認できません")).toBeVisible();
    expect(screen.queryByText("選択 C")).not.toBeInTheDocument();
    expect(screen.getByText("自由記述回答")).toBeVisible();
    expect(screen.getByText(/記録済みスコア:/)).toHaveTextContent("0.75");
    expect(screen.getByText("記録なし回答")).toBeVisible();
    expect(screen.getByText("設問別スコアは記録されていません")).toBeVisible();
    expect(screen.getByText("未回答")).toBeVisible();
    expect(screen.getByText("この回答の詳細は確認できません")).toBeVisible();
  });

  it("shows the unavailable state without inventing a zero score for a participant with no snapshot entry", () => {
    mockPoll({ state: "unavailable" });

    render(<ResultsPanel initial={{ state: "unavailable" }} />);

    expect(screen.getByRole("heading", { name: "結果を確認できません" })).toBeVisible();
    expect(screen.queryByText("0点")).not.toBeInTheDocument();
    expect(screen.getByText("あなたの結果はまだ準備されていません。")).toBeVisible();
  });
});
