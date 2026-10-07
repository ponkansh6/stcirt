import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationScreen from "@/app/presentation/presentation-screen";

type Projection = Record<string, unknown>;

const question = {
  id: 1,
  ordinal: 1,
  total: 2,
  question: "思い出の場所は？",
  choices: ["海", "山"],
};

function response(body: unknown, ok = true, status = 200): Response {
  const result = new Response(JSON.stringify(body), { status });
  if (result.ok !== ok) Object.defineProperty(result, "ok", { value: ok });
  return result;
}

function malformedJsonResponse(status = 200): Response {
  const result = new Response(null, { status });
  Object.defineProperty(result, "json", {
    value: vi.fn().mockRejectedValue(new Error("invalid JSON")),
  });
  return result;
}

function controls(overrides: Record<string, unknown> = {}) {
  return {
    state: "not_started",
    questionIndex: 0,
    questionCount: 2,
    projectionHidden: false,
    presentationMode: "full",
    participantResultsVisible: false,
    participantResultsReady: true,
    ...overrides,
  };
}

function installApi(
  options: {
    projection?: Projection;
    actionProjection?: Projection;
    actionAdmin?: Record<string, unknown>;
    projectionResponse?: () => Promise<Response>;
    admin?: Record<string, unknown>;
    adminResponse?: () => Promise<Response>;
    sessionResponse?: () => Promise<Response>;
    authenticated?: boolean;
    actionError?: number;
    visibilityError?: number;
    visibilityErrorBody?: unknown;
    visibilityErrorResponse?: () => Promise<Response>;
  } = {},
) {
  let projection = options.projection ?? { state: "not_started" };
  let admin = options.admin ?? controls();
  let actionProjection = options.actionProjection;
  let actionAdmin = options.actionAdmin;
  let actionError = options.actionError;
  let visibilityError = options.visibilityError;
  let visibilityErrorBody = options.visibilityErrorBody;
  const actions: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/presentation")
      return options.projectionResponse ? options.projectionResponse() : response(projection);
    if (path === "/api/admin/session")
      return options.sessionResponse
        ? options.sessionResponse()
        : response({ authenticated: options.authenticated ?? true });
    if (path === "/api/admin/presentation" && init?.method === "POST") {
      const action = JSON.parse(String(init.body)) as Record<string, unknown>;
      actions.push(action);
      if (actionError) {
        const status = actionError;
        actionError = undefined;
        if (status === 401) options.authenticated = false;
        return response({}, false, status);
      }
      if (actionProjection) projection = actionProjection;
      if (actionAdmin) admin = actionAdmin;
      return response({ ok: true });
    }
    if (path === "/api/admin/presentation")
      return options.adminResponse ? options.adminResponse() : response(admin);
    if (path === "/api/admin/participant-results") {
      if (options.visibilityErrorResponse) return options.visibilityErrorResponse();
      if (visibilityError) {
        const status = visibilityError;
        visibilityError = undefined;
        if (status === 401) options.authenticated = false;
        return response(visibilityErrorBody, false, status);
      }
      return response({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    actions,
    fetchMock,
    setProjection(value: Projection) {
      projection = value;
    },
    setActionProjection(value: Projection) {
      actionProjection = value;
    },
    setActionAdmin(value: Record<string, unknown>) {
      actionAdmin = value;
    },
  };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function flushOperation() {
  await flush();
}

describe("PresentationScreen", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "presentation-operation") });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the initial wait screen and preserves it when projection polling fails", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(response(null, false, 503));
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: /ふたりの思い出を/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/presentation", {
      cache: "no-store",
      credentials: "omit",
    });
  });

  it("keeps the initial screen when projection JSON is malformed or the error has no message", async () => {
    installApi({ projectionResponse: async () => response(null, false, 503) });
    const view = render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: /ふたりの思い出を/ })).toBeInTheDocument();
    view.unmount();
    installApi({
      projectionResponse: async () => malformedJsonResponse(),
    });
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: /ふたりの思い出を/ })).toBeInTheDocument();
  });

  it("retries projection polling after a failed response with an error payload", async () => {
    vi.useFakeTimers();
    let projectionCalls = 0;
    installApi({
      projectionResponse: async () => {
        projectionCalls += 1;
        if (projectionCalls === 1) return response({ error: "準備中" }, false, 503);
        return response({ state: "standby" });
      },
    });
    render(<PresentationScreen />);
    await flush();
    expect(projectionCalls).toBe(1);
    expect(screen.getByRole("heading", { name: /ふたりの思い出を/ })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    await flush();
    expect(projectionCalls).toBe(2);
    expect(screen.getByText("ただいま休憩中です")).toBeInTheDocument();
  });

  it("does not start a queued projection poll after unmount", async () => {
    vi.useFakeTimers();
    const api = installApi({ projection: { state: "standby" } });
    const view = render(<PresentationScreen />);
    await flush();
    expect(
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
    ).toHaveLength(1);
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    expect(
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
    ).toHaveLength(1);
  });

  it("ignores a queued projection callback invoked after unmount", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const api = installApi({ projection: { state: "standby" } });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen />);
      await flush();
      const projectionTimer = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 1400)?.[0] as
        | (() => void)
        | undefined;
      expect(projectionTimer).toBeDefined();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
      ).toHaveLength(1);
      setTimeoutSpy.mockRestore();
      view.unmount();
      view = undefined;
      await act(async () => {
        await projectionTimer?.();
      });
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
      ).toHaveLength(1);
    } finally {
      setTimeoutSpy.mockRestore();
      view?.unmount();
    }
  });

  it("reschedules projection polling while an admin mutation is in flight", async () => {
    vi.useFakeTimers();
    let releaseAction!: () => void;
    let signalAction!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      signalAction = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const api = installApi({
      admin: controls(),
    });
    api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/presentation") return response({ state: "not_started" });
      if (path === "/api/admin/session") return response({ authenticated: true });
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        signalAction();
        await actionGate;
        return response({ ok: true });
      }
      if (path === "/api/admin/presentation") return response(controls());
      throw new Error(`Unexpected fetch: ${path}`);
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "プレゼンを開始" }));
    await actionStarted;
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    await flush();
    expect(
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
    ).toHaveLength(1);
    releaseAction();
    await flush();
    expect(
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
    ).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    await flush();
    expect(
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
    ).toHaveLength(3);
  });

  it.each([
    ["standby", "ただいま休憩中です"],
    ["not_started", "発表が始まるまで、少々お待ちください"],
    ["podium_preview", "いよいよ、結果発表です"],
    ["finished", "ご参加"],
  ] as const)("renders the %s projection", async (state, text) => {
    installApi({ projection: { state } });
    render(<PresentationScreen />);
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });

  it("renders a question and its ordered choices", async () => {
    installApi({ projection: { state: "question", question } });
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByText(/QUESTION/).parentElement).toHaveTextContent("1 / 2");
    expect(screen.getByRole("list")).toHaveTextContent("A海B山");
  });

  it("renders full and short selected-answer reviews, including explanation fallbacks", async () => {
    installApi({
      projection: {
        state: "answer",
        question: {
          ...question,
          correctIndex: 1,
          correctAnswer: "山の方",
          explanation: "家族旅行で訪れました。",
        },
      },
    });
    const view = render(<PresentationScreen />);
    expect(await screen.findByText("家族旅行で訪れました。")).toBeInTheDocument();
    expect(screen.getAllByText("正解")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByText("山")).toBeInTheDocument();

    installApi({ projection: { state: "answer", question: { ...question, correctAnswer: "海" } } });
    view.unmount();
    render(<PresentationScreen />);
    const shortAnswer = await screen.findByText(
      (_, element) => element?.tagName === "P" && element.textContent === "海",
    );
    expect(shortAnswer).toBeInTheDocument();
  });

  it("renders free-text responses with missing optional scores and empty response lists", async () => {
    installApi({
      projection: {
        state: "answer",
        question: {
          ...question,
          answerType: "freeText",
          expectedAnswer: "海辺",
          responses: [
            {
              displayName: "葵",
              answerKind: "legacy",
              answer: null,
              similarity: null,
              score: null,
            },
            { displayName: "凛", answerKind: "unanswered", similarity: null, score: null },
            {
              displayName: "悠",
              answerKind: "freeText",
              answer: "海辺",
              similarity: 0.8,
              score: 1,
            },
            { displayName: "蓮", answerKind: "selected", similarity: null, score: null },
          ],
        },
      },
    });
    const view = render(<PresentationScreen />);
    expect(await screen.findByText("葵：旧選択式回答（再採点なし）")).toBeInTheDocument();
    expect(screen.getByText("凛：未回答")).toBeInTheDocument();
    expect(screen.getByText("悠：海辺 — 類似度 0.80 / 得点 1.00")).toBeInTheDocument();
    expect(screen.getByText("蓮： — 類似度 — / 得点 —")).toBeInTheDocument();

    view.unmount();
    installApi({
      projection: { state: "answer", question: { ...question, answerType: "freeText" } },
    });
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: question.question })).toBeInTheDocument();
  });

  it.each([
    ["third", "第3位", "葵"],
    ["second", "第2位", "凛"],
    ["first", "第1位", "悠"],
  ])("shows the %s winner announcement", async (state, label, winner) => {
    installApi({
      projection: { state, winners: [{ displayName: winner, score: 12.5, rank: 1 }] },
    });
    render(<PresentationScreen />);
    expect(await screen.findByRole("region", { name: `${label}の勝者一覧` })).toHaveTextContent(
      winner,
    );
    expect(screen.getByText("12.50 ポイント")).toBeInTheDocument();
  });

  it("shows the empty-winner state", async () => {
    installApi({ projection: { state: "first", winners: [] } });
    render(<PresentationScreen />);
    expect(await screen.findByText("該当する受賞者はいません")).toBeInTheDocument();
  });

  it("does not expose presenter controls when the session is anonymous", async () => {
    installApi({ authenticated: false });
    render(<PresentationScreen presenterRequested />);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/admin/session", expect.anything()),
    );
    expect(screen.queryByRole("button", { name: "プレゼンを開始" })).not.toBeInTheDocument();
  });

  it("navigates when a keyboard event originates from non-element slide text", async () => {
    const api = installApi({
      projection: { state: "not_started" },
      actionProjection: { state: "question", question },
      admin: controls(),
      actionAdmin: controls({ state: "question", questionIndex: 0 }),
    });
    render(<PresentationScreen presenterRequested />);
    const slide = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await screen.findByRole("button", { name: "プレゼンを開始" });
    const textNode = document.createTextNode("keyboard target");
    slide.append(textNode);
    fireEvent.keyDown(textNode, { key: "ArrowRight" });
    await screen.findByRole("heading", { name: question.question });
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "start" });
  });

  it.each([
    [
      "unauthenticated response",
      { sessionResponse: async () => response({ authenticated: false }) },
    ],
    ["session fetch error", { sessionResponse: async () => response({}, false, 503) }],
    [
      "admin controls status error",
      {
        sessionResponse: async () => response({ authenticated: true }),
        adminResponse: async () => response({}, false, 503),
      },
    ],
    [
      "admin controls null payload",
      {
        sessionResponse: async () => response({ authenticated: true }),
        adminResponse: async () => response(null),
      },
    ],
  ] as const)("keeps admin controls unavailable after %s", async (_label, apiResponses) => {
    const api = installApi({
      ...apiResponses,
    });
    render(<PresentationScreen presenterRequested />);
    await waitFor(() => expect(api.fetchMock).toHaveBeenCalled());
    await flush();
    expect(screen.queryByRole("button", { name: "プレゼンを開始" })).not.toBeInTheDocument();
  });

  it.each([
    ["session", "/api/admin/session"],
    ["controls", "/api/admin/presentation"],
  ] as const)(
    "keeps presenter controls unavailable when %s JSON cannot be parsed",
    async (_label, path) => {
      const api = installApi({
        sessionResponse: async () =>
          path === "/api/admin/session"
            ? malformedJsonResponse()
            : response({ authenticated: true }),
        adminResponse: async () =>
          path === "/api/admin/presentation" ? malformedJsonResponse() : response(controls()),
      });
      render(<PresentationScreen presenterRequested />);
      await waitFor(() => expect(api.fetchMock).toHaveBeenCalledWith(path, expect.anything()));
      await flush();
      expect(screen.queryByRole("button", { name: "プレゼンを開始" })).not.toBeInTheDocument();
    },
  );

  it("refreshes presenter controls from the interval callback", async () => {
    vi.useFakeTimers();
    let adminCalls = 0;
    const api = installApi({
      adminResponse: async () => {
        adminCalls += 1;
        return response(controls({ state: adminCalls === 1 ? "not_started" : "question" }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(adminCalls).toBe(1);
    expect(screen.getByRole("button", { name: "プレゼンを開始" })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(adminCalls).toBe(2);
    expect(screen.queryByRole("button", { name: "プレゼンを開始" })).not.toBeInTheDocument();
    expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
  });

  it("accepts short presentation mode in admin controls", async () => {
    const api = installApi({ admin: controls({ presentationMode: "short" }) });
    render(<PresentationScreen presenterRequested />);
    expect(await screen.findByRole("button", { name: "プレゼンを開始" })).toBeInTheDocument();
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything()),
    );
  });

  it("does not refresh admin controls when a queued interval callback runs after unmount", async () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(window, "setInterval");
    const api = installApi({ admin: controls() });
    try {
      const view = render(<PresentationScreen presenterRequested />);
      await flush();
      const adminInterval = intervalSpy.mock.calls.find(([, delay]) => delay === 2500);
      expect(adminInterval).toBeDefined();
      if (!adminInterval) throw new Error("expected presenter refresh interval");
      view.unmount();
      const requestCount = api.fetchMock.mock.calls.filter(
        ([path]) => String(path) === "/api/admin/session",
      ).length;
      act(() => (adminInterval[0] as () => void)());
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/admin/session"),
      ).toHaveLength(requestCount);
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it.each(["session", "controls", "controls-error"] as const)(
    "ignores a stale %s response after newer admin state is applied",
    async (staleRequest) => {
      let resolveStaleSession!: (value: Response) => void;
      let resolveStaleControls!: (value: Response) => void;
      let rejectStaleControls!: (reason: Error) => void;
      let staleSessionSettled = false;
      let staleControlsSettled = false;
      const staleSession = new Promise<Response>((resolve) => {
        resolveStaleSession = resolve;
      });
      const staleControls = new Promise<Response>((resolve, reject) => {
        resolveStaleControls = resolve;
        rejectStaleControls = reject;
      });
      let sessionCalls = 0;
      let adminCalls = 0;
      const api = installApi({ admin: controls() });
      api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/presentation")
          return response(
            api.actions.length ? { state: "question", question } : { state: "not_started" },
          );
        if (path === "/api/admin/session") {
          sessionCalls += 1;
          if (sessionCalls === 1 && staleRequest === "session") return staleSession;
          return response({ authenticated: true });
        }
        if (path === "/api/admin/presentation" && init?.method === "POST") {
          api.actions.push(JSON.parse(String(init.body)));
          return response({ ok: true });
        }
        if (path === "/api/admin/presentation") {
          adminCalls += 1;
          if (adminCalls === 1 && staleRequest !== "session") return staleControls;
          return response(controls({ state: api.actions.length > 0 ? "question" : "not_started" }));
        }
        throw new Error(`Unexpected fetch: ${path}`);
      });
      const intervalSpy = vi.spyOn(window, "setInterval");
      const view = render(<PresentationScreen presenterRequested />);
      try {
        await waitFor(() => expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 2500));
        const intervalCallback = intervalSpy.mock.calls.find(([, delay]) => delay === 2500)?.[0] as
          | (() => void)
          | undefined;
        expect(intervalCallback).toBeDefined();
        act(() => intervalCallback?.());
        fireEvent.click(await screen.findByRole("button", { name: "プレゼンを開始" }));
        await screen.findByRole("heading", { name: question.question });
        await waitFor(() => expect(api.actions).toHaveLength(1));
        await waitFor(() => expect(adminCalls).toBe(staleRequest === "session" ? 2 : 3));
        if (staleRequest === "session") {
          await act(async () => resolveStaleSession(response({ authenticated: false })));
          staleSessionSettled = true;
        } else if (staleRequest === "controls-error") {
          await act(async () => rejectStaleControls(new Error("stale admin response")));
          staleControlsSettled = true;
        } else {
          await act(async () => resolveStaleControls(response(controls())));
          staleControlsSettled = true;
        }
        await flush();
        expect(screen.queryByRole("button", { name: "プレゼンを開始" })).not.toBeInTheDocument();
        fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
        await waitFor(() => expect(api.actions).toHaveLength(2));
        expect(api.actions[1]).toMatchObject({ action: "advance" });
      } finally {
        view.unmount();
        if (!staleSessionSettled) resolveStaleSession(response({ authenticated: false }));
        if (!staleControlsSettled) resolveStaleControls(response(controls()));
        intervalSpy.mockRestore();
      }
    },
  );

  it("starts presentation through the admin action and refreshes the slide", async () => {
    const api = installApi({
      projection: { state: "not_started" },
      actionProjection: { state: "question", question },
      admin: controls({ state: "not_started" }),
    });
    render(<PresentationScreen presenterRequested />);
    const start = await screen.findByRole("button", { name: "プレゼンを開始" });
    fireEvent.click(start);
    await screen.findByRole("heading", { name: question.question });
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "start" });
    expect(api.actions[0]).toHaveProperty("operationId", "presentation-operation");
  });

  it("ignores an older in-flight projection after the admin action refreshes the slide", async () => {
    let resolveFirstProjection!: (value: Response) => void;
    let firstProjectionSettled = false;
    const firstProjection = new Promise<Response>((resolve) => {
      resolveFirstProjection = resolve;
    });
    let projectionCalls = 0;
    const api = installApi({ admin: controls() });
    api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/presentation") {
        projectionCalls += 1;
        if (projectionCalls === 1) return firstProjection;
        return response({ state: "question", question });
      }
      if (path === "/api/admin/session") return response({ authenticated: true });
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        api.actions.push(JSON.parse(String(init.body)));
        return response({ ok: true });
      }
      if (path === "/api/admin/presentation")
        return response(controls({ state: api.actions.length ? "question" : "not_started" }));
      throw new Error(`Unexpected fetch: ${path}`);
    });
    const view = render(<PresentationScreen presenterRequested />);
    try {
      fireEvent.click(await screen.findByRole("button", { name: "プレゼンを開始" }));
      await screen.findByRole("heading", { name: question.question });
      expect(projectionCalls).toBe(2);
      await act(async () => resolveFirstProjection(response({ state: "standby" })));
      firstProjectionSettled = true;
      await flush();
      expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
      expect(screen.queryByText("ただいま休憩中です")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      if (!firstProjectionSettled) resolveFirstProjection(response({ state: "standby" }));
    }
  });

  it("starts the presentation with an unmodified Space key", async () => {
    const api = installApi({
      admin: controls(),
      actionProjection: { state: "question", question },
      actionAdmin: controls({ state: "question" }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await screen.findByRole("button", { name: "プレゼンを開始" });
    await flush();
    fireEvent.keyDown(main, { key: " " });
    await screen.findByRole("heading", { name: question.question });
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "start" });
  });

  it.each([
    [
      "question",
      "Enter",
      { state: "answer", question: { ...question, correctIndex: 0 } },
      controls({ state: "answer" }),
    ],
    [
      "question",
      " ",
      { state: "answer", question: { ...question, correctIndex: 0 } },
      controls({ state: "answer" }),
    ],
    [
      "podium_preview",
      "Enter",
      { state: "third", winners: [{ displayName: "葵", score: 9, rank: 3 }] },
      controls({ state: "third" }),
    ],
    [
      "podium_preview",
      " ",
      { state: "third", winners: [{ displayName: "葵", score: 9, rank: 3 }] },
      controls({ state: "third" }),
    ],
  ] as const)(
    "advances from %s with the %s key and applies the next projection",
    async (state, key, nextProjection, nextAdmin) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: true })),
      );
      const currentProjection = state === "question" ? { state, question } : { state };
      const api = installApi({
        projection: currentProjection,
        actionProjection: nextProjection,
        admin: controls({ state }),
        actionAdmin: nextAdmin,
      });
      render(<PresentationScreen presenterRequested />);
      const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
      await flush();
      fireEvent.keyDown(main, { key });
      if (nextProjection.state === "answer") {
        expect(await screen.findByText("THE STORY BEHIND IT")).toBeInTheDocument();
      } else {
        expect(await screen.findByRole("region", { name: "第3位の勝者一覧" })).toHaveTextContent(
          "葵",
        );
      }
      expect(api.actions).toHaveLength(1);
      expect(api.actions[0]).toMatchObject({ action: "advance" });
    },
  );

  it("drops presenter controls after an expired admin session", async () => {
    installApi({ admin: controls(), actionError: 401 });
    render(<PresentationScreen presenterRequested />);
    fireEvent.click(await screen.findByRole("button", { name: "プレゼンを開始" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "プレゼンを開始" })).not.toBeInTheDocument(),
    );
  });

  it.each([
    [409, "進行状態が更新されました。最新の投影状態に同期しました。"],
    [500, "操作を反映できませんでした。状態を再確認しています。"],
  ] as const)("recovers from a failed presenter action (%i)", async (status, message) => {
    installApi({ admin: controls(), actionError: status });
    render(<PresentationScreen presenterRequested />);
    fireEvent.click(await screen.findByRole("button", { name: "プレゼンを開始" }));
    expect(await screen.findByRole("status")).toHaveTextContent(message);
  });

  it("publishes participant results and reflects the published status on refresh", async () => {
    let releaseAdminRefresh!: () => void;
    let signalAdminRefresh!: () => void;
    const adminRefreshStarted = new Promise<void>((resolve) => {
      signalAdminRefresh = resolve;
    });
    const adminRefreshGate = new Promise<void>((resolve) => {
      releaseAdminRefresh = resolve;
    });
    let adminGetCount = 0;
    const api = installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished", participantResultsVisible: false }),
      adminResponse: async () => {
        adminGetCount += 1;
        if (adminGetCount === 1)
          return response(controls({ state: "finished", participantResultsVisible: false }));
        signalAdminRefresh();
        await adminRefreshGate;
        return response(controls({ state: "finished", participantResultsVisible: true }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    fireEvent.click(await screen.findByRole("button", { name: "参加者結果を公開" }));
    await adminRefreshStarted;
    expect(screen.queryByText("参加者結果は公開済みです")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "公開しています…" })).toBeDisabled();
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/participant-results",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ visible: true }) }),
    );
    const publishIndex = api.fetchMock.mock.calls.findIndex(
      ([path, init]) =>
        String(path) === "/api/admin/participant-results" && init?.method === "POST",
    );
    const adminRefreshIndex = api.fetchMock.mock.calls.findIndex(
      ([path, init], index) =>
        index > publishIndex &&
        String(path) === "/api/admin/presentation" &&
        init?.method !== "POST",
    );
    expect(adminRefreshIndex).toBeGreaterThan(publishIndex);
    releaseAdminRefresh();
    expect(await screen.findByText("参加者結果は公開済みです")).toBeInTheDocument();
  });

  it.each([
    [401, undefined],
    [503, { error: "準備中です" }],
    [503, undefined],
  ] as const)("keeps participant results private when publish fails", async (status, body) => {
    installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished" }),
      visibilityError: status,
      visibilityErrorBody: body,
    });
    render(<PresentationScreen presenterRequested />);
    fireEvent.click(await screen.findByRole("button", { name: "参加者結果を公開" }));
    if (status === 401)
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "参加者結果を公開" })).not.toBeInTheDocument(),
      );
    else
      expect(await screen.findByRole("status")).toHaveTextContent(
        "結果の準備または公開に失敗しました。結果は非公開のままです。",
      );
  });

  it("uses the generic publish error when the failed response JSON is malformed", async () => {
    const api = installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished" }),
      visibilityErrorResponse: async () => malformedJsonResponse(503),
    });
    render(<PresentationScreen presenterRequested />);
    fireEvent.click(await screen.findByRole("button", { name: "参加者結果を公開" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "結果の準備または公開に失敗しました。結果は非公開のままです。",
    );
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/participant-results",
      expect.objectContaining({ body: JSON.stringify({ visible: true }) }),
    );
  });

  it("uses keyboard navigation only for slide targets and ignores repeated or modified keys", async () => {
    const api = installApi({
      projection: { state: "not_started" },
      actionProjection: { state: "question", question },
      admin: controls(),
      actionAdmin: controls({ state: "question", questionIndex: 0 }),
    });
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    render(<PresentationScreen presenterRequested />);
    const slide = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    try {
      await waitFor(() =>
        expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything()),
      );
      await screen.findByRole("button", { name: "プレゼンを開始" });
      await flush();
      expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      fireEvent.keyDown(slide, { key: "ArrowRight", repeat: true });
      fireEvent.keyDown(slide, { key: "ArrowRight", ctrlKey: true });
      fireEvent.keyDown(slide, { key: "Enter", isComposing: true });
      fireEvent.keyDown(slide, { key: " ", isComposing: true });
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      const button = document.createElement("button");
      slide.append(button);
      fireEvent.keyDown(button, { key: "ArrowRight" });
      const editable = document.createElement("div");
      Object.defineProperty(editable, "isContentEditable", { configurable: true, value: true });
      slide.append(editable);
      fireEvent.keyDown(editable, { key: "ArrowRight" });
      const menuItem = document.createElement("div");
      menuItem.setAttribute("role", "menuitem");
      slide.append(menuItem);
      fireEvent.keyDown(menuItem, { key: "ArrowRight" });
      expect(api.actions).toHaveLength(0);

      slide.focus();
      await act(async () => {
        fireEvent.keyDown(slide, { key: "ArrowRight" });
      });
      await waitFor(() => {
        expect(api.actions).toHaveLength(1);
        expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "開始しています…" })).not.toBeInTheDocument();
      });
      expect(api.actions[0]).toMatchObject({ action: "start" });
    } finally {
      windowAddSpy.mockRestore();
    }
  });

  it("defaults malformed admin control values before applying navigation boundaries", async () => {
    const api = installApi({
      projection: { state: "question", question },
      admin: {
        state: "question",
        questionIndex: "0",
        questionCount: "2",
        projectionHidden: "true",
        presentationMode: "unknown",
        participantResultsVisible: 1,
        participantResultsReady: "true",
      },
    });
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    try {
      await waitFor(() =>
        expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything()),
      );
      await waitFor(() =>
        expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function)),
      );
      fireEvent.keyDown(main, { key: "ArrowLeft" });
      await flush();
      expect(api.actions).toHaveLength(0);
    } finally {
      windowAddSpy.mockRestore();
    }
  });

  it("announces a podium advance when tied winners arrive in a different name order", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const winners = [
      { displayName: "凛", score: 12, rank: 2 },
      { displayName: "葵", score: 12, rank: 2 },
      { displayName: "凛", score: 12, rank: 2 },
    ];
    const api = installApi({
      projection: {
        state: "third",
        winners: [{ displayName: "悠", score: 10, rank: 3 }],
      },
      actionProjection: { state: "second", winners },
      admin: controls({ state: "third" }),
      actionAdmin: controls({ state: "second" }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    const initialWinnerRegion = await screen.findByRole("region", { name: "第3位の勝者一覧" });
    expect(initialWinnerRegion).toHaveTextContent("悠");
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything()),
    );
    await flush();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
    const winnerRegion = await screen.findByRole("region", { name: "第2位の勝者一覧" });
    expect(winnerRegion).toHaveTextContent("凛");
    expect(winnerRegion).toHaveTextContent("葵");
    expect(winnerRegion.textContent!.indexOf("凛")).toBeLessThan(
      winnerRegion.textContent!.indexOf("葵"),
    );
    expect(winnerRegion.className).toContain("announce");
  });

  it("announces the first-place winner when advancing from second place", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const api = installApi({
      projection: {
        state: "second",
        winners: [{ displayName: "凛", score: 12, rank: 2 }],
      },
      actionProjection: {
        state: "first",
        winners: [{ displayName: "葵", score: 15, rank: 1 }],
      },
      admin: controls({ state: "second" }),
      actionAdmin: controls({ state: "first" }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    expect(await screen.findByRole("region", { name: "第2位の勝者一覧" })).toHaveTextContent("凛");
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything()),
    );
    await flush();

    fireEvent.keyDown(main, { key: "ArrowRight" });

    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
    const winnerRegion = await screen.findByRole("region", { name: "第1位の勝者一覧" });
    expect(winnerRegion).toHaveTextContent("葵");
    expect(winnerRegion.className).toContain("announce");
  });

  it.each([
    ["not_started", 0, 0, ["ArrowLeft"]],
    ["question", 0, 2, ["ArrowLeft"]],
    ["podium_preview", 0, 0, ["ArrowLeft"]],
    ["finished", 2, 2, ["ArrowRight", "Enter", " "]],
  ])(
    "ignores unavailable navigation keys at the %s boundary",
    async (state, index, count, keys) => {
      const api = installApi({
        projection: { state },
        admin: controls({ state, questionIndex: index, questionCount: count }),
      });
      render(<PresentationScreen presenterRequested />);
      const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
      await waitFor(() =>
        expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything()),
      );
      await flush();
      for (const key of keys) fireEvent.keyDown(main, { key });
      await flush();
      expect(api.actions).toHaveLength(0);
    },
  );

  it("does not advance from interactive descendants and starts on a slide click", async () => {
    const api = installApi({
      projection: { state: "not_started" },
      admin: controls(),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await screen.findByRole("button", { name: "プレゼンを開始" });
    const button = document.createElement("button");
    main.append(button);
    fireEvent.click(button);
    expect(api.actions).toHaveLength(0);
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "start" });
  });

  it("runs a valid previous action and ignores repeated slide actions while busy", async () => {
    let releaseAction!: () => void;
    let signalAction!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      signalAction = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const api = installApi({
      projection: { state: "answer", question },
      admin: controls({ state: "answer", questionIndex: 1 }),
      actionProjection: { state: "question", question },
      actionAdmin: controls({ state: "question", questionIndex: 1 }),
    });
    api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/presentation") return response({ state: "answer", question });
      if (path === "/api/admin/session") return response({ authenticated: true });
      if (path === "/api/admin/presentation" && init?.method === "POST") {
        const action = JSON.parse(String(init.body)) as Record<string, unknown>;
        api.actions.push(action);
        signalAction();
        await actionGate;
        return response({ ok: true });
      }
      if (path === "/api/admin/presentation")
        return response(controls({ state: "answer", questionIndex: 1 }));
      throw new Error(`Unexpected fetch: ${path}`);
    });
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    render(<PresentationScreen presenterRequested />);
    try {
      const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
      await screen.findByRole("heading", { name: question.question });
      await waitFor(() =>
        expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything()),
      );
      await waitFor(() =>
        expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function)),
      );
      fireEvent.keyDown(main, { key: "ArrowLeft" });
      await actionStarted;
      fireEvent.keyDown(main, { key: "ArrowLeft" });
      fireEvent.click(screen.getByTestId("presentation-canvas"));
      expect(api.actions).toHaveLength(1);
      expect(api.actions[0]).toMatchObject({ action: "previous" });
      releaseAction();
      await flush();
    } finally {
      windowAddSpy.mockRestore();
    }
  });

  it("does not publish results when already visible or while a publish is in flight", async () => {
    let releasePublish!: () => void;
    let signalPublish!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      signalPublish = resolve;
    });
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const api = installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished", participantResultsVisible: true }),
    });
    const publishedView = render(<PresentationScreen presenterRequested />);
    expect(await screen.findByText("参加者結果は公開済みです")).toBeInTheDocument();
    expect(
      api.fetchMock.mock.calls.some(([path]) => String(path) === "/api/admin/participant-results"),
    ).toBe(false);
    publishedView.unmount();
    // Re-render with a fresh session whose results are private, then hold the POST open.
    const privateApi = installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished", participantResultsVisible: false }),
    });
    privateApi.fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/presentation") return response({ state: "finished" });
        if (path === "/api/admin/session") return response({ authenticated: true });
        if (path === "/api/admin/presentation" && init?.method !== "POST")
          return response(controls({ state: "finished", participantResultsVisible: false }));
        if (path === "/api/admin/participant-results") {
          signalPublish();
          await publishGate;
          return response({ ok: true });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      },
    );
    const view = render(<PresentationScreen presenterRequested />);
    const button = await screen.findByRole("button", { name: "参加者結果を公開" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await publishStarted;
    expect(
      privateApi.fetchMock.mock.calls.filter(
        ([path]) => String(path) === "/api/admin/participant-results",
      ),
    ).toHaveLength(1);
    releasePublish();
    await flush();
    view.unmount();
  });

  it("does not advance a finished presentation when the slide is clicked", async () => {
    const api = installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished" }),
    });
    render(<PresentationScreen presenterRequested />);
    await screen.findByRole("button", { name: "参加者結果を公開" });
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("reannounces a forward podium transition and expires the announcement", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const api = installApi({
      projection: { state: "podium_preview" },
      admin: controls({ state: "podium_preview" }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    api.setProjection({ state: "third", winners: [{ displayName: "葵", score: 9, rank: 3 }] });
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    const winnerRegion = screen.getByRole("region", { name: "第3位の勝者一覧" });
    expect(winnerRegion.className).toContain("announce");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(winnerRegion.className).not.toContain("announce");
  });

  it("restarts the announcement timeout when the next rank is announced", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    try {
      const api = installApi({
        projection: { state: "podium_preview" },
        actionProjection: { state: "third", winners: [{ displayName: "葵", score: 9, rank: 3 }] },
        admin: controls({ state: "podium_preview" }),
        actionAdmin: controls({ state: "third" }),
      });
      render(<PresentationScreen presenterRequested />);
      await flush();
      const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
      fireEvent.keyDown(main, { key: "ArrowRight" });
      await flush();
      const rankAnnouncementTimer =
        setTimeoutSpy.mock.results[
          setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1200)
        ]?.value;
      expect(rankAnnouncementTimer).toBeDefined();
      await act(async () => vi.advanceTimersByTimeAsync(700));

      api.setActionProjection({
        state: "second",
        winners: [{ displayName: "凛", score: 12, rank: 2 }],
      });
      api.setActionAdmin(controls({ state: "second" }));
      fireEvent.keyDown(main, { key: "ArrowRight" });
      await flush();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(rankAnnouncementTimer);
      const winnerRegion = screen.getByRole("region", { name: "第2位の勝者一覧" });
      expect(winnerRegion.className).toContain("announce");
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(winnerRegion.className).toContain("announce");
      await act(async () => vi.advanceTimersByTimeAsync(700));
      expect(winnerRegion.className).not.toContain("announce");
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("acquires a wake lock when visible, retries on visibility, and releases it on unmount", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const lock = {
      released: false,
      release: vi.fn(async () => {}),
      addEventListener: vi.fn(),
    };
    const request = vi.fn(async () => lock);
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen />);
      await flush();
      expect(request).toHaveBeenCalledWith("screen");
      expect(lock.addEventListener).toHaveBeenCalledWith("release", expect.any(Function), {
        once: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(request).toHaveBeenCalledTimes(1);
      view.unmount();
      view = undefined;
      expect(lock.release).toHaveBeenCalledOnce();
    } finally {
      view?.unmount();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("contains a rejected wake-lock release during unmount cleanup", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const lock = {
      released: false,
      release: vi.fn().mockRejectedValue(new Error("wake lock release failed")),
      addEventListener: vi.fn(),
    };
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn(async () => lock) },
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen />);
      await flush();
      view.unmount();
      view = undefined;
      await flush();
      expect(lock.release).toHaveBeenCalledOnce();
    } finally {
      view?.unmount();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("does not request a wake lock while the document is hidden", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const request = vi.fn(async () => ({
      released: false,
      release: vi.fn(async () => {}),
      addEventListener: vi.fn(),
    }));
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen />);
      await flush();
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(request).not.toHaveBeenCalled();
    } finally {
      view?.unmount();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("reacquires the wake lock after its release event and a visible notification", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let onRelease: (() => void) | undefined;
    const lock = {
      released: false,
      release: vi.fn(async () => {}),
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        onRelease = listener;
      }),
    };
    const request = vi.fn(async () => lock);
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen />);
      await flush();
      expect(request).toHaveBeenCalledTimes(1);
      act(() => onRelease?.());
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(request).toHaveBeenCalledTimes(2);
      view.unmount();
      view = undefined;
    } finally {
      view?.unmount();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("ignores a stale wake-lock release event and skips an already released lock on cleanup", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const releaseListeners: (() => void)[] = [];
    const firstLock = {
      released: false,
      release: vi.fn(async () => {}),
      addEventListener: vi.fn((_type: string, listener: () => void) =>
        releaseListeners.push(listener),
      ),
    };
    const secondLock = {
      released: false,
      release: vi.fn(async () => {}),
      addEventListener: vi.fn((_type: string, listener: () => void) =>
        releaseListeners.push(listener),
      ),
    };
    const request = vi.fn().mockResolvedValueOnce(firstLock).mockResolvedValueOnce(secondLock);
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen />);
      await flush();
      expect(releaseListeners).toHaveLength(1);
      act(() => releaseListeners[0]?.());
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(releaseListeners).toHaveLength(2);
      act(() => releaseListeners[0]?.());
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(request).toHaveBeenCalledTimes(2);
      secondLock.released = true;
      view.unmount();
      view = undefined;
      expect(secondLock.release).not.toHaveBeenCalled();
    } finally {
      view?.unmount();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("retries wake-lock acquisition after the browser rejects a request", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const lock = {
      released: false,
      release: vi.fn(async () => {}),
      addEventListener: vi.fn(),
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("wake lock denied"))
      .mockResolvedValue(lock);
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen />);
      await flush();
      expect(request).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(request).toHaveBeenCalledTimes(2);
      view.unmount();
      view = undefined;
    } finally {
      view?.unmount();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("releases a wake lock that resolves after the component unmounts", async () => {
    let resolveLock!: (value: {
      released: boolean;
      release: () => Promise<void>;
      addEventListener: () => void;
    }) => void;
    const pending = new Promise<{
      released: boolean;
      release: () => Promise<void>;
      addEventListener: () => void;
    }>((resolve) => (resolveLock = resolve));
    const lock = { released: false, release: vi.fn(async () => {}), addEventListener: vi.fn() };
    const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: vi.fn(() => pending) },
    });
    let view: ReturnType<typeof render> | undefined;
    let lockResolved = false;
    try {
      view = render(<PresentationScreen />);
      view.unmount();
      view = undefined;
      await act(async () => resolveLock(lock));
      lockResolved = true;
      expect(lock.release).toHaveBeenCalledOnce();
    } finally {
      view?.unmount();
      if (!lockResolved) resolveLock(lock);
      if (originalWakeLock) Object.defineProperty(navigator, "wakeLock", originalWakeLock);
      else Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("requests fullscreen from the presenter start action", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "requestFullscreen");
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      const api = installApi({
        admin: controls(),
        sessionResponse: async () => response({ authenticated: true }),
        adminResponse: async () => response(controls()),
      });
      view = render(<PresentationScreen presenterRequested />);
      await flush();
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
      fireEvent.click(screen.getByRole("button", { name: "プレゼンを開始" }));
      await flush();
      expect(requestFullscreen).toHaveBeenCalledOnce();
    } finally {
      view?.unmount();
      if (original) Object.defineProperty(HTMLElement.prototype, "requestFullscreen", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });

  it("skips fullscreen when already active and tolerates a rejected request", async () => {
    const originalMethod = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "requestFullscreen",
    );
    const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    const requestFullscreen = vi.fn().mockRejectedValue(new Error("fullscreen denied"));
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    const views: ReturnType<typeof render>[] = [];
    try {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.body,
      });
      const firstApi = installApi({ admin: controls() });
      const activeView = render(<PresentationScreen presenterRequested />);
      views.push(activeView);
      await flush();
      expect(firstApi.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
      expect(firstApi.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
      fireEvent.click(screen.getByRole("button", { name: "プレゼンを開始" }));
      await flush();
      expect(firstApi.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation",
        expect.objectContaining({ method: "POST" }),
      );
      expect(requestFullscreen).not.toHaveBeenCalled();
      activeView.unmount();
      views.pop();

      if (originalFullscreen)
        Object.defineProperty(document, "fullscreenElement", originalFullscreen);
      else Reflect.deleteProperty(document, "fullscreenElement");
      const secondApi = installApi({ admin: controls() });
      views.push(render(<PresentationScreen presenterRequested />));
      await flush();
      expect(secondApi.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation",
        expect.anything(),
      );
      fireEvent.click(screen.getByRole("button", { name: "プレゼンを開始" }));
      await flush();
      expect(requestFullscreen).toHaveBeenCalledOnce();
    } finally {
      for (const view of views) view.unmount();
      if (originalMethod)
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", originalMethod);
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
      if (originalFullscreen)
        Object.defineProperty(document, "fullscreenElement", originalFullscreen);
      else Reflect.deleteProperty(document, "fullscreenElement");
    }
  });

  it("keeps fullscreen reentry pending when a retry is rejected", async () => {
    const originalMethod = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "requestFullscreen",
    );
    const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    const requestFullscreen = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("reentry denied"))
      .mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    let view: ReturnType<typeof render> | undefined;
    try {
      const api = installApi({
        admin: controls(),
        actionAdmin: controls({ state: "question", questionIndex: 0 }),
        actionProjection: { state: "question", question },
      });
      view = render(<PresentationScreen presenterRequested />);
      await flush();
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
      fireEvent.click(screen.getByRole("button", { name: "プレゼンを開始" }));
      const projectionCallsBeforeStart = api.fetchMock.mock.calls.filter(
        ([path]) => String(path) === "/api/presentation",
      ).length;
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation").length,
      ).toBeGreaterThan(projectionCallsBeforeStart);
      await flushOperation();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(api.actions).toHaveLength(1);
      expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
      expect(
        api.fetchMock.mock.calls.filter(
          ([path, init]) => String(path) === "/api/admin/presentation" && init?.method !== "POST",
        ).length,
      ).toBeGreaterThanOrEqual(2);
      await flushOperation();
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
      await flush();
      expect(requestFullscreen).toHaveBeenCalledTimes(2);
      expect(api.actions).toHaveLength(2);
      expect(api.actions[1]).toMatchObject({ action: "advance" });
      expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
      await flush();
      expect(requestFullscreen).toHaveBeenCalledTimes(3);
      expect(api.actions).toHaveLength(3);
      expect(api.actions[2]).toMatchObject({ action: "advance" });
    } finally {
      view?.unmount();
      if (originalMethod)
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", originalMethod);
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
      if (originalFullscreen)
        Object.defineProperty(document, "fullscreenElement", originalFullscreen);
      else Reflect.deleteProperty(document, "fullscreenElement");
    }
  });

  it("does not request fullscreen reentry when another element is already fullscreen", async () => {
    const originalMethod = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "requestFullscreen",
    );
    const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    let fullscreenElement: Element | null = null;
    let fullscreenTarget: HTMLElement | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    const requestFullscreen = vi.fn(() => {
      fullscreenElement = fullscreenTarget;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      const api = installApi({
        admin: controls(),
        actionAdmin: controls({ state: "question", questionIndex: 0 }),
        actionProjection: { state: "question", question },
      });
      view = render(<PresentationScreen presenterRequested />);
      fullscreenTarget = screen.getByRole("main");
      await flush();
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
      fireEvent.click(screen.getByRole("button", { name: "プレゼンを開始" }));
      const projectionCallsBeforeStart = api.fetchMock.mock.calls.filter(
        ([path]) => String(path) === "/api/presentation",
      ).length;
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation").length,
      ).toBeGreaterThan(projectionCallsBeforeStart);
      await flushOperation();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(api.actions).toHaveLength(1);
      expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
      await flushOperation();
      fullscreenElement = document.body;
      document.dispatchEvent(new Event("fullscreenchange"));
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      fullscreenElement = document.body;
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
      await flush();
      expect(api.actions).toHaveLength(2);
      expect(api.actions[1]).toMatchObject({ action: "advance" });
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      view.unmount();
      view = undefined;
    } finally {
      view?.unmount();
      if (originalMethod)
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", originalMethod);
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
      if (originalFullscreen)
        Object.defineProperty(document, "fullscreenElement", originalFullscreen);
      else Reflect.deleteProperty(document, "fullscreenElement");
    }
  });

  it("requests fullscreen again after a previously active fullscreen session is lost", async () => {
    const originalMethod = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "requestFullscreen",
    );
    const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    let fullscreenElement: Element | null = null;
    let fullscreenTarget: HTMLElement | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    const requestFullscreen = vi.fn(() => {
      fullscreenElement = fullscreenTarget;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    let view: ReturnType<typeof render> | undefined;
    try {
      const api = installApi({
        admin: controls(),
        actionAdmin: controls({ state: "question", questionIndex: 0 }),
        actionProjection: { state: "question", question },
      });
      view = render(<PresentationScreen presenterRequested />);
      fullscreenTarget = screen.getByRole("main");
      await flush();
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
      const startButton = screen.getByRole("button", { name: "プレゼンを開始" });
      fireEvent.click(startButton);
      const projectionCallsBeforeStart = api.fetchMock.mock.calls.filter(
        ([path]) => String(path) === "/api/presentation",
      ).length;
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation").length,
      ).toBeGreaterThan(projectionCallsBeforeStart);
      await flushOperation();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
      await flushOperation();

      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
      await flush();
      expect(api.actions).toHaveLength(2);
      expect(api.actions[1]).toMatchObject({ action: "advance" });
      expect(requestFullscreen).toHaveBeenCalledTimes(2);
    } finally {
      view?.unmount();
      windowAddSpy.mockRestore();
      if (originalMethod)
        Object.defineProperty(HTMLElement.prototype, "requestFullscreen", originalMethod);
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
      if (originalFullscreen)
        Object.defineProperty(document, "fullscreenElement", originalFullscreen);
      else Reflect.deleteProperty(document, "fullscreenElement");
    }
  });

  it("cleans up presenter polling, projection polling, keyboard and fullscreen listeners", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const api = installApi({ admin: controls() });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen presenterRequested />);
      await flush();
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/presentation", expect.anything());
      expect(screen.getByRole("button", { name: "プレゼンを開始" })).toBeInTheDocument();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
      const adminIntervalIndex = setIntervalSpy.mock.calls.findIndex(([, delay]) => delay === 2500);
      const adminInterval = setIntervalSpy.mock.results[adminIntervalIndex]?.value;
      const projectionTimeoutIndex = setTimeoutSpy.mock.calls.findIndex(
        ([, delay]) => delay === 1400,
      );
      const projectionTimeout = setTimeoutSpy.mock.results[projectionTimeoutIndex]?.value;
      view.unmount();
      view = undefined;
      expect(removeSpy).toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
      expect(windowRemoveSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      expect(clearIntervalSpy).toHaveBeenCalledWith(adminInterval);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(projectionTimeout);
      expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    } finally {
      view?.unmount();
      addSpy.mockRestore();
      removeSpy.mockRestore();
      windowAddSpy.mockRestore();
      windowRemoveSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
