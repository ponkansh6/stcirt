import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationScreen from "@/app/presentation/presentation-screen";
import { installPresentationFitLayout } from "./presentation-fit-test-helpers";

type Projection = Record<string, unknown>;
type WinnerFixture = { displayName: string; score: number; rank: number };
type DeckProjectionFixture =
  | { state: "question" | "answer"; question?: unknown }
  | { state: "third" | "second" | "first"; winners: WinnerFixture[] }
  | {
      state: "standby" | "not_started" | "podium_preview" | "finished";
      winners?: WinnerFixture[];
    };
type DeckSlideFixture = {
  state: DeckProjectionFixture["state"];
  questionIndex: number;
  projection: DeckProjectionFixture;
};

function deckSlide(
  state: DeckProjectionFixture["state"],
  questionIndex: number,
  projection: DeckProjectionFixture,
): DeckSlideFixture {
  return { state, questionIndex, projection };
}

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
    deckSlides?: DeckSlideFixture[];
  } = {},
) {
  let projection = options.projection ?? { state: "not_started" };
  let admin = options.admin ?? controls();
  const deckSlides: DeckSlideFixture[] = [
    ...Array.from({ length: Number(admin.questionCount ?? 0) }, (_, questionIndex) => [
      deckSlide("question", questionIndex, { state: "question", question }),
      deckSlide("answer", questionIndex, { state: "answer", question }),
    ]).flat(),
    deckSlide("podium_preview", Number(admin.questionIndex ?? 0), { state: "podium_preview" }),
    deckSlide("third", Number(admin.questionIndex ?? 0), { state: "third", winners: [] }),
    deckSlide("second", Number(admin.questionIndex ?? 0), { state: "second", winners: [] }),
    deckSlide("first", Number(admin.questionIndex ?? 0), { state: "first", winners: [] }),
    deckSlide("finished", Number(admin.questionIndex ?? 0), { state: "finished" }),
  ];
  const slideIndex = deckSlides.findIndex(
    (slide) => slide.state === admin.state && slide.questionIndex === admin.questionIndex,
  );
  if (slideIndex >= 0)
    deckSlides[slideIndex] = deckSlide(
      deckSlides[slideIndex]!.state,
      deckSlides[slideIndex]!.questionIndex,
      projection as unknown as DeckProjectionFixture,
    );
  for (const slide of options.deckSlides ?? []) {
    const existing = deckSlides.findIndex(
      (candidate) =>
        candidate.state === slide.state && candidate.questionIndex === slide.questionIndex,
    );
    if (existing >= 0) deckSlides[existing] = slide;
    else deckSlides.push(slide);
  }
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
    if (path === "/api/admin/presentation?view=controls")
      return options.adminResponse ? options.adminResponse() : response(admin);
    if (path === "/api/admin/presentation/deck")
      return response({
        questionCount: admin.questionCount,
        questionIndex: admin.questionIndex,
        slides: deckSlides,
      });
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
    setDeckSlide(
      state: DeckProjectionFixture["state"],
      questionIndex: number,
      value: DeckProjectionFixture,
    ) {
      const slide = deckSlide(state, questionIndex, value);
      const existing = deckSlides.findIndex(
        (candidate) => candidate.state === state && candidate.questionIndex === questionIndex,
      );
      if (existing >= 0) deckSlides[existing] = slide;
      else deckSlides.push(slide);
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

describe("PresentationScreen", () => {
  let fitLayout: ReturnType<typeof installPresentationFitLayout>;

  beforeEach(() => {
    fitLayout = installPresentationFitLayout();
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

  it("fits natural content before paint and expands again when its natural height shrinks", async () => {
    installApi({
      projection: { state: "question", question },
      admin: controls(),
    });
    fitLayout.setViewport(0, 0);
    fitLayout.setNaturalSize(800, 900);
    let animationFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    render(<PresentationScreen />);
    const layer = screen.getByTestId("presentation-fit-layer");
    const naturalLayer = screen.getByTestId("presentation-natural-layer");
    expect(naturalLayer.dataset.fitReady).toBe("false");
    expect(naturalLayer.style.visibility).toBe("hidden");

    const resizeTo = (width: number, height: number, naturalHeight: number) => {
      fitLayout.setViewport(width, height);
      fitLayout.setNaturalSize(800, naturalHeight);
      act(() => {
        fitLayout.notifyResize();
        animationFrame?.(16);
      });
    };

    resizeTo(800, 450, 900);
    expect(naturalLayer.dataset.fitReady).toBe("true");
    expect(naturalLayer.style.visibility).toBe("visible");
    expect(layer.style.getPropertyValue("--presentation-fit-scale")).toBe("0.5");
    expect(layer.style.left).toBe("200px");
    expect(layer.style.top).toBe("0px");

    resizeTo(800, 450, 200);

    expect(layer.style.getPropertyValue("--presentation-fit-scale")).toBe("1");
    expect(layer.style.top).toBe("125px");
  });

  it("coalesces image and resize invalidations and cancels a pending animation frame", () => {
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionCount: 2 }),
    });
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return 26 + frameCallbacks.length;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const view = render(<PresentationScreen />);
    const layer = screen.getByTestId("presentation-natural-layer");
    const image = document.createElement("img");
    layer.append(image);

    act(() => fireEvent.load(layer));
    expect(requestFrame).not.toHaveBeenCalled();

    fitLayout.setViewport(800, 450);
    act(() => fitLayout.notifyResize({ includeContentBox: false }));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    act(() => frameCallbacks[0]?.(16));
    const fitLayer = screen.getByTestId("presentation-fit-layer");
    expect(fitLayer.style.getPropertyValue("--presentation-fit-scale")).toBe("0.625");
    expect(fitLayer.style.left).toBe("0px");
    expect(fitLayer.style.top).toBe("100px");

    act(() => fireEvent.load(image));
    expect(requestFrame).toHaveBeenCalledTimes(2);

    act(() => {
      window.dispatchEvent(new Event("resize"));
      fitLayout.notifyResize();
    });

    expect(requestFrame).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(28);
  });

  it("uses the timeout fit fallback when ResizeObserver and animation frames are unavailable", () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", undefined as unknown as typeof ResizeObserver);
    vi.stubGlobal("requestAnimationFrame", undefined as unknown as typeof requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", undefined as unknown as typeof cancelAnimationFrame);
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionCount: 2 }),
    });

    const view = render(<PresentationScreen />);
    const layer = screen.getByTestId("presentation-fit-layer");
    fitLayout.setViewport(600, 300);
    const clearTimeout = vi.spyOn(window, "clearTimeout");

    act(() => {
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(0);
    });
    expect(layer.style.getPropertyValue("--presentation-fit-scale")).toBe("0.46875");

    act(() => window.dispatchEvent(new Event("resize")));
    view.unmount();
    expect(clearTimeout).toHaveBeenCalled();
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

  it("renders a question and its ordered choices", async () => {
    installApi({ projection: { state: "question", question } });
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByText(/QUESTION/).parentElement).toHaveTextContent("1 / 2");
    expect(screen.getByRole("list")).toHaveTextContent("A海B山");
  });

  it("renders the selected-answer review and explanation without a presentation mode", async () => {
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
    render(<PresentationScreen />);
    expect(await screen.findByText("家族旅行で訪れました。")).toBeInTheDocument();
    expect(screen.getAllByText("正解")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByText("山")).toBeInTheDocument();
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

  it("keeps presenter controls unavailable when the admin state request fails", async () => {
    const api = installApi({
      projection: { state: "question", question },
      adminResponse: async () => response({}, false, 503),
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    await flush();

    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("keeps presenter controls unavailable when admin state JSON is not an object", async () => {
    const api = installApi({
      projection: { state: "question", question },
      adminResponse: async () => response(null),
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    await flush();

    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("keeps presenter controls unavailable when the admin session JSON is malformed", async () => {
    const api = installApi({
      projection: { state: "question", question },
      sessionResponse: async () => malformedJsonResponse(),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();

    expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("keeps presenter controls unavailable when the admin controls JSON is malformed", async () => {
    const api = installApi({
      projection: { state: "question", question },
      adminResponse: async () => malformedJsonResponse(),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();

    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("ignores keyboard events from nodes outside the slide", async () => {
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "answer", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "question", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    const detachedTarget = document.createElement("div");
    fireEvent.keyDown(detachedTarget, { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("refreshes presenter controls from the interval callback", async () => {
    vi.useFakeTimers();
    let adminCalls = 0;
    const api = installApi({
      projection: { state: "question", question },
      adminResponse: async () => {
        adminCalls += 1;
        return response(controls({ state: "question", questionIndex: adminCalls === 1 ? 0 : 1 }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(adminCalls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(adminCalls).toBe(2);
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowLeft" });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "previous" });
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
  });

  it("does not refresh admin controls when a queued interval callback runs after unmount", async () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(window, "setInterval");
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
    });
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

  it("keeps current presenter controls when an older session refresh later fails", async () => {
    vi.useFakeTimers();
    let rejectFirstSession!: (error: Error) => void;
    let sessionCalls = 0;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      sessionResponse: () => {
        sessionCalls += 1;
        if (sessionCalls === 1)
          return new Promise<Response>((_resolve, reject) => {
            rejectFirstSession = reject;
          });
        return Promise.resolve(response({ authenticated: true }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(sessionCalls).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(sessionCalls).toBe(2);
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
    await act(async () => {
      rejectFirstSession(new Error("stale session failure"));
      await Promise.resolve();
    });
    await flush();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "advance" });
  });

  it("keeps admin access after an older unauthenticated session response", async () => {
    vi.useFakeTimers();
    let resolveOldSession!: (value: Response) => void;
    let sessionReads = 0;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      sessionResponse: () => {
        sessionReads += 1;
        if (sessionReads === 1)
          return new Promise<Response>((resolve) => {
            resolveOldSession = resolve;
          });
        return Promise.resolve(response({ authenticated: true }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(sessionReads).toBe(2);
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );

    await act(async () => {
      resolveOldSession(response({ authenticated: false }));
      await Promise.resolve();
    });
    await flush();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "advance" });
  });

  it("keeps newer admin controls after an older state response arrives", async () => {
    vi.useFakeTimers();
    let resolveOldState!: (value: Response) => void;
    let adminReads = 0;
    const api = installApi({
      projection: { state: "question", question },
      adminResponse: () => {
        adminReads += 1;
        if (adminReads === 1)
          return new Promise<Response>((resolve) => {
            resolveOldState = resolve;
          });
        return Promise.resolve(response(controls({ state: "question", questionIndex: 1 })));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(adminReads).toBe(2);

    await act(async () => {
      resolveOldState(response(controls({ state: "not_started" })));
      await Promise.resolve();
    });
    await flush();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "advance" });
  });

  it("drops presenter controls after an expired admin session", async () => {
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionError: 401,
    });
    render(<PresentationScreen presenterRequested />);
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
    );
    await flush();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await waitFor(() => expect(api.actions).toHaveLength(1));
    await flush();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(1);
  });

  it("keeps presenter actions unavailable when admin controls JSON is malformed", async () => {
    const api = installApi({
      projection: { state: "question", question },
      adminResponse: async () => malformedJsonResponse(),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });

    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
    );
    await flush();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await flush();

    expect(screen.getByRole("heading", { name: /ふたりの思い出を/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: question.question })).not.toBeInTheDocument();
    expect(api.actions).toHaveLength(0);
    expect(api.fetchMock.mock.calls.some(([path]) => String(path) === "/api/presentation")).toBe(
      false,
    );
  });

  it("does not enable presenter actions when session JSON is malformed", async () => {
    const api = installApi({
      projection: { state: "question", question },
      sessionResponse: async () => malformedJsonResponse(),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });

    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything()),
    );
    await flush();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await flush();

    expect(screen.getByRole("heading", { name: "ただいま休憩中です" })).toBeInTheDocument();
    expect(
      api.fetchMock.mock.calls.some(
        ([path]) => String(path) === "/api/admin/presentation?view=controls",
      ),
    ).toBe(false);
    expect(api.actions).toHaveLength(0);
  });

  it("uses keyboard navigation only for slide targets and ignores repeated or modified keys", async () => {
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "answer", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "question", questionIndex: 1 }),
    });
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    render(<PresentationScreen presenterRequested />);
    const slide = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    try {
      await waitFor(() =>
        expect(api.fetchMock).toHaveBeenCalledWith(
          "/api/admin/presentation?view=controls",
          expect.anything(),
        ),
      );
      await flush();
      expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      fireEvent.keyDown(slide, { key: "ArrowRight", repeat: true });
      fireEvent.keyDown(slide, { key: "ArrowRight", ctrlKey: true });
      fireEvent.keyDown(slide, { key: "ArrowRight", shiftKey: true });
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
      });
      expect(api.actions[0]).toMatchObject({ action: "advance" });
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
        participantResultsVisible: 1,
        participantResultsReady: "true",
      },
    });
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    try {
      await waitFor(() =>
        expect(api.fetchMock).toHaveBeenCalledWith(
          "/api/admin/presentation?view=controls",
          expect.anything(),
        ),
      );
      await flush();
      expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      fireEvent.keyDown(main, { key: "ArrowLeft" });
      await flush();
      expect(api.actions).toHaveLength(0);
    } finally {
      windowAddSpy.mockRestore();
    }
  });

  it("renders tied winners immediately when the podium advances", async () => {
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
      deckSlides: [{ state: "second", questionIndex: 0, projection: { state: "second", winners } }],
      admin: controls({ state: "third" }),
      actionAdmin: controls({ state: "second" }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    const initialWinnerRegion = await screen.findByRole("region", { name: "第3位の勝者一覧" });
    expect(initialWinnerRegion).toHaveTextContent("悠");
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
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
    expect(winnerRegion.className).not.toContain("announce");
  });

  it("renders the first-place winner immediately when advancing from second place", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const api = installApi({
      projection: {
        state: "second",
        winners: [{ displayName: "凛", score: 12, rank: 2 }],
      },
      deckSlides: [
        {
          state: "first",
          questionIndex: 0,
          projection: {
            state: "first",
            winners: [{ displayName: "葵", score: 15, rank: 1 }],
          },
        },
      ],
      admin: controls({ state: "second" }),
      actionAdmin: controls({ state: "first" }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    expect(await screen.findByRole("region", { name: "第2位の勝者一覧" })).toHaveTextContent("凛");
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
    );
    await flush();

    fireEvent.keyDown(main, { key: "ArrowRight" });

    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
    const winnerRegion = await screen.findByRole("region", { name: "第1位の勝者一覧" });
    expect(winnerRegion).toHaveTextContent("葵");
    expect(winnerRegion.className).not.toContain("announce");
  });

  it("does not advance from interactive descendants and advances on a slide click", async () => {
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "answer", question },
      admin: controls({ state: "question", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
    );
    const button = document.createElement("button");
    main.append(button);
    fireEvent.click(button);
    expect(api.actions).toHaveLength(0);
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
  });

  it("allows a click event from non-element slide text to advance", async () => {
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
    );
    const textTarget = document.createTextNode("slide text");
    screen.getByTestId("presentation-canvas").append(textTarget);

    fireEvent.click(textTarget);
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
    expect(main.contains(textTarget)).toBe(true);
  });

  it("allows ArrowRight from non-element slide text", async () => {
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
    );
    await flush();
    const textTarget = document.createTextNode("keyboard slide text");
    screen.getByTestId("presentation-canvas").append(textTarget);

    fireEvent.keyDown(textTarget, { key: "ArrowRight" });
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
    expect(main.contains(textTarget)).toBe(true);
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
      if (path === "/api/admin/presentation?view=controls")
        return response(controls({ state: "answer", questionIndex: 1 }));
      if (path === "/api/admin/presentation/deck")
        return response({
          questionCount: 2,
          questionIndex: 1,
          slides: [
            { state: "question", questionIndex: 1, projection: { state: "question", question } },
            { state: "answer", questionIndex: 1, projection: { state: "answer", question } },
          ],
        });
      throw new Error(`Unexpected fetch: ${path}`);
    });
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    render(<PresentationScreen presenterRequested />);
    try {
      const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
      await screen.findByRole("heading", { name: question.question });
      await waitFor(() =>
        expect(api.fetchMock).toHaveBeenCalledWith(
          "/api/admin/presentation?view=controls",
          expect.anything(),
        ),
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

  it("restarts the swipe click guard for each intentional swipe", async () => {
    vi.useFakeTimers();
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "answer", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "answer", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    const main = screen.getByRole("main");
    const swipeLeft = (pointerId: number) => {
      fireEvent.pointerDown(main, {
        pointerId,
        isPrimary: true,
        button: 0,
        clientX: 220,
        clientY: 100,
      });
      fireEvent.pointerUp(main, { pointerId, isPrimary: true, clientX: 100, clientY: 102 });
    };
    swipeLeft(14);
    await flush();
    expect(api.actions).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(300));
    swipeLeft(17);
    await flush();
    expect(api.actions).toHaveLength(2);
    expect(api.actions.map((action) => (action as { action: string }).action)).toEqual([
      "advance",
      "advance",
    ]);

    // The original 450ms deadline has passed, but the restarted deadline has not.
    await act(async () => vi.advanceTimersByTimeAsync(150));
    fireEvent.click(main);
    await flush();
    expect(api.actions).toHaveLength(2);
  });

  it("expires the swipe click guard when no synthetic click consumes it", async () => {
    vi.useFakeTimers();
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "answer", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "answer", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    const main = screen.getByRole("main");
    fireEvent.pointerDown(main, {
      pointerId: 18,
      isPrimary: true,
      button: 0,
      clientX: 220,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 18, isPrimary: true, clientX: 100, clientY: 102 });
    await flush();
    expect(api.actions).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(450));
    fireEvent.click(main);
    await flush();
    expect(api.actions).toHaveLength(2);
    expect(api.actions[1]).toMatchObject({ action: "advance" });
  });

  it("allows a right swipe to go previous after the first question", async () => {
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "question", questionIndex: 0 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    const main = screen.getByRole("main");
    fireEvent.pointerDown(main, {
      pointerId: 15,
      isPrimary: true,
      button: 0,
      clientX: 80,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 15, isPrimary: true, clientX: 160, clientY: 101 });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "previous" });
  });

  it("does not swipe previous from the first question", async () => {
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    const main = screen.getByRole("main");
    fireEvent.pointerDown(main, {
      pointerId: 16,
      isPrimary: true,
      button: 0,
      clientX: 80,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 16, isPrimary: true, clientX: 160, clientY: 101 });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("does not advance a finished presentation when the slide is clicked", async () => {
    const api = installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished" }),
    });
    render(<PresentationScreen presenterRequested />);
    await waitFor(() =>
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("does not swipe forward after the presentation is finished", async () => {
    const api = installApi({
      projection: { state: "finished" },
      admin: controls({ state: "finished" }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    const main = screen.getByRole("main");
    fireEvent.pointerDown(main, {
      pointerId: 19,
      isPrimary: true,
      button: 0,
      clientX: 220,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 19, isPrimary: true, clientX: 100, clientY: 101 });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("does not swipe previous from an empty podium preview", async () => {
    const api = installApi({
      projection: { state: "podium_preview" },
      admin: controls({ state: "podium_preview", questionCount: 0 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    const main = screen.getByRole("main");
    fireEvent.pointerDown(main, {
      pointerId: 20,
      isPrimary: true,
      button: 0,
      clientX: 80,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 20, isPrimary: true, clientX: 160, clientY: 101 });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it("renders podium content immediately without an announcement timer", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    installApi({
      projection: { state: "podium_preview" },
      admin: controls({ state: "podium_preview" }),
      deckSlides: [
        {
          state: "third",
          questionIndex: 0,
          projection: { state: "third", winners: [{ displayName: "葵", score: 9, rank: 3 }] },
        },
      ],
      actionAdmin: controls({ state: "third" }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    const winnerRegion = screen.getByRole("region", { name: "第3位の勝者一覧" });
    expect(winnerRegion).toHaveTextContent("9.00 ポイント");
    expect(winnerRegion.className).not.toContain("announce");
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1200)).toBe(false);
    setTimeoutSpy.mockRestore();
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
      const firstApi = installApi({
        projection: { state: "question", question },
        admin: controls({ state: "question", questionIndex: 1 }),
      });
      const activeView = render(<PresentationScreen presenterRequested />);
      views.push(activeView);
      await flush();
      expect(firstApi.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
      expect(firstApi.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      );
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
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
      const secondApi = installApi({
        projection: { state: "question", question },
        admin: controls({ state: "question", questionIndex: 1 }),
      });
      views.push(render(<PresentationScreen presenterRequested />));
      await flush();
      expect(secondApi.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      );
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
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

  it("cleans up presenter controls polling without starting public slide polling", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<PresentationScreen presenterRequested />);
      await flush();
      expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      );
      await flush();
      expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
      expect(
        api.fetchMock.mock.calls.filter(
          ([path]) => String(path) === "/api/admin/presentation/deck",
        ),
      ).toHaveLength(1);
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
      ).toHaveLength(0);
      const adminIntervalIndex = setIntervalSpy.mock.calls.findIndex(([, delay]) => delay === 2500);
      const adminInterval = setIntervalSpy.mock.results[adminIntervalIndex]?.value;
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1400)).toBe(false);
      view.unmount();
      view = undefined;
      expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      expect(addSpy).not.toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
      expect(windowRemoveSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      expect(clearIntervalSpy).toHaveBeenCalledWith(adminInterval);
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
    }
  });
});
