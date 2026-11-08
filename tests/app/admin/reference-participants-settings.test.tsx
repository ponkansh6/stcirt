import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReferenceParticipantsSettings from "@/app/admin/presentation/reference-participants/reference-participants-settings";
import ReferenceParticipantsPage from "@/app/admin/presentation/reference-participants/page";

function response(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reference participants settings", () => {
  it("loads, saves, and returns only after the explicit save step", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return response(200, { names: ["A"] });
      expect(JSON.parse(String(init.body))).toEqual({ namesText: " A \nB" });
      return response(200, { names: [" A ", "B"] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    const textarea = await screen.findByLabelText("参考対象の表示名（改行区切り）");
    await user.clear(textarea);
    await user.type(textarea, " A \nB");
    await user.click(screen.getByRole("button", { name: "氏名一覧を保存" }));
    await screen.findByText(/保存しました/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/集計を実行してください/)).toBeInTheDocument();
  });

  it("warns before discarding unsaved edits when returning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, { names: ["A"] })),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ReferenceParticipantsSettings />);
    const textarea = await screen.findByLabelText("参考対象の表示名（改行区切り）");
    fireEvent.change(textarea, { target: { value: "changed" } });
    const link = screen.getByRole("link", { name: "管理画面へ戻る" });
    fireEvent.click(link);
    expect(confirm).toHaveBeenCalledWith(
      "保存していない変更は破棄されます。管理画面へ戻りますか？",
    );
  });

  it("loads the settings page and returns without confirmation when unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, { names: ["A"] })),
    );
    const confirm = vi.spyOn(window, "confirm");
    render(<ReferenceParticipantsPage />);

    expect(await screen.findByLabelText("参考対象の表示名（改行区切り）")).toHaveValue("A");
    const link = screen.getByRole("link", { name: "管理画面へ戻る" });
    const clickResult = fireEvent.click(link);

    expect(confirm).not.toHaveBeenCalled();
    expect(clickResult).toBe(true);
  });

  it("reports a non-ok and malformed settings response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(503, { error: "Unavailable" })),
    );
    render(<ReferenceParticipantsSettings />);
    expect(
      await screen.findByText("設定を読み込めませんでした。時間をおいて再試行してください。"),
    ).toBeInTheDocument();

    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, { names: ["A", 2] })),
    );
    render(<ReferenceParticipantsSettings />);
    expect(await screen.findByText("設定の形式を確認できませんでした。")).toBeInTheDocument();
  });

  it("uses a generic Japanese fallback when a GET error omits its message", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(503, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    expect(
      await screen.findByText("設定を読み込めませんでした。時間をおいて再試行してください。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("参考対象の表示名（改行区切り）")).toBeDisabled();
    const save = screen.getByRole("button", { name: "氏名一覧を保存" }) as HTMLButtonElement;
    expect(save).toBeDisabled();
    save.disabled = false;
    fireEvent.click(save);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "設定を再読み込み" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the fallback message and keeps editing disabled when loading rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    render(<ReferenceParticipantsSettings />);

    expect(
      await screen.findByText("設定を読み込めませんでした。通信状態を確認して再試行してください。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("参考対象の表示名（改行区切り）")).toBeDisabled();
    expect(screen.getByRole("button", { name: "氏名一覧を保存" })).toBeDisabled();
  });

  it("ignores a load rejection after the page unmounts", async () => {
    let rejectLoad!: (reason: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectLoad = reject;
          }),
      ),
    );
    const { unmount } = render(<ReferenceParticipantsSettings />);
    expect(screen.getByRole("status")).toHaveTextContent("設定を読み込んでいます…");
    expect(screen.getByRole("button", { name: "氏名一覧を保存" })).toBeDisabled();
    unmount();
    rejectLoad(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText("late failure")).not.toBeInTheDocument();
  });

  it("handles malformed JSON from both settings requests", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReferenceParticipantsSettings />);

    expect(await screen.findByText("設定の形式を確認できませんでした。")).toBeInTheDocument();
    const textarea = screen.getByLabelText("参考対象の表示名（改行区切り）");
    expect(textarea).toBeDisabled();
    expect(screen.getByRole("button", { name: "氏名一覧を保存" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "設定を再読み込み" }));
    expect(await screen.findByText("設定の形式を確認できませんでした。")).toBeInTheDocument();
  });

  it("handles an initial 401 before parsing JSON and provides a PIN recheck", async () => {
    const unauthorized = new Response("not json", { status: 401 });
    const json = vi.spyOn(unauthorized, "json");
    const fetchMock = vi.fn(async () => unauthorized);
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent("管理者認証が必要です。");
    expect(json).not.toHaveBeenCalled();
    expect(screen.getByLabelText("参考対象の表示名（改行区切り）")).toBeDisabled();
    expect(screen.getByRole("button", { name: "氏名一覧を保存" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "管理画面でPIN認証" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("button", { name: "認証状態を再確認" })).toBeEnabled();
  });

  it("preserves the draft across successful and failed authentication rechecks", async () => {
    const user = userEvent.setup();
    let loadCount = 0;
    let putCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method) {
        putCount += 1;
        return response(401, {});
      }
      loadCount += 1;
      if (loadCount === 1) return response(200, { names: ["server A"] });
      if (loadCount === 2) return response(200, { names: ["server B"] });
      return response(503, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    const textarea = await screen.findByLabelText("参考対象の表示名（改行区切り）");
    await user.clear(textarea);
    await user.type(textarea, "unsaved draft");
    await user.click(screen.getByRole("button", { name: "氏名一覧を保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("管理者認証が必要です。");
    expect(textarea).toHaveValue("unsaved draft");
    await user.click(screen.getByRole("button", { name: "認証状態を再確認" }));
    expect(await screen.findByRole("button", { name: "氏名一覧を保存" })).toBeEnabled();
    expect(textarea).toHaveValue("unsaved draft");

    await user.click(screen.getByRole("button", { name: "氏名一覧を保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("管理者認証が必要です。");
    await user.click(screen.getByRole("button", { name: "認証状態を再確認" }));
    expect(
      await screen.findByText("設定を読み込めませんでした。時間をおいて再試行してください。"),
    ).toBeInTheDocument();
    expect(textarea).toHaveValue("unsaved draft");
    expect(textarea).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(putCount).toBe(2);
  });

  it("keeps a PUT 401 draft and never resubmits it automatically", async () => {
    const user = userEvent.setup();
    let putCount = 0;
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) {
        getCount += 1;
        return response(200, { names: getCount === 1 ? ["server"] : ["new server value"] });
      }
      putCount += 1;
      return response(401, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    const textarea = await screen.findByLabelText("参考対象の表示名（改行区切り）");
    await user.clear(textarea);
    await user.type(textarea, "draft after 401");
    await user.click(screen.getByRole("button", { name: "氏名一覧を保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("管理者認証が必要です。");
    expect(textarea).toHaveValue("draft after 401");
    expect(textarea).toBeDisabled();
    expect(putCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "認証状態を再確認" }));
    expect(await screen.findByRole("button", { name: "氏名一覧を保存" })).toBeEnabled();
    expect(textarea).toHaveValue("draft after 401");
    expect(putCount).toBe(1);
  });

  it("does not start duplicate rechecks while one is pending", async () => {
    const user = userEvent.setup();
    let resolveRecheck!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRecheck = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? response(401, {}) : pending;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    const recheck = await screen.findByRole("button", { name: "認証状態を再確認" });
    await user.click(recheck);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "認証状態を再確認" })).toBe(recheck);
    expect(recheck).toHaveAttribute("aria-disabled", "true");
    expect(recheck).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveRecheck(response(200, { names: ["server"] }));
    await screen.findByRole("button", { name: "氏名一覧を保存" });
    await waitFor(() =>
      expect(screen.getByLabelText("参考対象の表示名（改行区切り）")).toHaveFocus(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery button focus when rechecks stay unauthorized or fail", async () => {
    const user = userEvent.setup();
    let getCount = 0;
    const fetchMock = vi.fn(async () => {
      getCount += 1;
      if (getCount <= 2) return response(401, {});
      return response(503, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    const recheck = await screen.findByRole("button", { name: "認証状態を再確認" });
    await user.click(recheck);
    const stillUnauthorized = screen.getByRole("button", { name: "認証状態を再確認" });
    expect(stillUnauthorized).toBe(recheck);
    expect(stillUnauthorized).toHaveFocus();

    await user.click(stillUnauthorized);
    const retry = screen.getByRole("button", { name: "設定を再読み込み" });
    expect(retry).toBe(recheck);
    expect(retry).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale GET response after StrictMode replays the effect", async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const firstLoad = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondLoad = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    let loadCount = 0;
    const fetchMock = vi.fn(() => {
      loadCount += 1;
      return loadCount === 1 ? firstLoad : secondLoad;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <StrictMode>
        <ReferenceParticipantsSettings />
      </StrictMode>,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveSecond(response(200, { names: ["current server value"] }));
    const textarea = await screen.findByLabelText("参考対象の表示名（改行区切り）");
    expect(textarea).toHaveValue("current server value");

    resolveFirst(response(200, { names: ["stale server value"] }));
    await Promise.resolve();
    await Promise.resolve();
    expect(textarea).toHaveValue("current server value");
  });

  it("reports invalid save responses and non-Error save failures", async () => {
    const user = userEvent.setup();
    let putCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return response(200, { names: [] });
      putCount += 1;
      if (putCount === 1) return response(503, { error: "Save unavailable" });
      if (putCount === 2) return response(200, { names: [3] });
      throw "offline";
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);
    const button = await screen.findByRole("button", { name: "氏名一覧を保存" });

    await user.click(button);
    expect(await screen.findByText("Save unavailable")).toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByText("保存結果の形式を確認できませんでした。")).toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByText("設定を保存できませんでした。")).toBeInTheDocument();
  });

  it("shows a busy label while a save is pending and accepts confirmed return", async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method ? saveResponse : response(200, { names: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ReferenceParticipantsSettings />);

    const textarea = await screen.findByLabelText("参考対象の表示名（改行区切り）");
    await user.type(textarea, "B");
    await user.click(screen.getByRole("button", { name: "氏名一覧を保存" }));
    expect(await screen.findByRole("button", { name: "保存しています…" })).toBeDisabled();
    resolveSave(response(200, { names: ["B"] }));
    await screen.findByText(/保存しました/);

    fireEvent.change(textarea, { target: { value: "changed" } });
    const link = screen.getByRole("link", { name: "管理画面へ戻る" });
    expect(fireEvent.click(link)).toBe(true);
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });
});
