import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PresentationAdminPage from "@/app/admin/presentation/page";
import PresentationAdmin from "@/app/admin/presentation/presentation-admin";

function response(status: number, payload: unknown): Response {
  const withRevision =
    payload && typeof payload === "object" && "state" in payload && !("snapshotRevision" in payload)
      ? { ...payload, snapshotRevision: 1 }
      : payload;
  return new Response(JSON.stringify(withRevision), { status });
}

function apiFetch(options: {
  session?: unknown;
  state?: Record<string, unknown>;
  stateStatus?: number;
  mutationStatus?: number;
  mutationPayload?: unknown;
  mutationRawBody?: string;
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
      return options.mutationRawBody === undefined
        ? response(options.mutationStatus ?? 200, options.mutationPayload ?? {})
        : new Response(options.mutationRawBody, { status: options.mutationStatus ?? 200 });
    }
    if (path === "/api/admin/participant-results") {
      const body = JSON.parse(String(init?.body));
      actions.push({ path, body });
      return response(options.publishStatus ?? 200, {});
    }
    if (path === "/api/admin/presentation")
      return response(options.stateStatus ?? 200, {
        state: "not_started",
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
        snapshotRevision: 1,
        ...options.state,
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { actions, fetchMock };
}

describe("presentation admin console", () => {
  beforeAll(() => {
    if (typeof HTMLDialogElement.prototype.showModal !== "function") {
      HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
    }
    if (typeof HTMLDialogElement.prototype.close !== "function") {
      HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
      };
    }
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the PIN entry through the admin page", async () => {
    apiFetch({ stateStatus: 401 });
    render(<PresentationAdminPage />);
    expect(screen.getByRole("heading", { name: "披露宴 発表操作" })).toBeInTheDocument();
    expect(screen.getByText("HOST CONSOLE")).toBeInTheDocument();
    expect(screen.queryByText("STCIRT")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("管理者 PIN")).toHaveAttribute("type", "password");
  });

  it("keeps the authenticated user on the admin page, shows status, and starts there", async () => {
    const user = userEvent.setup();
    let authenticated = false;
    let state = "not_started";
    const actions: { path: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (path === "/api/admin/presentation" && !authenticated) return response(401, {});
      if (path === "/api/admin/presentation")
        return response(200, {
          state,
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);
    await user.type(await screen.findByLabelText("管理者 PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));
    expect(await screen.findByText("現在の状態：未開始")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([path, init]) => String(path) === "/api/admin/session" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([path]) => String(path) === "/api/admin/presentation"),
    ).toHaveLength(2);
    expect(screen.queryByLabelText("管理者 PIN")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "発表を開始" }));
    await waitFor(() =>
      expect(actions).toContainEqual({
        path: "/api/admin/presentation",
        body: expect.objectContaining({ action: "start" }),
      }),
    );
  });

  it("confirms auth through state on entry and visibility return, while ordinary polls read state only", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const api = apiFetch({});
    render(<PresentationAdmin />);
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const count = (path: string) =>
      api.fetchMock.mock.calls.filter(([input]) => String(input) === path).length;
    expect(count("/api/admin/session")).toBe(0);
    expect(count("/api/admin/presentation")).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(count("/api/admin/session")).toBe(0);
    expect(count("/api/admin/presentation")).toBe(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(count("/api/admin/presentation")).toBe(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(count("/api/admin/session")).toBe(0);
    expect(count("/api/admin/presentation")).toBe(3);

    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(count("/api/admin/session")).toBe(0);
    expect(count("/api/admin/presentation")).toBe(4);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("recovers from an early hidden visibility change while the initial state check is pending", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let finishInitialState: ((value: Response) => void) | undefined;
    let stateReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 1)
          return new Promise<Response>((resolve) => {
            finishInitialState = resolve;
          });
        return Promise.resolve(
          response(200, {
            state: stateReads === 1 ? "question" : "answer",
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

    await waitFor(() => expect(stateReads).toBe(1));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(stateReads).toBe(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(stateReads).toBe(1);

    await act(async () => {
      finishInitialState?.(
        response(200, {
          state: "question",
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
    });
    await waitFor(() => {
      expect(stateReads).toBe(2);
    });
    expect(screen.getByText("現在の状態：進行中：解答")).toBeInTheDocument();
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("stops unauthenticated polling until a visible state check", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let authenticated = false;
    let stateReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "/api/admin/presentation") {
        stateReads += 1;
        if (!authenticated) return response(401, {});
        return response(200, {
          state: "not_started",
          snapshotRevision: 0,
          questionIndex: 0,
          questionCount: 0,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === "/api/admin/session" && init?.method === "GET",
      ),
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/presentation"),
    ).toHaveLength(1);

    authenticated = true;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === "/api/admin/session" && init?.method === "GET",
      ),
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/presentation"),
    ).toHaveLength(2);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("starts polling after login and reflects state changes made outside the admin console", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let poll: (() => void) | undefined;
    let loginSubmitted = false;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (loginSubmitted && delay === 2500 && typeof handler === "function")
        poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    let authenticated = false;
    let state = "opening";
    let stateReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session" && init?.method === "POST") {
        loginSubmitted = true;
        authenticated = true;
        return response(200, { authenticated: true });
      }
      if (path === "/api/admin/session") return response(200, { authenticated });
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (!authenticated) return response(401, {});
        return response(200, {
          state,
          snapshotRevision: 1,
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await screen.findByLabelText("管理者 PIN");
    expect(poll).toBeUndefined();
    await user.type(await screen.findByLabelText("管理者 PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));
    expect(await screen.findByText("現在の状態：進行中：オープニング")).toBeInTheDocument();
    expect(stateReads).toBe(2);

    state = "question";
    await waitFor(() => expect(poll).toBeDefined());
    await act(async () => poll?.());

    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
    expect(stateReads).toBe(3);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("skips a queued poll while hidden or after the visible state check expires", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let authenticated = true;
    let poll: (() => void) | undefined;
    let stateReads = 0;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2 && !authenticated) return Promise.resolve(response(401, {}));
        return Promise.resolve(
          response(200, {
            state: "question",
            snapshotRevision: 1,
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

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeDefined());
    const queuedPoll = poll;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      queuedPoll?.();
    });
    expect(stateReads).toBe(1);

    authenticated = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      // Invoke the already queued callback before React commits the unauthenticated render.
      queuedPoll?.();
    });
    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(stateReads).toBe(2);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("shows the expired-session message when a visible state check returns 401", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let stateReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2) return response(401, {});
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
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "管理者セッションの有効期限が切れました",
    );
    expect(screen.getByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(stateReads).toBe(2);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("falls back to session status after visible state revalidation fails", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let sessionReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") {
        sessionReads += 1;
        return response(200, { authenticated: true });
      }
      if (path === "/api/admin/presentation") {
        if (fetchMock.mock.calls.filter(([input]) => String(input) === path).length === 2)
          return response(503, {});
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
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(sessionReads).toBe(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/presentation"),
    ).toHaveLength(2);
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("uses authenticated session fallback after a startup state failure", async () => {
    const requestPaths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      requestPaths.push(path);
      if (path === "/api/admin/presentation") return response(503, {});
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("管理状態を取得しています…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.queryByLabelText("管理者 PIN")).not.toBeInTheDocument();
    expect(requestPaths).toEqual(["/api/admin/presentation", "/api/admin/session"]);
  });

  it("shows PIN when a non-401 startup state failure falls back to unauthenticated status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/presentation") return response(503, {});
      if (path === "/api/admin/session") return response(200, { authenticated: false });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/presentation"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/session"),
    ).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains confirmed auth when state and session fallback checks both fail", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let stateReads = 0;
    let sessionReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") {
        sessionReads += 1;
        throw new TypeError("Failed to fetch");
      }
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2) return response(503, {});
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
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.queryByLabelText("管理者 PIN")).not.toBeInTheDocument();
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
    expect(stateReads).toBe(2);
    expect(sessionReads).toBe(1);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("discards a session fallback made stale by unmount", async () => {
    let finishSession: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/presentation") return Promise.resolve(response(503, {}));
      if (path === "/api/admin/session")
        return new Promise<Response>((resolve) => {
          finishSession = resolve;
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<PresentationAdmin />);

    await waitFor(() => expect(finishSession).toBeDefined());
    view.unmount();
    await act(async () => {
      finishSession?.(response(200, { authenticated: false }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows the expired-session message when fallback auth is lost after a visible state failure", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let stateReads = 0;
    let sessionReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2) return response(503, {});
        return response(200, {
          state: "question",
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      }
      if (path === "/api/admin/session") {
        sessionReads += 1;
        return response(200, { authenticated: false });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "管理者セッションの有効期限が切れました",
    );
    expect(screen.getByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(stateReads).toBe(2);
    expect(sessionReads).toBe(1);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("discards a state response made stale by session expiry", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    let finishAction: ((value: Response) => void) | undefined;
    let finishStaleState: ((value: Response) => void) | undefined;
    let stateReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation" && init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finishAction = resolve;
        });
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2)
          return new Promise<Response>((resolve) => {
            finishStaleState = resolve;
          });
        return Promise.resolve(
          response(200, {
            state: "question",
            snapshotRevision: 1,
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
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));
    await waitFor(() => expect(finishAction).toBeDefined());
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(stateReads).toBe(2));

    await act(async () => {
      finishAction?.(response(401, {}));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "管理者セッションの有効期限が切れました",
    );
    expect(screen.getByLabelText("管理者 PIN")).toBeInTheDocument();

    await act(async () => {
      finishStaleState?.(
        response(200, {
          state: "answer",
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent("管理者セッションの有効期限が切れました");
    expect(screen.getByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(screen.queryByText("現在の状態：進行中：解答")).not.toBeInTheDocument();
    expect(stateReads).toBe(2);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("does not retry a queued poll after a state check expires the session", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let poll: (() => void) | undefined;
    let stateReads = 0;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2) return response(401, {});
        return response(200, {
          state: "question",
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeDefined());
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(stateReads).toBe(2);

    await act(async () => poll?.());

    expect(stateReads).toBe(2);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("executes reset immediately", async () => {
    const api = apiFetch({
      state: {
        state: "question",
        snapshotRevision: 1,
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    await screen.findByText("現在の状態：進行中：問題");
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));

    await waitFor(() =>
      expect(api.actions).toContainEqual({
        path: "/api/admin/presentation",
        body: expect.objectContaining({ action: "reset" }),
      }),
    );
    expect(api.actions.filter((a) => (a.body as any).action === "reset")).toHaveLength(1);
  });
  it("requires aggregation before starting or publishing and resets without rebuilding", async () => {
    const api = apiFetch({
      state: {
        state: "not_started",
        snapshotRevision: 0,
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: false,
      },
    });
    const user = userEvent.setup();
    const view = render(<PresentationAdmin />);
    expect(
      await screen.findByText("まだ集計されていません。開始・結果公開の前に集計してください。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "発表を開始" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "参加者結果を公開" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "集計" }));
    await waitFor(() =>
      expect(api.actions).toContainEqual({
        path: "/api/admin/presentation",
        body: expect.objectContaining({ action: "aggregate" }),
      }),
    );

    view.unmount();
    apiFetch({
      state: {
        state: "question",
        snapshotRevision: 0,
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: false,
      },
    });
    render(<PresentationAdmin />);
    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "参加者結果を公開" })).toBeDisabled();

    cleanup();
    const startedApi = apiFetch({
      state: {
        state: "question",
        snapshotRevision: 2,
        questionIndex: 2,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    render(<PresentationAdmin />);
    await user.click(await screen.findByRole("button", { name: "最初に戻る" }));
    await waitFor(() =>
      expect(startedApi.actions).toContainEqual({
        path: "/api/admin/presentation",
        body: expect.objectContaining({ action: "reset" }),
      }),
    );
  });

  it("renders a valid aggregate summary when the snapshot is updated", async () => {
    const user = userEvent.setup();
    apiFetch({
      mutationPayload: {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: 3,
          excludedSubmissionCount: 2,
          excludedReasonCounts: { questionVersionMismatch: 1, q5AssessmentVersionMismatch: 1 },
        },
      },
    });
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "集計" }));

    const outcome = await screen.findByText("集計スナップショットを更新しました。");
    const summary = outcome.parentElement!;
    expect(summary).toHaveAttribute("role", "status");
    expect(summary).toHaveTextContent("集計スナップショットを更新しました。");
    expect(summary).toHaveTextContent("集計対象 3 件 · 除外 2 件");
    expect(summary).toHaveTextContent("質問バージョン不一致 1 件、 Q5 評価バージョン不一致 1 件");
    expect(summary.className).not.toContain("aggregateNotUpdated");
  });

  it("renders an unchanged zero-eligible aggregate summary", async () => {
    const user = userEvent.setup();
    apiFetch({
      mutationPayload: {
        aggregationSummary: {
          snapshotUpdated: false,
          includedSubmissionCount: 0,
          excludedSubmissionCount: 4,
          excludedReasonCounts: { questionVersionMismatch: 4, q5AssessmentVersionMismatch: 0 },
        },
      },
    });
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "集計" }));

    const outcome = await screen.findByText(
      "集計対象となる回答が見つからなかったため、スナップショットは更新していません。既存のスナップショットを保持しています。",
    );
    const summary = outcome.parentElement!;
    expect(summary).toHaveAttribute("role", "status");
    expect(summary).toHaveTextContent("集計対象となる回答が見つからなかったため");
    expect(summary).toHaveTextContent("集計対象 0 件 · 除外 4 件");
    expect(summary.className).toContain("aggregateNotUpdated");
  });

  it.each([
    ["missing summary", {}],
    [
      "non-boolean updated flag",
      {
        aggregationSummary: {
          snapshotUpdated: "true",
          includedSubmissionCount: 1,
          excludedSubmissionCount: 0,
          excludedReasonCounts: { questionVersionMismatch: 0, q5AssessmentVersionMismatch: 0 },
        },
      },
    ],
    [
      "missing reason counts",
      {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: 1,
          excludedSubmissionCount: 0,
        },
      },
    ],
    [
      "negative count",
      {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: -1,
          excludedSubmissionCount: 0,
          excludedReasonCounts: { questionVersionMismatch: 0, q5AssessmentVersionMismatch: 0 },
        },
      },
    ],
    [
      "fractional count",
      {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: 1.5,
          excludedSubmissionCount: 0,
          excludedReasonCounts: { questionVersionMismatch: 0, q5AssessmentVersionMismatch: 0 },
        },
      },
    ],
    [
      "non-number count",
      {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: "1",
          excludedSubmissionCount: 0,
          excludedReasonCounts: { questionVersionMismatch: 0, q5AssessmentVersionMismatch: 0 },
        },
      },
    ],
    [
      "invalid excluded count",
      {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: 1,
          excludedSubmissionCount: "0",
          excludedReasonCounts: { questionVersionMismatch: 0, q5AssessmentVersionMismatch: 0 },
        },
      },
    ],
    [
      "invalid question-version reason count",
      {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: 1,
          excludedSubmissionCount: 0,
          excludedReasonCounts: { questionVersionMismatch: 0.5, q5AssessmentVersionMismatch: 0 },
        },
      },
    ],
    [
      "invalid Q5 reason count",
      {
        aggregationSummary: {
          snapshotUpdated: true,
          includedSubmissionCount: 1,
          excludedSubmissionCount: 0,
          excludedReasonCounts: { questionVersionMismatch: 0, q5AssessmentVersionMismatch: -1 },
        },
      },
    ],
  ])("treats %s aggregate summaries as unavailable", async (_label, mutationPayload) => {
    const user = userEvent.setup();
    apiFetch({ mutationPayload });
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "集計" }));

    expect(
      await screen.findByText(
        "件数内訳を取得できませんでした。操作状態を再読み込みして確認してください。",
      ),
    ).toBeInTheDocument();
  });

  it("treats an aggregate response that is not valid JSON as unavailable", async () => {
    const user = userEvent.setup();
    apiFetch({ mutationRawBody: "not JSON" });
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "集計" }));

    expect(
      await screen.findByText(
        "件数内訳を取得できませんでした。操作状態を再読み込みして確認してください。",
      ),
    ).toBeInTheDocument();
  });

  it("shows running and finished state with named projection tab and publish controls", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    apiFetch({
      state: {
        state: "question",
        snapshotRevision: 1,
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
    expect(screen.queryByRole("button", { name: "投影を一時非表示" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "投影を表示" })).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "投影画面を開く / 投影タブへ戻る" }));
    expect(open).toHaveBeenCalledWith("/presentation?presenter=1", "stcirt-presentation");

    view.unmount();
    apiFetch({
      state: {
        state: "finished",
        snapshotRevision: 1,
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
    expect(screen.queryByRole("button", { name: "投影を一時非表示" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "投影を表示" })).not.toBeInTheDocument();
  });

  it("keeps the retry state for malformed admin controls values", async () => {
    apiFetch({
      state: {
        state: "question",
        snapshotRevision: "3",
        questionIndex: "5",
        questionCount: "5",
        projectionHidden: "true",
        participantResultsVisible: 1,
        participantResultsReady: "true",
      },
    });

    render(<PresentationAdmin />);

    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.queryByText("現在の状態：進行中：問題")).not.toBeInTheDocument();
  });

  it.each(["snapshotRevision", "questionIndex", "questionCount"] as const)(
    "rejects a partial state DTO with no %s before a later valid retry",
    async (field) => {
      let stateReads = 0;
      let poll: (() => void) | undefined;
      const nativeSetTimeout = window.setTimeout.bind(window);
      vi.spyOn(window, "setTimeout").mockImplementation(((
        handler: TimerHandler,
        delay?: number,
      ) => {
        if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
        if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
        return nativeSetTimeout(handler, delay);
      }) as typeof window.setTimeout);
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        if (String(input) === "/api/admin/session")
          return Promise.resolve(response(200, { authenticated: true }));
        if (String(input) === "/api/admin/presentation") {
          stateReads += 1;
          const payload =
            stateReads === 1
              ? {
                  state: "question",
                  ...(field === "snapshotRevision" ? {} : { snapshotRevision: 1 }),
                  ...(field === "questionIndex" ? {} : { questionIndex: 0 }),
                  ...(field === "questionCount" ? {} : { questionCount: 5 }),
                  projectionHidden: false,
                  participantResultsVisible: false,
                  participantResultsReady: true,
                }
              : {
                  state: "question",
                  snapshotRevision: 1,
                  questionIndex: 0,
                  questionCount: 5,
                  projectionHidden: false,
                  participantResultsVisible: false,
                  participantResultsReady: true,
                };
          return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<PresentationAdmin />);

      expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
      expect(screen.queryByText("現在の状態：進行中：問題")).not.toBeInTheDocument();
      expect(stateReads).toBe(1);
      await waitFor(() => expect(poll).toBeDefined());
      await act(async () => poll?.());
      expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
      expect(stateReads).toBe(2);
    },
  );

  it("publishes only visible true and avoids another publish when already visible", async () => {
    const api = apiFetch({
      state: {
        state: "finished",
        snapshotRevision: 1,
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
        snapshotRevision: 1,
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

  it("hands focus between publish and hide after visibility state refresh, without initial autofocus", async () => {
    let participantResultsVisible = false;
    const actions: { path: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/participant-results") {
        const body = JSON.parse(String(init?.body)) as { visible: boolean };
        participantResultsVisible = body.visible;
        actions.push({ path, body });
        return response(200, { visible: participantResultsVisible });
      }
      if (path === "/api/admin/presentation")
        return response(200, {
          state: "finished",
          snapshotRevision: 1,
          questionIndex: 5,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible,
          participantResultsReady: true,
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    const publishButton = await screen.findByRole("button", { name: "参加者結果を公開" });
    expect(document.activeElement).not.toBe(publishButton);

    await user.click(publishButton);
    const hideButton = await screen.findByRole("button", { name: "参加者結果を非公開" });
    await waitFor(() => expect(document.activeElement).toBe(hideButton));

    await user.click(hideButton);
    const nextPublishButton = await screen.findByRole("button", { name: "参加者結果を公開" });
    await waitFor(() => expect(document.activeElement).toBe(nextPublishButton));
    expect(actions).toEqual([
      { path: "/api/admin/participant-results", body: { visible: true } },
      { path: "/api/admin/participant-results", body: { visible: false } },
    ]);
  });

  it("returns focus to the same hide action after a retryable hide failure", async () => {
    apiFetch({
      state: {
        state: "finished",
        questionIndex: 5,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: true,
        participantResultsReady: true,
      },
      publishStatus: 503,
    });
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    const hide = await screen.findByRole("button", { name: "参加者結果を非公開" });

    await user.click(hide);

    expect(await screen.findByRole("alert")).toHaveTextContent("再試行してください");
    await waitFor(() => expect(document.activeElement).toBe(hide));
  });

  it("does not move retry focus to aggregate when a failed publish becomes unavailable", async () => {
    let stateReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/participant-results") return response(503, {});
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        return response(200, {
          state: "finished",
          snapshotRevision: 1,
          questionIndex: 5,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: stateReads === 1,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    const publish = await screen.findByRole("button", { name: "参加者結果を公開" });

    await user.click(publish);

    expect(await screen.findByRole("alert")).toHaveTextContent("再試行してください");
    expect(screen.getByRole("button", { name: "参加者結果を公開" })).toBeDisabled();
    await waitFor(() => expect(stateReads).toBe(2));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "集計" }));
  });

  it("focuses aggregate when hiding leaves publish unavailable", async () => {
    let participantResultsVisible = true;
    let participantResultsReady = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/participant-results") {
        participantResultsVisible = false;
        participantResultsReady = false;
        return response(200, { visible: false });
      }
      if (path === "/api/admin/presentation")
        return response(200, {
          state: "finished",
          snapshotRevision: 1,
          questionIndex: 5,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible,
          participantResultsReady,
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    await user.click(await screen.findByRole("button", { name: "参加者結果を非公開" }));

    expect(await screen.findByRole("button", { name: "参加者結果を公開" })).toBeDisabled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "集計" })),
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
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "参加者結果を公開" }));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "集計" }));
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

  it("does not restore retry focus after focus moves during a pending publication", async () => {
    let releasePublish!: () => void;
    let signalPublishStarted!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      signalPublishStarted = resolve;
    });
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/participant-results") {
        signalPublishStarted();
        await publishGate;
        return response(503, {});
      }
      if (path === "/api/admin/presentation")
        return response(200, {
          state: "finished",
          snapshotRevision: 1,
          questionIndex: 5,
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
    const publish = await screen.findByRole("button", { name: "参加者結果を公開" });
    await user.click(publish);
    await publishStarted;

    const projectionButton = screen.getByRole("button", {
      name: "投影画面を開く / 投影タブへ戻る",
    });
    projectionButton.focus();
    expect(document.activeElement).toBe(projectionButton);

    releasePublish();
    expect(await screen.findByRole("alert")).toHaveTextContent("再試行してください");
    await waitFor(() => expect(document.activeElement).toBe(projectionButton));
  });

  it("does not hand off focus when the visibility refresh fails", async () => {
    let stateReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/participant-results") return response(200, { visible: true });
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads > 1) return response(503, {});
        return response(200, {
          state: "finished",
          snapshotRevision: 1,
          questionIndex: 5,
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
    await user.click(await screen.findByRole("button", { name: "参加者結果を公開" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.queryByRole("button", { name: "参加者結果を非公開" })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "集計" }));
  });

  it("does not hand off focus when visibility succeeds but the refresh expires the session", async () => {
    let publishPosted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/participant-results") {
        publishPosted = true;
        return response(200, { visible: true });
      }
      if (path === "/api/admin/presentation" && publishPosted) return response(401, {});
      if (path === "/api/admin/presentation")
        return response(200, {
          state: "finished",
          snapshotRevision: 1,
          questionIndex: 5,
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
    await user.click(await screen.findByRole("button", { name: "参加者結果を公開" }));

    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
  });

  it("clears visibility focus intent when a pending refresh expires authentication", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let stateReads = 0;
    let finishVisibleRefresh: ((result: Response) => void) | undefined;
    let publicationRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/participant-results") {
        publicationRequests += 1;
        return Promise.resolve(response(200, { visible: true }));
      }
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2)
          return new Promise<Response>((resolve) => {
            finishVisibleRefresh = resolve;
          });
        return Promise.resolve(
          stateReads > 2
            ? response(401, {})
            : response(200, {
                state: "finished",
                snapshotRevision: 1,
                questionIndex: 5,
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
    const user = userEvent.setup();
    try {
      render(<PresentationAdmin />);
      const publish = await screen.findByRole("button", { name: "参加者結果を公開" });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(stateReads).toBe(2));
      await user.click(publish);

      await act(async () => finishVisibleRefresh?.(response(401, {})));
      expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
      expect(publicationRequests).toBe(0);
    } finally {
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("keeps publication retryable when the failed response has invalid JSON", async () => {
    let publicationAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/presentation")
        return response(200, {
          state: "finished",
          snapshotRevision: 1,
          questionIndex: 5,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        });
      if (path === "/api/admin/participant-results" && init?.method === "POST") {
        publicationAttempts += 1;
        return new Response("not JSON", { status: 503 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    await user.click(await screen.findByRole("button", { name: "参加者結果を公開" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("結果の準備または公開に失敗しました");
    expect(alert).not.toHaveTextContent("not JSON");
    expect(screen.getByText("現在の状態：終了")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "参加者結果を公開" })).toBeInTheDocument();
    expect(publicationAttempts).toBe(1);
  });

  it("keeps the expired-session message when a failed action refresh gets a state 401", async () => {
    let publishAttempted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/session") return response(200, { authenticated: true });
        if (path === "/api/admin/participant-results") {
          publishAttempted = true;
          return response(503, {});
        }
        if (path === "/api/admin/presentation" && publishAttempted) return response(401, {});
        if (path === "/api/admin/presentation")
          return response(200, {
            state: "finished",
            snapshotRevision: 1,
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
    ["opening", "進行中：オープニング", false],
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
      if (String(input) === "/api/admin/presentation") return response(503, {});
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);
    const pinInput = await screen.findByLabelText("管理者 PIN");
    const form = pinInput.closest("form");
    if (!form) throw new Error("PIN form was not rendered");
    fireEvent.submit(form);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input) === "/api/admin/session" && init?.method === "POST",
      ),
    ).toBe(false);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("管理者 PIN"), "0000");
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
      if (String(input) === "/api/admin/presentation" && loginPosts === 0)
        return Promise.resolve(response(503, {}));
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
    const pinInput = await screen.findByLabelText("管理者 PIN");
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
    await waitFor(() => expect(loginPosts).toBe(2));
    expect(await screen.findByText("現在の状態：未開始")).toBeInTheDocument();
  });

  it("shows the login error when the server accepts a request without authenticating", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/session" && init?.method === "POST")
        return response(200, { authenticated: false });
      if (String(input) === "/api/admin/session") return response(200, { authenticated: false });
      if (String(input) === "/api/admin/presentation") return response(503, {});
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    await user.type(await screen.findByLabelText("管理者 PIN"), "0000");
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
      if (String(input) === "/api/admin/presentation") return response(503, {});
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    await user.type(await screen.findByLabelText("管理者 PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ログインできませんでした");
  });

  it("keeps startup auth unknown when session fallback JSON cannot be parsed", async () => {
    const malformedSession = new Response(null, { status: 200 });
    Object.defineProperty(malformedSession, "json", {
      value: vi.fn().mockRejectedValue(new Error("invalid JSON")),
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/session") return malformedSession;
      if (String(input) === "/api/admin/presentation") return response(503, {});
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("管理状態を取得しています…")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/presentation"),
    ).toHaveLength(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.queryByLabelText("管理者 PIN")).not.toBeInTheDocument();
  });

  it("uses the generic login message when the request rejects without an Error object", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/admin/session" && init?.method === "POST")
        return Promise.reject("network unavailable");
      if (String(input) === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: false }));
      if (String(input) === "/api/admin/presentation") return Promise.resolve(response(503, {}));
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    await user.type(await screen.findByLabelText("管理者 PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "管理ページにログイン" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ログインできませんでした");
  });

  it("returns to PIN entry when an action refresh receives state 401", async () => {
    let actionPosted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        actionPosted = true;
        return response(200, {});
      }
      if (path === "/api/admin/presentation" && actionPosted) return response(401, {});
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
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));
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

  it("serializes polling until the current refresh settles", async () => {
    let finishFirstState: ((value: Response) => void) | undefined;
    let presentationReads = 0;
    let poll: (() => void) | undefined;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
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
    expect(presentationReads).toBe(1);
    expect(poll).toBeUndefined();

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
    });
    await waitFor(() => expect(poll).toBeDefined());
    act(() => poll?.());
    expect(await screen.findByText("現在の状態：進行中：解答")).toBeInTheDocument();
    expect(presentationReads).toBe(2);
  });

  it("keeps one pending poll timer when visibility return and refresh completion coincide", async () => {
    let finishPollState: ((value: Response) => void) | undefined;
    let presentationReads = 0;
    let sessionReads = 0;
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let nextTimerId = 0;
    const pendingPollTimers = new Set<number>();
    const pollHandlers = new Map<number, () => void>();
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") {
        const id = ++nextTimerId;
        pendingPollTimers.add(id);
        pollHandlers.set(id, handler as () => void);
        return id as unknown as ReturnType<typeof window.setTimeout>;
      }
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    vi.spyOn(window, "clearTimeout").mockImplementation((id) => {
      if (typeof id === "number" && pendingPollTimers.delete(id)) {
        pollHandlers.delete(id);
        return;
      }
      nativeClearTimeout(id);
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") {
        sessionReads += 1;
        return Promise.resolve(response(200, { authenticated: true }));
      }
      if (path === "/api/admin/presentation") {
        presentationReads += 1;
        if (presentationReads === 2)
          return new Promise<Response>((resolve) => {
            finishPollState = resolve;
          });
        return Promise.resolve(
          response(200, {
            state: "question",
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

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    expect(pendingPollTimers.size).toBe(1);
    const [initialTimer] = pendingPollTimers;
    act(() => {
      const handler = pollHandlers.get(initialTimer);
      pendingPollTimers.delete(initialTimer);
      pollHandlers.delete(initialTimer);
      handler?.();
    });
    await waitFor(() => expect(finishPollState).toBeDefined());

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(pendingPollTimers.size).toBe(0);
    await act(async () => {
      finishPollState?.(
        response(200, {
          state: "answer",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });

    await waitFor(() => expect(sessionReads).toBe(0));
    await waitFor(() => expect(presentationReads).toBe(3));
    await waitFor(() => expect(pendingPollTimers.size).toBe(1));
    expect(pendingPollTimers.size).toBe(1);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("joins a duplicate ordinary poll to the refresh already in flight", async () => {
    let finishPoll: ((value: Response) => void) | undefined;
    let poll: (() => void) | undefined;
    let presentationReads = 0;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation") {
        presentationReads += 1;
        if (presentationReads === 2)
          return new Promise<Response>((resolve) => {
            finishPoll = resolve;
          });
        return Promise.resolve(
          response(200, {
            state: "question",
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

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeDefined());
    act(() => {
      poll?.();
      poll?.();
    });
    await waitFor(() => expect(presentationReads).toBe(2));
    expect(presentationReads).toBe(2);

    await act(async () => {
      finishPoll?.(
        response(200, {
          state: "answer",
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
    });
    expect(screen.getByText("現在の状態：進行中：解答")).toBeInTheDocument();
    expect(presentationReads).toBe(2);
  });

  it("queues a visible state check behind an in-flight state refresh", async () => {
    let finishFirstState: ((value: Response) => void) | undefined;
    let sessionReads = 0;
    let stateReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") {
        sessionReads += 1;
        return Promise.resolve(response(200, { authenticated: true }));
      }
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 1) {
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

    await waitFor(() => expect(stateReads).toBe(1));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
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
    });

    await waitFor(() => expect(stateReads).toBe(2));
    expect(sessionReads).toBe(0);
    expect(screen.getByText("現在の状態：進行中：解答")).toBeInTheDocument();
  });

  it("waits for a poll to settle before starting an administrator action", async () => {
    let poll: (() => void) | undefined;
    let resolvePoll!: (value: Response) => void;
    let presentationReads = 0;
    let mutationReads = 0;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        mutationReads += 1;
        return Promise.resolve(response(200, {}));
      }
      if (path === "/api/admin/presentation") {
        presentationReads += 1;
        if (presentationReads === 2)
          return new Promise<Response>((resolve) => {
            resolvePoll = resolve;
          });
        return Promise.resolve(
          response(200, {
            state: "question",
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
    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeDefined());
    act(() => poll?.());
    await waitFor(() => expect(presentationReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "最初に戻る" }));
    expect(mutationReads).toBe(0);

    await act(async () => {
      resolvePoll(
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
    });
    await waitFor(() => expect(mutationReads).toBe(1));
  });

  it("keeps polling paused while an administrator action is pending", async () => {
    let poll: (() => void) | undefined;
    let finishAction!: (value: Response) => void;
    let stateReads = 0;
    let mutationReads = 0;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        mutationReads += 1;
        return new Promise<Response>((resolve) => {
          finishAction = resolve;
        });
      }
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        return Promise.resolve(
          response(200, {
            state: "question",
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
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));
    await waitFor(() => expect(mutationReads).toBe(1));
    expect(poll).toBeDefined();

    act(() => poll?.());
    expect(stateReads).toBe(1);

    await act(async () => finishAction(response(200, {})));
    await waitFor(() => expect(stateReads).toBe(2));
    expect(mutationReads).toBe(1);
  });

  it("aborts a pending polling request on unmount", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation") {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<PresentationAdmin />);
    await waitFor(() => expect(requestSignal).toBeDefined());
    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("does not schedule another poll when the initial refresh settles after unmount", async () => {
    let finishState: ((value: Response) => void) | undefined;
    const scheduledPolls: number[] = [];
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500) {
        scheduledPolls.push(delay);
        return 1 as unknown as ReturnType<typeof window.setTimeout>;
      }
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
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
    const view = render(<PresentationAdmin />);
    await waitFor(() => expect(finishState).toBeDefined());
    view.unmount();

    await act(async () => {
      finishState?.(
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
    });
    expect(scheduledPolls).toEqual([]);
  });

  it("ignores an ordinary poll callback racing with unmount", async () => {
    let poll: (() => void) | undefined;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/admin/session") return response(200, { authenticated: true });
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
    const view = render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeDefined());
    view.unmount();
    await act(async () => poll?.());

    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/session"),
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/presentation"),
    ).toHaveLength(1);
  });

  it("ignores a state response made stale by unmount", async () => {
    let finishState: ((value: Response) => void) | undefined;
    const scheduledPolls: number[] = [];
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500) {
        scheduledPolls.push(delay);
        return 1 as unknown as ReturnType<typeof window.setTimeout>;
      }
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/presentation")
        return new Promise<Response>((resolve) => {
          finishState = resolve;
        });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<PresentationAdmin />);
    await waitFor(() => expect(finishState).toBeDefined());
    view.unmount();

    await act(async () => {
      finishState?.(
        response(200, {
          state: "question",
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(scheduledPolls).toEqual([]);
  });

  it("does not apply an older successful state response after the page is replaced", async () => {
    const finishStates: ((value: Response) => void)[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/presentation")
        return new Promise<Response>((resolve) => {
          finishStates.push(resolve);
        });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstView = render(<PresentationAdmin />);
    await waitFor(() => expect(finishStates).toHaveLength(1));
    firstView.unmount();
    render(<PresentationAdmin />);
    await waitFor(() => expect(finishStates).toHaveLength(2));

    await act(async () => {
      finishStates[1](
        response(200, {
          state: "answer",
          snapshotRevision: 2,
          questionIndex: 1,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
    });
    expect(await screen.findByText("現在の状態：進行中：解答")).toBeInTheDocument();

    await act(async () => {
      finishStates[0](
        response(200, {
          state: "question",
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
          participantResultsVisible: false,
          participantResultsReady: true,
        }),
      );
    });

    expect(screen.getByText("現在の状態：進行中：解答")).toBeInTheDocument();
    expect(screen.queryByText("現在の状態：進行中：問題")).not.toBeInTheDocument();
  });

  it.each(["fallback session status", "state"] as const)(
    "ignores a rejected %s request made stale by unmount",
    async (requestKind) => {
      let rejectRequest: ((reason: Error) => void) | undefined;
      let finishInitialState: ((value: Response) => void) | undefined;
      let stateReads = 0;
      const scheduledPolls: number[] = [];
      const nativeSetTimeout = window.setTimeout.bind(window);
      vi.spyOn(window, "setTimeout").mockImplementation(((
        handler: TimerHandler,
        delay?: number,
      ) => {
        if (delay === 2500) {
          scheduledPolls.push(delay);
          return 1 as unknown as ReturnType<typeof window.setTimeout>;
        }
        return nativeSetTimeout(handler, delay);
      }) as typeof window.setTimeout);
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/session")
          return new Promise<Response>((_resolve, reject) => {
            rejectRequest = reject;
          });
        if (path === "/api/admin/presentation") {
          stateReads += 1;
          if (requestKind === "fallback session status") return Promise.resolve(response(503, {}));
          if (stateReads === 1)
            return new Promise<Response>((resolve) => {
              finishInitialState = resolve;
            });
          return new Promise<Response>((_resolve, reject) => {
            rejectRequest = reject;
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const view = render(<PresentationAdmin />);
      await waitFor(() =>
        expect(
          requestKind === "fallback session status" ? rejectRequest : finishInitialState,
        ).toBeDefined(),
      );
      if (requestKind === "state") {
        await act(async () =>
          finishInitialState?.(
            response(200, {
              state: "question",
              questionIndex: 0,
              questionCount: 5,
              projectionHidden: false,
              participantResultsVisible: false,
              participantResultsReady: true,
            }),
          ),
        );
        act(() => document.dispatchEvent(new Event("visibilitychange")));
        await waitFor(() => expect(rejectRequest).toBeDefined());
      }
      const scheduledPollCountBeforeUnmount = scheduledPolls.length;
      view.unmount();

      await act(async () => {
        rejectRequest?.(new TypeError("Failed to fetch"));
        await Promise.resolve();
      });
      expect(scheduledPolls).toHaveLength(scheduledPollCountBeforeUnmount);
    },
  );

  it("does not post an action when its in-flight refresh expires the session", async () => {
    let poll: (() => void) | undefined;
    let finishPoll: ((value: Response) => void) | undefined;
    let stateReads = 0;
    let actionPosts = 0;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        actionPosts += 1;
        return Promise.resolve(response(200, {}));
      }
      if (path === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads === 2)
          return new Promise<Response>((resolve) => {
            finishPoll = resolve;
          });
        return Promise.resolve(
          response(200, {
            state: "question",
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
    const user = userEvent.setup();
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeDefined());
    act(() => poll?.());
    await waitFor(() => expect(stateReads).toBe(2));
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));
    expect(actionPosts).toBe(0);

    await act(async () => finishPoll?.(response(401, {})));
    expect(await screen.findByLabelText("管理者 PIN")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("セッションの有効期限が切れました");
    expect(actionPosts).toBe(0);
  });

  it("aborts a timed out poll and starts the next read", async () => {
    vi.useFakeTimers();
    let presentationReads = 0;
    let timedOutSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (path === "/api/admin/presentation") {
        presentationReads += 1;
        if (presentationReads === 2) {
          timedOutSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        }
        return Promise.resolve(
          response(200, {
            state: presentationReads > 2 ? "answer" : "question",
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
    await act(async () => {
      for (let index = 0; index < 8 && presentationReads === 0; index += 1) await Promise.resolve();
    });
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(presentationReads).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(timedOutSignal?.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("自動で再試行しています");
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(presentationReads).toBe(3);
    expect(screen.getByText("現在の状態：進行中：解答")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

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
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
  });

  it("does not show projection visibility controls when projection is hidden", async () => {
    apiFetch({
      state: {
        state: "answer",
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: true,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：解答")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "投影を一時非表示" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "投影を表示" })).not.toBeInTheDocument();
  });

  it("shows refresh errors in the authenticated loading console", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/session") return response(200, { authenticated: true });
      if (String(input) === "/api/admin/presentation") return response(503, {});
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByRole("heading", { name: "披露宴 発表操作" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
  });

  it("shows a retry message when the state request rejects without an HTTP status", async () => {
    let stateReads = 0;
    let poll: (() => void) | undefined;
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") poll = handler as () => void;
      if (delay === 2500) return 1 as unknown as ReturnType<typeof window.setTimeout>;
      return nativeSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/session")
        return Promise.resolve(response(200, { authenticated: true }));
      if (String(input) === "/api/admin/presentation") {
        stateReads += 1;
        if (stateReads > 1) return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve(
          response(200, {
            state: "question",
            questionIndex: 0,
            questionCount: 5,
            projectionHidden: false,
            participantResultsVisible: false,
            participantResultsReady: true,
          }),
        );
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeDefined());
    await act(async () => poll?.());
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
    expect(stateReads).toBe(2);
  });

  it("keeps auth unknown and shows a retry message when fallback session status rejects", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/admin/session")
        return Promise.reject(new TypeError("Failed to fetch"));
      if (String(input) === "/api/admin/presentation") return Promise.resolve(response(503, {}));
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationAdmin />);

    expect(await screen.findByText("管理状態を取得しています…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("自動で再試行しています");
    expect(screen.queryByLabelText("管理者 PIN")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "操作を反映できませんでした。状態を再確認してから再試行してください。",
    );
    expect(actionAttempts).toBe(1);
    expect(screen.getByText("現在の状態：進行中：問題")).toBeInTheDocument();
  });

  it("executes reset immediately without showing a confirmation dialog", async () => {
    const api = apiFetch({
      state: { state: "question", questionIndex: 0 },
    });
    const user = userEvent.setup();
    render(<PresentationAdmin />);
    expect(await screen.findByText("現在の状態：進行中：問題")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "最初に戻る" }));
    await waitFor(() =>
      expect(api.actions).toContainEqual({
        path: "/api/admin/presentation",
        body: expect.objectContaining({ action: "reset" }),
      }),
    );
    expect(screen.queryByText("最初に戻る確認")).not.toBeInTheDocument();
    expect(api.actions.filter((a) => (a.body as any).action === "reset")).toHaveLength(1);
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
