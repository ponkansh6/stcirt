import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SharedResultPanel from "@/app/shared-results/shared-result-panel";

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
function setDocumentVisible() {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalVisibilityState) {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

const initial = {
  state: "visible" as const,
  rank: 1,
  isAggregationTarget: true,
  participantCount: 1,
  score: 1,
  maxScore: 1,
  questions: [
    {
      position: 0,
      question: "Protected result detail",
      answer: { kind: "unanswered" as const },
    },
  ],
};
const validToken = `v1.${"c".repeat(43)}.${"d".repeat(43)}`;

describe("SharedResultPanel", () => {
  it("omits participant credentials and clears prior details when the share becomes private", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: "waiting" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedResultPanel token={validToken} initial={initial} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    await screen.findByText("結果は現在公開されていません。");

    expect(screen.queryByText("Protected result detail")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/shared-results/${validToken}`,
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("ignores an older visible response that arrives after a newer 404", async () => {
    let resolveOlder!: (response: Response) => void;
    let resolveNewer!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveOlder = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveNewer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedResultPanel token={validToken} initial={initial} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    setDocumentVisible();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    resolveNewer(new Response(null, { status: 404 }));
    await screen.findByText("この共有URLは無効か、期限が切れています。");
    resolveOlder(
      new Response(JSON.stringify(initial), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Protected result detail")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("この共有URLは無効か、期限が切れています。")).toBeVisible();
  });

  it("ignores an older response when its JSON resolves after a newer refresh", async () => {
    let resolveOlder!: (response: Response) => void;
    let resolveOlderJson!: (payload: unknown) => void;
    let resolveNewer!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveOlder = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveNewer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedResultPanel token={validToken} initial={initial} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    resolveOlder({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => (resolveOlderJson = resolve)),
    } as Response);
    await waitFor(() => expect(resolveOlderJson).toBeDefined());

    setDocumentVisible();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveNewer(new Response(null, { status: 404 }));
    await screen.findByText("この共有URLは無効か、期限が切れています。");
    resolveOlderJson(initial);

    await waitFor(() =>
      expect(screen.queryByText("Protected result detail")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("この共有URLは無効か、期限が切れています。")).toBeVisible();
  });

  it("keeps an unavailable result state and reports refresh failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedResultPanel token={validToken} initial={{ state: "unavailable" }} />);

    expect(screen.getByText("この結果を確認できません。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした。");
  });

  it("reports malformed result payloads and ignores stale decoded responses", async () => {
    let resolveOlder!: (response: Response) => void;
    let resolveNewer!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ invalid: true }) })
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveOlder = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveNewer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedResultPanel token={validToken} initial={initial} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("結果を更新できませんでした。");

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    setDocumentVisible();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    resolveNewer(
      new Response(JSON.stringify({ state: "waiting" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await screen.findByText("結果は現在公開されていません。");
    resolveOlder(
      new Response(JSON.stringify(initial), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Protected result detail")).not.toBeInTheDocument(),
    );
  });

  it("does not refresh on visibility changes while the document is hidden", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedResultPanel token={validToken} initial={initial} />);
    fireEvent(document, new Event("visibilitychange"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppresses errors from an older request after a newer refresh", async () => {
    let rejectOlder!: (error: Error) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((_resolve, reject) => (rejectOlder = reject)),
      )
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ state: "waiting" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedResultPanel token={validToken} initial={initial} />);

    fireEvent.click(screen.getByRole("button", { name: "結果を再読み込み" }));
    setDocumentVisible();
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("結果は現在公開されていません。");
    rejectOlder(new Error("aborted request"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
