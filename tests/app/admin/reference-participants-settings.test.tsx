import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();

    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(200, { names: ["A", 2] })),
    );
    render(<ReferenceParticipantsSettings />);
    expect(await screen.findByText("設定の形式を確認できませんでした。")).toBeInTheDocument();
  });

  it("uses fallback messages when non-ok load and save responses omit an error", async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method ? saveResponse : response(503, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ReferenceParticipantsSettings />);

    expect(await screen.findByText("設定を読み込めませんでした。")).toBeInTheDocument();
    const textarea = screen.getByLabelText("参考対象の表示名（改行区切り）");
    await user.type(textarea, "A");
    await user.click(screen.getByRole("button", { name: "氏名一覧を保存" }));
    expect(await screen.findByRole("button", { name: "保存しています…" })).toBeDisabled();
    expect(screen.queryByText("設定を読み込めませんでした。")).not.toBeInTheDocument();

    resolveSave(response(503, {}));
    expect(await screen.findByText("設定を保存できませんでした。")).toBeInTheDocument();
  });

  it("uses the fallback message when loading rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    render(<ReferenceParticipantsSettings />);

    expect(await screen.findByText("設定を読み込めませんでした。")).toBeInTheDocument();
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
    await user.type(textarea, "A");
    await user.click(screen.getByRole("button", { name: "氏名一覧を保存" }));
    expect(await screen.findByText("保存結果の形式を確認できませんでした。")).toBeInTheDocument();
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
