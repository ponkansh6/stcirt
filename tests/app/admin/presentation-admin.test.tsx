import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PresentationAdminPage from "@/app/admin/presentation/page";
import PresentationAdmin from "@/app/admin/presentation/presentation-admin";

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status });
}

function apiFetch(options: {
  session?: unknown;
  state?: Record<string, unknown>;
  mutationStatus?: number;
  publishStatus?: number;
}) {
  const actions: { path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/admin/session")
      return response(200, options.session ?? { authenticated: true });
    if (path === "/api/admin/presentation" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      actions.push({ path, body });
      return response(options.mutationStatus ?? 200, {});
    }
    if (path === "/api/admin/participant-results") {
      const body = JSON.parse(String(init?.body));
      actions.push({ path, body });
      return response(options.publishStatus ?? 200, {});
    }
    if (path === "/api/admin/presentation")
      return response(
        200,
        options.state ?? {
          state: "not_started",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        },
      );
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { actions, fetchMock };
}

describe("presentation admin console", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the PIN entry through the admin page", () => {
    apiFetch({ session: { authenticated: false } });
    render(<PresentationAdminPage />);
    expect(screen.getByRole("heading", { name: "披露宴 発表操作" })).toBeInTheDocument();
    expect(screen.getByLabelText("管理者 PIN")).toHaveAttribute("type", "password");
  });

  it("keeps the authenticated user on the admin page, shows status, and starts there", async () => {
    const user = userEvent.setup();
    let authenticated = false;
    let state = "not_started";
    const actions: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/admin/session" && init?.method === "POST") {
          authenticated = true;
          return response(200, { authenticated });
        }
        if (path === "/api/admin/session") return response(200, { authenticated });
        if (path === "/api/admin/presentation" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          actions.push({ path, body });
          state = "question";
          return response(200, {});
        }
        if (path === "/api/admin/presentation")
          return response(200, {
            state,
            questionIndex: 0,
            questionCount: 5,
            projectionHidden: false,
            participantResultsVisible: false,
            participantResultsReady: true,
          });
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    render(<PresentationAdmin />);
    await user.type(screen.getByLabelText("管理者 PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));
    expect(await screen.findByText("現在の状態：未開始")).toBeInTheDocument();
    expect(screen.queryByLabelText("管理者 PIN")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "発表を開始" }));
    await waitFor(() =>
      expect(actions).toContainEqual({
        path: "/api/admin/presentation",
        body: expect.objectContaining({ action: "start" }),
      }),
    );
  });

  it("shows running and finished state with named projection tab and publish controls", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    apiFetch({
      state: {
        state: "question",
        questionIndex: 1,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    const view = render(<PresentationAdmin />);
    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    expect(screen.getByText("問題 2 / 5")).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "投影画面を開く / 投影タブへ戻る" }));
    expect(open).toHaveBeenCalledWith("/presentation?presenter=1", "stcirt-presentation");

    view.unmount();
    apiFetch({
      state: {
        state: "finished",
        questionIndex: 5,
        questionCount: 5,
        projectionHidden: true,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    render(<PresentationAdmin />);
    expect(await screen.findByText("現在の状態：終了")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "参加者結果を公開" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "投影を表示" })).toBeInTheDocument();
  });

  it("publishes only visible true and avoids another publish when already visible", async () => {
    const api = apiFetch({
      state: {
        state: "finished",
        questionIndex: 5,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    const user = userEvent.setup();
    const view = render(<PresentationAdmin />);
    await user.click(await screen.findByRole("button", { name: "参加者結果を公開" }));
    await waitFor(() =>
      expect(api.actions).toContainEqual({
        path: "/api/admin/participant-results",
        body: { visible: true },
      }),
    );

    view.unmount();
    const published = apiFetch({
      state: {
        state: "finished",
        questionIndex: 5,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: true,
        participantResultsReady: true,
      },
    });
    render(<PresentationAdmin />);
    expect(await screen.findByText("参加者結果は公開済みです")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "参加者結果を公開" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "参加者結果を非公開" }));
    await waitFor(() =>
      expect(published.actions).toContainEqual({
        path: "/api/admin/participant-results",
        body: { visible: false },
      }),
    );
  });

  it("keeps failed publication retryable and clears controls after a 401", async () => {
    const api = apiFetch({
      state: {
        state: "finished",
        questionIndex: 5,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
      publishStatus: 503,
    });
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    const publish = await screen.findByRole("button", { name: "参加者結果を公開" });
    await user.click(publish);
    expect(await screen.findByRole("alert")).toHaveTextContent("再試行してください");
    expect(screen.getByRole("button", { name: "参加者結果を公開" })).toBeInTheDocument();
    expect(api.actions).toHaveLength(1);

    api.fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/admin/participant-results") return response(401, {});
      if (String(input) === "/api/admin/session") return response(200, { authenticated: false });
      return response(200, {
        state: "finished",
        questionIndex: 5,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      });
    });
    await user.click(screen.getByRole("button", { name: "参加者結果を公開" }));
    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
  });

  it("keeps the expired-session message when a failed action refresh finds no session", async () => {
    let publishAttempted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/session")
          return response(200, { authenticated: !publishAttempted });
        if (path === "/api/admin/participant-results") {
          publishAttempted = true;
          return response(503, {});
        }
        if (path === "/api/admin/presentation")
          return response(200, {
            state: "finished",
            questionIndex: 5,
            questionCount: 5,
            projectionHidden: false,
            participantResultsVisible: false,
            participantResultsReady: true,
          });
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "参加者結果を公開" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("セッションの有効期限が切れました");
    expect(alert).not.toHaveTextContent("再試行してください");
    expect(screen.getByLabelText("管理者 PIN")).toBeInTheDocument();
  });

  it.each([
    ["not_started", "未開始", false],
    ["question", "進行中：問題", true],
    ["answer", "進行中：解答", true],
    ["podium_preview", "進行中：結果発表前", false],
    ["third", "進行中：第3位", false],
    ["second", "進行中：第2位", false],
    ["first", "進行中：第1位", false],
    ["finished", "終了", false],
    ["unknown", "状態を確認中", false],
  ])("renders refreshed status for %s", async (state, label, hasQuestionDetail) => {
    apiFetch({
      state: {
        state,
        questionIndex: 1,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    render(<PresentationAdmin />);

    expect(await screen.findByText(`現在の状態：${label}`)).toBeInTheDocument();
    if (hasQuestionDetail) expect(screen.getByText("問題 2 / 5")).toBeInTheDocument();
    else expect(screen.queryByText("問題 2 / 5")).not.toBeInTheDocument();
  });

  it("defaults incomplete admin state fields and disables publishing until results are ready", async () => {
    apiFetch({ state: { state: "finished", participantResultsReady: false } });
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：終了")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "参加者結果を公開" })).toBeDisabled();
  });

  it("defaults a non-string server state to not started", async () => {
    apiFetch({ state: { state: null } });
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：未開始")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "発表を開始" })).toBeInTheDocument();
  });

  it("does not post an empty PIN and maps an invalid PIN response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/session" && init?.method === "POST")
        return response(401, { error: "Invalid PIN" });
      if (String(input) === "/api/admin/session") return response(200, { authenticated: false });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);
    const form = screen.getByLabelText("管理者 PIN").closest("form");
    if (!form) throw new Error("PIN form was not rendered");
    fireEvent.submit(form);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input) === "/api/admin/session" && init?.method === "POST",
      ),
    ).toBe(false);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("管理者 PIN"), "0000");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PIN が一致しません");
  });

  it("ignores a repeated form submit while the login request is pending", async () => {
    let finishLogin: ((value: Response) => void) | undefined;
    let loginPosts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/session" && init?.method === "POST") {
        loginPosts += 1;
        if (loginPosts === 1) {
          return new Promise<Response>((resolve) => {
            finishLogin = resolve;
          });
        }
        return Promise.resolve(response(200, { authenticated: true }));
      }
      if (String(input) === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: loginPosts > 1 }));
      if (String(input) === "/api/admin/presentation")
        return Promise.resolve(
          response(200, {
            state: "not_started",
            questionIndex: 0,
            questionCount: 5,
            projectionHidden: false,
            participantResultsVisible: false,
            participantResultsReady: true,
          }),
        );
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    const pinInput = screen.getByLabelText("管理者 PIN");
    await user.type(pinInput, "2468");
    const form = pinInput.closest("form");
    if (!form) throw new Error("PIN form was not rendered");

    fireEvent.submit(form);
    const pendingButton = await screen.findByRole("button", { name: "確認中…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.submit(form);
    expect(loginPosts).toBe(1);

    await act(async () => {
      finishLogin?.(response(200, { authenticated: false }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("セッションを確認できませんでした");
    expect(loginPosts).toBe(1);

    await user.type(screen.getByLabelText("管理者 PIN"), "2468");
    const retryButton = screen.getByRole("button", { name: "管理ページにログイン" });
    expect(retryButton).toBeEnabled();
    fireEvent.submit(form);
    expect(loginPosts).toBe(2);
    expect(await screen.findByText("現在の状態：未開始")).toBeInTheDocument();
  });

  it("shows the login error when the server accepts a request without authenticating", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/session" && init?.method === "POST")
        return response(200, { authenticated: false });
      if (String(input) === "/api/admin/session") return response(200, { authenticated: false });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    await user.type(screen.getByLabelText("管理者 PIN"), "0000");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("セッションを確認できませんでした");
  });

  it("returns to PIN entry when admin state retrieval returns 401", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/session") return response(200, { authenticated: true });
      if (String(input) === "/api/admin/presentation") return response(401, {});
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("セッションの有効期限が切れました");
  });

  it("uses the login fallback for non-JSON session errors", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/session" && init?.method === "POST")
        return new Response("not json", { status: 503 });
      if (String(input) === "/api/admin/session") return response(200, { authenticated: false });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    await user.type(screen.getByLabelText("管理者 PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ログインできませんでした");
  });

  it("uses the generic login message when the request rejects without an Error object", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/session" && init?.method === "POST")
        return Promise.reject("network unavailable");
      if (String(input) === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: false }));
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    await user.type(screen.getByLabelText("管理者 PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ログインできませんでした");
  });

  it("returns to PIN entry when an action refresh receives session 401", async () => {
    let actionPosted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return actionPosted
          ? response(401, { error: "Expired" })
          : response(200, { authenticated: true });
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        actionPosted = true;
        return response(200, {});
      }
      if (path === "/api/admin/presentation")
        return response(200, {
          state: "question",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "投影を一時非表示" }));
    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("セッションの有効期限が切れました");
  });

  it("prevents a second publication while the first request is pending", async () => {
    let finishPublication: (() => void) | undefined;
    let publicationCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation")
        return Promise.resolve(
          response(200, {
            state: "finished",
            questionIndex: 5,
            questionCount: 5,
            projectionHidden: false,
            participantResultsVisible: false,
            participantResultsReady: true,
          }),
        );
      if (path === "/api/admin/participant-results" && init?.method === "POST") {
        publicationCount += 1;
        return new Promise<Response>((resolve) => {
          finishPublication = () => resolve(response(200, {}));
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "参加者結果を公開" }));
    const pendingButton = await screen.findByRole("button", { name: "公開しています…" });
    expect(pendingButton).toBeDisabled();
    expect(publicationCount).toBe(1);

    finishPublication?.();
    await waitFor(() => expect(publicationCount).toBe(1));
    expect(await screen.findByRole("button", { name: "参加者結果を公開" })).toBeInTheDocument();
  });

  it("keeps the newest state when an older refresh finishes later", async () => {
    let finishFirstState: ((value: Response) => void) | undefined;
    let presentationReads = 0;
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      if (typeof handler === "function") poll = handler as () => void;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation") {
        presentationReads += 1;
        if (presentationReads === 1) {
          return new Promise<Response>((resolve) => {
            finishFirstState = resolve;
          });
        }
        return Promise.resolve(
          response(200, {
            state: "answer",
            questionIndex: 0,
            questionCount: 5,
            projectionHidden: false,
            participantResultsVisible: false,
            participantResultsReady: true,
          }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    await waitFor(() => expect(presentationReads).toBe(1));
    expect(poll).toBeDefined();
    await act(async () => {
      poll?.();
      await waitFor(() => expect(presentationReads).toBe(2));
    });
    expect(await screen.findByText("現在の状態：進行中：解答")).toBeInTheDocument();

    await act(async () => {
      finishFirstState?.(
        response(200, {
          state: "question",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("現在の状態：進行中：解答")).toBeInTheDocument();
  });

  it.each(["late success", "late 401"])(
    "ignores a %s from an outdated session refresh",
    async (outcome) => {
      let resolveFirstSession: ((value: Response) => void) | undefined;
      let rejectFirstSession: ((reason: unknown) => void) | undefined;
      let sessionReads = 0;
      let stateReads = 0;
      let poll: (() => void) | undefined;
      vi.spyOn(window, "setInterval").mockImplementation((handler) => {
        if (typeof handler === "function") poll = handler as () => void;
        return 1 as unknown as ReturnType<typeof window.setInterval>;
      });
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/session") {
          sessionReads += 1;
          if (sessionReads === 3) {
            return new Promise<Response>((resolve, reject) => {
              resolveFirstSession = resolve;
              rejectFirstSession = reject;
            });
          }
          return Promise.resolve(response(200, { authenticated: true }));
        }
        if (path === "/api/admin/presentation") {
          stateReads += 1;
          return Promise.resolve(
            response(200, {
              state: "answer",
              questionIndex: 0,
              questionCount: 5,
              projectionHidden: false,
              participantResultsVisible: false,
              participantResultsReady: true,
            }),
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<PresentationAdmin />);

      expect(await screen.findByText("現在の状態：進行中：解答")).toBeInTheDocument();
      expect(poll).toBeDefined();
      const pollRefresh = poll;
      await act(async () => {
        pollRefresh?.();
        pollRefresh?.();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      await waitFor(() => expect(sessionReads).toBeGreaterThanOrEqual(4));
      expect(await screen.findByText("現在の状態：進行中：解答")).toBeInTheDocument();
      const currentStateReads = stateReads;
      expect(currentStateReads).toBeGreaterThanOrEqual(1);

      await act(async () => {
        if (outcome === "late success")
          resolveFirstSession?.(response(200, { authenticated: true }));
        else rejectFirstSession?.(Object.assign(new Error("Expired"), { status: 401 }));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });
      expect(screen.getByText("現在の状態：進行中：解答")).toBeInTheDocument();
      expect(screen.queryByLabelText("管理者 PIN")).not.toBeInTheDocument();
      if (outcome === "late success") expect(stateReads).toBe(currentStateReads);
    },
  );

  it("shows a retry message and keeps the last state when a refresh fails", async () => {
    let presentationReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/presentation" && init?.method === "POST") return response(200, {});
      if (path === "/api/admin/presentation") {
        presentationReads += 1;
        if (presentationReads > 1) return response(503, {});
        return response(200, {
          state: "question",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "投影を一時非表示" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
  });

  it("offers the show action when projection is hidden", async () => {
    const api = apiFetch({
      state: {
        state: "answer",
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: true,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "投影を表示" }));
    await waitFor(() =>
      expect(api.actions).toContainEqual({
        path: "/api/admin/presentation",
        body: expect.objectContaining({ action: "show" }),
      }),
    );
  });

  it("shows refresh errors in the authenticated loading console", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/session") return response(200, { authenticated: true });
      if (String(input) === "/api/admin/presentation") return response(503, {});
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("管理状態を取得しています…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
  });

  it("shows an action failure when the projection action endpoint rejects the request", async () => {
    let actionAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        actionAttempts += 1;
        return response(503, {});
      }
      if (path === "/api/admin/presentation")
        return response(200, {
          state: "question",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "投影を一時非表示" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "操作を反映できませんでした。状態を再確認してから再試行してください。",
    );
    expect(actionAttempts).toBe(1);
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
  });

  it("shows the loading console while the authenticated admin state is pending", async () => {
    let finishState: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation")
        return new Promise<Response>((resolve) => {
          finishState = resolve;
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("管理状態を取得しています…")).toBeInTheDocument();
    await act(async () => {
      finishState?.(
        response(200, {
          state: "not_started",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: false,
        }),
      );
    });
    expect(await screen.findByText("現在の状態：未開始")).toBeInTheDocument();
  });
});
