import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationAdminPage from "@/app/admin/presentation/page";
import PresentationAdmin from "@/app/admin/presentation/presentation-admin";

const navigation = vi.hoisted(() => ({
  assign: vi.fn(),
  replace: vi.fn(),
}));

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function setLocationMocks() {
  const original = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: navigation,
  });
  return () => {
    if (original) Object.defineProperty(window, "location", original);
  };
}

describe("presentation admin entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the admin PIN form from the page entry", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(200, { authenticated: false })));

    render(<PresentationAdminPage />);

    expect(screen.getByRole("heading", { name: "披露宴 発表操作" })).toBeInTheDocument();
    expect(screen.getByLabelText("管理者 PIN")).toHaveAttribute("type", "password");
  });
});

describe("presentation admin login", () => {
  let restoreLocation: (() => void) | undefined;

  beforeEach(() => {
    navigation.assign.mockReset();
    navigation.replace.mockReset();
    restoreLocation = setLocationMocks();
  });

  afterEach(() => {
    restoreLocation?.();
    restoreLocation = undefined;
    vi.unstubAllGlobals();
  });

  it("replaces the page when the existing session is authenticated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PresentationAdmin />);

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/presentation?presenter=1"),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/session", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a visible prompt when the session check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<PresentationAdmin />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "管理者セッションを確認できませんでした。PIN を入力してください。",
    );
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("does not send a login request while the PIN is empty", () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { authenticated: false }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PresentationAdmin />);
    const pinInput = screen.getByLabelText("管理者 PIN");
    const form = pinInput.closest("form");
    if (!form) throw new Error("PIN form was not rendered");

    expect(screen.getByRole("button", { name: "発表画面を始める" })).toBeDisabled();
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not redirect after a successful session check settles on an unmounted page", async () => {
    let resolveJson!: (value: unknown) => void;
    const jsonResult = new Promise<unknown>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolve({
          ok: true,
          status: 200,
          json: vi.fn().mockReturnValue(jsonResult),
        } as unknown as Response);
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<PresentationAdmin />);
    view.unmount();

    await act(async () => {
      resolveJson({ authenticated: true });
      await jsonResult;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("does not show an error or navigate after a failed session check settles on an unmounted page", async () => {
    let rejectFetch!: (reason: Error) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<PresentationAdmin />);
    view.unmount();

    await act(async () => {
      rejectFetch(new Error("offline"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it("logs in with a PIN, clears the input, and navigates on success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { authenticated: false }))
      .mockResolvedValueOnce(response(200, { authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PresentationAdmin />);
    const pinInput = screen.getByLabelText("管理者 PIN");
    await user.type(pinInput, "2468");
    await user.click(screen.getByRole("button", { name: "発表画面を始める" }));

    await waitFor(() =>
      expect(navigation.assign).toHaveBeenCalledWith("/presentation?presenter=1"),
    );
    expect(pinInput).toHaveValue("");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/admin/session", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "2468" }),
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the form and shows the unavailable message for an unauthenticated success payload", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(200, { authenticated: false }))
        .mockResolvedValueOnce(response(200, { authenticated: false })),
    );

    render(<PresentationAdmin />);
    await user.type(screen.getByLabelText("管理者 PIN"), "1357");
    await user.click(screen.getByRole("button", { name: "発表画面を始める" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "管理者セッションを確認できませんでした。",
    );
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it("maps an invalid PIN response to the PIN guidance", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(200, { authenticated: false }))
        .mockResolvedValueOnce(response(401, { error: "Invalid PIN" })),
    );

    render(<PresentationAdmin />);
    await user.type(screen.getByLabelText("管理者 PIN"), "0000");
    await user.click(screen.getByRole("button", { name: "発表画面を始める" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PIN が一致しません。入力内容をご確認ください。",
    );
  });

  it("shows server errors and uses a fallback for a non-Error rejection", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { authenticated: false }))
      .mockResolvedValueOnce(response(503, { error: "管理機能は利用できません。" }))
      .mockRejectedValueOnce("network failure");
    vi.stubGlobal("fetch", fetchMock);

    render(<PresentationAdmin />);
    const pinInput = screen.getByLabelText("管理者 PIN");
    await user.type(pinInput, "1111");
    await user.click(screen.getByRole("button", { name: "発表画面を始める" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("管理機能は利用できません。");

    await user.clear(pinInput);
    await user.type(pinInput, "2222");
    await user.click(screen.getByRole("button", { name: "発表画面を始める" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("ログインできませんでした。"),
    );
  });

  it("handles invalid response JSON and ignores repeated submission while busy", async () => {
    const user = userEvent.setup();
    let resolvePost!: (value: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { authenticated: false }))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<PresentationAdmin />);
    const pinInput = screen.getByLabelText("管理者 PIN");
    await user.type(pinInput, "9876");
    const form = pinInput.closest("form");
    if (!form) throw new Error("PIN form was not rendered");
    fireEvent.submit(form);

    expect(await screen.findByRole("button", { name: "確認中…" })).toBeDisabled();
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvePost({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("invalid JSON")),
    } as unknown as Response);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "管理者セッションを確認できませんでした。",
    );
    expect(screen.getByRole("button", { name: "発表画面を始める" })).toBeDisabled();
  });

  it("falls back when a failed response has no readable error payload", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(200, { authenticated: false }))
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: vi.fn().mockRejectedValue(new SyntaxError("invalid JSON")),
        } as unknown as Response),
    );

    render(<PresentationAdmin />);
    await user.type(screen.getByLabelText("管理者 PIN"), "4321");
    await user.click(screen.getByRole("button", { name: "発表画面を始める" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ログインできませんでした。");
  });
});
