import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ShareManager from "@/app/results/share-manager";

const token = `v1.${"a".repeat(43)}.${"b".repeat(43)}`;

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const state = (overrides: Record<string, unknown> = {}) => ({
  exists: false,
  issuedAt: null,
  expiresAt: null,
  expired: false,
  ...overrides,
});

describe("ShareManager", () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it("loads an expired share and stops it successfully when issuing is disabled", async () => {
    let resolveStop!: (value: ReturnType<typeof response>) => void;
    const pendingStop = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveStop = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          state({
            exists: true,
            issuedAt: "2026-10-01T00:00:00.000Z",
            expiresAt: "2026-10-02T00:00:00.000Z",
            expired: true,
          }),
        ),
      )
      .mockReturnValueOnce(pendingStop);
    vi.stubGlobal("fetch", fetchMock);
    render(<ShareManager canIssue={false} />);

    expect(await screen.findByText(/共有URLは期限切れです。/)).toBeVisible();
    expect(screen.getByRole("button", { name: "共有URLを再発行" })).toBeDisabled();
    expect(screen.getByText("結果が公開されると発行・再発行できます。")).toBeVisible();
    const stopButton = screen.getByRole("button", { name: "共有を停止" });
    act(() => {
      fireEvent.click(stopButton);
      fireEvent.click(stopButton);
    });
    expect(screen.getByRole("button", { name: "処理中…" })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    resolveStop(response({ stopped: true }));
    expect(await screen.findByRole("status")).toHaveTextContent("共有を停止しました。");
    expect(screen.queryByRole("button", { name: "共有を停止" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/participants/results/share",
      expect.objectContaining({ method: "DELETE", cache: "no-store" }),
    );
  });

  it("issues, copies, and stops a share URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(state()))
      .mockResolvedValueOnce(
        response({
          path: `/shared-results/${token}`,
          issuedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-10-31T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(response({ stopped: true }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ShareManager canIssue />);

    fireEvent.click(await screen.findByRole("button", { name: "共有URLを発行" }));
    const input = await screen.findByRole("textbox", { name: "共有URL" });
    expect(input).toHaveValue(`${window.location.origin}/shared-results/${token}`);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "再発行すると以前のURLは使えなくなります。",
    );
    expect(screen.getByRole("button", { name: "共有URLを再発行" })).toBeEnabled();
    fireEvent.focus(input);

    fireEvent.click(screen.getByRole("button", { name: "URLをコピー" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共有URLをコピーしました。");
    expect(writeText).toHaveBeenCalledWith(input.getAttribute("value"));

    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "URLをコピー" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "URL欄を選択して手動でコピーしてください。",
    );

    fireEvent.click(screen.getByRole("button", { name: "共有を停止" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共有を停止しました。");
    expect(screen.queryByRole("textbox", { name: "共有URL" })).not.toBeInTheDocument();
  });

  it("does not send duplicate issue requests and reports an unpublished result", async () => {
    let resolveIssue!: (value: ReturnType<typeof response>) => void;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveIssue = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(state()))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(response({ error: "other" }, false, 503));
    vi.stubGlobal("fetch", fetchMock);
    render(<ShareManager canIssue />);

    const issueButton = await screen.findByRole("button", { name: "共有URLを発行" });
    act(() => {
      fireEvent.click(issueButton);
      fireEvent.click(issueButton);
    });
    expect(screen.getByRole("button", { name: "処理中…" })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    resolveIssue(response({ error: "SHARE_NOT_PUBLISHED" }, false, 409));
    expect(await screen.findByRole("status")).toHaveTextContent("結果公開中のみ発行できます。");

    fireEvent.click(screen.getByRole("button", { name: "共有URLを発行" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("共有URLを発行できませんでした。"),
    );
  });

  it("reports load, issue, and stop failures without exposing an invalid share URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ malformed: true }))
      .mockResolvedValueOnce(response({ error: "other" }, false, 503));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ShareManager canIssue />);
    expect(await screen.findByRole("status")).toHaveTextContent("共有状態を読み込めませんでした。");

    fireEvent.click(screen.getByRole("button", { name: "共有URLを発行" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共有URLを発行できませんでした。");
    expect(screen.queryByRole("textbox", { name: "共有URL" })).not.toBeInTheDocument();

    view.unmount();
  });

  it("reports a non-success share-state response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(state(), false, 503)));
    render(<ShareManager canIssue />);
    expect(await screen.findByRole("status")).toHaveTextContent("共有状態を読み込めませんでした。");
  });

  it("reports a stop HTTP failure for an existing share", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(state({ exists: true })))
      .mockResolvedValueOnce(response({ stopped: false }, false, 503));
    vi.stubGlobal("fetch", fetchMock);
    render(<ShareManager canIssue />);
    await screen.findByRole("button", { name: "共有を停止" });
    fireEvent.click(screen.getByRole("button", { name: "共有を停止" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共有を停止できませんでした。");
  });

  it("reports network errors for loading, issuing, and stopping", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("load unavailable"))
      .mockRejectedValueOnce(new Error("issue unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ShareManager canIssue />);
    expect(await screen.findByRole("status")).toHaveTextContent("共有状態を読み込めませんでした。");

    fireEvent.click(screen.getByRole("button", { name: "共有URLを発行" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共有URLを発行できませんでした。");

    view.unmount();
    fetchMock.mockResolvedValueOnce(
      response(state({ exists: true, issuedAt: null, expiresAt: null })),
    );
    render(<ShareManager canIssue />);
    await screen.findByRole("button", { name: "共有URLを再発行" });
    fetchMock.mockResolvedValueOnce(response({ stopped: false }, false, 503));
    fireEvent.click(screen.getByRole("button", { name: "共有を停止" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共有を停止できませんでした。");
  });
});
