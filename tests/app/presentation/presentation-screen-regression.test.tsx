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
      state: "standby" | "not_started" | "opening" | "podium_preview" | "finished";
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
  const withRevision =
    body && typeof body === "object" && "slides" in body && !("snapshotRevision" in body)
      ? { ...body, snapshotRevision: 1 }
      : body;
  const result = new Response(JSON.stringify(withRevision), { status });
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
    version: 0,
    snapshotRevision: 1,
    questionIndex: 0,
    questionCount: 2,
    projectionHidden: false,
    ...overrides,
  };
}

function installApi(
  options: {
    projection?: Projection;
    actionProjection?: Projection;
    actionAdmin?: Record<string, unknown>;
    projectionResponse?: (signal?: AbortSignal) => Promise<Response>;
    actionResponse?: () => Promise<Response>;
    admin?: Record<string, unknown>;
    adminResponse?: (signal?: AbortSignal) => Promise<Response>;
    sessionResponse?: (signal?: AbortSignal) => Promise<Response>;
    authenticated?: boolean;
    actionError?: number;
    visibilityError?: number;
    visibilityErrorBody?: unknown;
    visibilityErrorResponse?: () => Promise<Response>;
    deckResponse?: () => Promise<Response>;
    deckSlides?: DeckSlideFixture[];
  } = {},
) {
  let projection = options.projection ?? { state: "not_started" };
  let admin = options.admin ?? controls();
  const deckSlides: DeckSlideFixture[] = [
    deckSlide("opening", 0, { state: "opening" }),
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
      return options.projectionResponse
        ? options.projectionResponse(init?.signal ?? undefined)
        : response(projection);
    if (path === "/api/admin/session")
      return options.sessionResponse
        ? options.sessionResponse(init?.signal ?? undefined)
        : response({ authenticated: options.authenticated ?? true });
    if (path === "/api/admin/presentation" && init?.method === "POST") {
      const action = JSON.parse(String(init.body)) as Record<string, unknown>;
      actions.push(action);
      if (options.actionResponse) return options.actionResponse();
      if (actionError) {
        const status = actionError;
        actionError = undefined;
        if (status === 401) options.authenticated = false;
        return response({}, false, status);
      }
      const currentSlideIndex = deckSlides.findIndex(
        (slide) => slide.state === admin.state && slide.questionIndex === admin.questionIndex,
      );
      const nextSlide =
        deckSlides[
          currentSlideIndex +
            (action.action === "advance" ? 1 : action.action === "previous" ? -1 : 0)
        ];
      const nextControls = actionAdmin
        ? controls({ ...admin, ...actionAdmin, version: Number(admin.version ?? 0) + 1 })
        : nextSlide
          ? controls({
              ...admin,
              state: nextSlide.state,
              questionIndex: nextSlide.questionIndex,
              version: Number(admin.version ?? 0) + 1,
            })
          : null;
      if (nextControls) {
        admin = nextControls;
        const targetSlide = deckSlides.find(
          (slide) => slide.state === admin.state && slide.questionIndex === admin.questionIndex,
        );
        if (actionProjection) {
          projection = actionProjection;
          const nextIndex = deckSlides.findIndex(
            (slide) => slide.state === admin.state && slide.questionIndex === admin.questionIndex,
          );
          if (nextIndex >= 0) {
            const current = deckSlides[nextIndex]!;
            deckSlides[nextIndex] = deckSlide(
              current.state,
              current.questionIndex,
              actionProjection as unknown as DeckProjectionFixture,
            );
          }
        } else if (targetSlide) {
          projection = targetSlide.projection;
        }
        return response(controls(admin));
      }
      return response({});
    }
    if (path === "/api/admin/presentation?view=controls")
      return options.adminResponse
        ? options.adminResponse(init?.signal ?? undefined)
        : response(admin);
    if (path === "/api/admin/presentation/deck")
      return options.deckResponse
        ? options.deckResponse()
        : response({
            snapshotRevision: admin.snapshotRevision,
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
    setAdmin(value: Record<string, unknown>) {
      admin = controls({ ...admin, ...value });
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
    for (let index = 0; index < 24; index += 1) await Promise.resolve();
  });
}

function observePresenterControls() {
  const addEventListener = vi.spyOn(window, "addEventListener");
  return async () => {
    await flush();
    expect(addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    addEventListener.mockRestore();
  };
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
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the initial wait screen and preserves it when projection polling fails", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(response(null, false, 503));
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/presentation", {
      cache: "no-store",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps public projection polling active while the document is hidden", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/presentation") return response({ state: "not_started" });
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PresentationScreen />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/presentation"),
    ).toHaveLength(2);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
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
    expect(await screen.findByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
    view.unmount();
    installApi({
      projectionResponse: async () => malformedJsonResponse(),
    });
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    await flush();
    expect(projectionCalls).toBe(2);
    expect(screen.getByText("ただいま休憩中です")).toBeInTheDocument();
  });

  it("keeps the displayed stage when a later public projection payload is invalid", async () => {
    vi.useFakeTimers();
    let projectionCalls = 0;
    installApi({
      projectionResponse: async () => {
        projectionCalls += 1;
        return projectionCalls === 1
          ? response({ state: "question", question })
          : response({ state: "question", question: null });
      },
    });
    render(<PresentationScreen />);
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(1400));
    await flush();

    expect(projectionCalls).toBe(2);
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "接続を確認しています。自動で再試行します",
    );
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

  it("aborts a timed out public projection poll and retains the last rendered slide", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let activeSignal: AbortSignal | undefined;
    const api = installApi({
      projection: { state: "question", question },
      projectionResponse: (signal) => {
        reads += 1;
        if (reads === 1) return Promise.resolve(response({ state: "question", question }));
        activeSignal = signal;
        return new Promise<Response>(() => {});
      },
    });
    const view = render(<PresentationScreen />);
    try {
      await flush();
      expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();

      await act(async () => vi.advanceTimersByTimeAsync(1400));
      await flush();
      expect(reads).toBe(2);
      expect(activeSignal?.aborted).toBe(false);

      await act(async () => vi.advanceTimersByTimeAsync(8000));
      expect(activeSignal?.aborted).toBe(true);
      expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
      ).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });

  it("aborts an in-flight public projection request when unmounted", async () => {
    let activeSignal: AbortSignal | undefined;
    installApi({
      projectionResponse: (signal) => {
        activeSignal = signal;
        return new Promise<Response>(() => {});
      },
    });
    const view = render(<PresentationScreen />);
    await flush();
    expect(activeSignal?.aborted).toBe(false);
    view.unmount();
    expect(activeSignal?.aborted).toBe(true);
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

  it("keeps the displayed stage when the presenter deck payload is invalid", async () => {
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question" }),
      deckResponse: async () =>
        response({
          snapshotRevision: 1,
          questionCount: 2,
          questionIndex: 0,
          slides: [{}],
        }),
    });
    const view = render(<PresentationScreen />);
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();

    view.rerender(<PresentationScreen presenterRequested />);
    await flush();

    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "スライドを読み込めませんでした" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("接続を確認しています。自動で再試行します").length).toBeGreaterThan(
      0,
    );
  });

  it("rejects a deck with a malformed winner projection", async () => {
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "third", questionIndex: 0 }),
      deckResponse: async () =>
        response({
          snapshotRevision: 1,
          questionCount: 2,
          questionIndex: 0,
          slides: [
            {
              state: "third",
              questionIndex: 0,
              projection: {
                state: "third",
                winners: [{ displayName: "不正な勝者", score: "10", rank: 3 }],
              },
            },
          ],
        }),
    });

    render(<PresentationScreen presenterRequested />);
    await flush();

    expect(
      screen.getByRole("heading", { name: "スライドを読み込めませんでした" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("不正な勝者")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
  });

  it.each([
    ["null", null],
    ["primitive", 7],
  ])("rejects a deck whose winner entry is %s", async (_description, winner) => {
    const api = installApi({
      projection: { state: "third", winners: [] },
      admin: controls({ state: "third", questionIndex: 0 }),
      deckResponse: async () =>
        response({
          snapshotRevision: 1,
          questionCount: 2,
          questionIndex: 0,
          slides: [
            {
              state: "third",
              questionIndex: 0,
              projection: { state: "third", winners: [winner] },
            },
          ],
        }),
    });

    render(<PresentationScreen presenterRequested />);
    await flush();

    expect(
      screen.getByRole("heading", { name: "スライドを読み込めませんでした" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "第3位の勝者一覧" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
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

  it("retries after a non-auth admin session check error", async () => {
    const api = installApi({
      projection: { state: "question", question },
      sessionResponse: async () => response({}, false, 503),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();

    expect(api.fetchMock).toHaveBeenCalledWith("/api/admin/session", expect.anything());
    expect(screen.getByRole("status")).toHaveTextContent("自動で再試行します");
    expect(api.fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
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

  it("checks presenter auth on entry and visibility return, polling controls without focus gating", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const api = installApi({
      projectionResponse: async () => response({ state: "standby" }),
      admin: controls({ state: "question", questionIndex: 0 }),
    });
    const count = (path: string) =>
      api.fetchMock.mock.calls.filter(([input]) => String(input) === path).length;
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(count("/api/admin/session")).toBe(1);
    expect(count("/api/admin/presentation?view=controls")).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(count("/api/admin/session")).toBe(1);
    expect(count("/api/admin/presentation?view=controls")).toBe(2);
    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(count("/api/admin/session")).toBe(1);
    expect(count("/api/admin/presentation?view=controls")).toBe(3);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(count("/api/admin/presentation?view=controls")).toBe(3);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(count("/api/admin/session")).toBe(2);
    expect(count("/api/admin/presentation?view=controls")).toBe(4);
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("keeps one presenter poll timer when visibility return and poll completion coincide", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let finishPoll: ((value: Response) => void) | undefined;
    let adminReads = 0;
    let sessionReads = 0;
    let nextTimerId = 0;
    const pendingPollTimers = new Set<number>();
    const pollHandlers = new Map<number, () => void>();
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number) => {
      if (delay === 2500 && typeof handler === "function") {
        const id = 10_000 + ++nextTimerId;
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
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      sessionResponse: async () => {
        sessionReads += 1;
        return response({ authenticated: true });
      },
      adminResponse: async () => {
        adminReads += 1;
        if (adminReads === 2)
          return new Promise<Response>((resolve) => {
            finishPoll = resolve;
          });
        return response(controls({ state: "question", questionIndex: 0 }));
      },
    });

    try {
      const view = render(<PresentationScreen presenterRequested />);
      await flush();
      expect(adminReads).toBe(1);
      expect(sessionReads).toBe(1);
      expect(pendingPollTimers.size).toBe(1);

      const [firstTimer] = pendingPollTimers;
      act(() => {
        const handler = pollHandlers.get(firstTimer);
        pendingPollTimers.delete(firstTimer);
        pollHandlers.delete(firstTimer);
        handler?.();
      });
      await flush();
      expect(adminReads).toBe(2);

      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(sessionReads).toBe(1);
      await act(async () => {
        finishPoll?.(response(controls({ state: "answer", questionIndex: 0 })));
        for (let index = 0; index < 24; index += 1) await Promise.resolve();
      });

      expect(sessionReads).toBe(2);
      expect(adminReads).toBe(3);
      expect(pendingPollTimers.size).toBe(1);
      view.unmount();
      expect(pendingPollTimers.size).toBe(0);
    } finally {
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("clears a pending presenter poll timer when visibility returns", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
    });

    try {
      render(<PresentationScreen presenterRequested />);
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(([input]) => String(input) === "/api/admin/session"),
      ).toHaveLength(1);
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 2500)).toBe(false);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        for (let index = 0; index < 24; index += 1) await Promise.resolve();
      });
      await flush();
      const pollTimer = setTimeoutSpy.mock.results.find(
        (_, index) => setTimeoutSpy.mock.calls[index]?.[1] === 2500,
      )?.value;
      expect(pollTimer).toBeDefined();

      act(() => document.dispatchEvent(new Event("visibilitychange")));

      expect(clearTimeoutSpy).toHaveBeenCalledWith(pollTimer);
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(
          ([input]) => String(input) === "/api/admin/presentation?view=controls",
        ),
      ).toHaveLength(3);
    } finally {
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("does not schedule the first presenter poll when the page becomes hidden during entry", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    let resolveSession!: (value: Response) => void;
    try {
      installApi({
        projection: { state: "question", question },
        sessionResponse: () =>
          new Promise<Response>((resolve) => {
            resolveSession = resolve;
          }),
      });
      render(<PresentationScreen presenterRequested />);
      await flush();
      expect(resolveSession).toBeDefined();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        resolveSession(response({ authenticated: true }));
        await Promise.resolve();
      });
      await flush();

      expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 2500)).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("retains the current presenter slide across transient poll errors and recovers", async () => {
    vi.useFakeTimers();
    let reads = 0;
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      adminResponse: async () => {
        reads += 1;
        if (reads === 2) return response({}, false, 503);
        return response(controls({ state: reads >= 3 ? "answer" : "question", questionIndex: 0 }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("自動で再試行します");

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(reads).toBe(3);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
  });

  it("aborts a timed out presenter poll and resumes with the next poll", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let timedOutSignal: AbortSignal | undefined;
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      adminResponse: async (signal) => {
        reads += 1;
        if (reads === 2) {
          timedOutSignal = signal;
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        }
        return response(controls({ state: reads > 2 ? "answer" : "question", questionIndex: 0 }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(reads).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    await flush();
    expect(timedOutSignal?.aborted).toBe(true);
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("自動で再試行します");

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(reads).toBe(3);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears the private presenter deck when controls polling returns 401", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      adminResponse: async () => {
        reads += 1;
        return reads === 1
          ? response(controls({ state: "question", questionIndex: 0 }))
          : response({}, false, 401);
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(screen.getByRole("heading", { name: "ただいま休憩中です" })).toBeInTheDocument();
    expect(api.actions).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/admin/session"),
    ).toHaveLength(2);
    expect(reads).toBe(3);
  });

  it("does not treat an invalid controls payload as auth loss and retries it", async () => {
    vi.useFakeTimers();
    let reads = 0;
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      adminResponse: async () => {
        reads += 1;
        if (reads === 2) return malformedJsonResponse();
        return response(controls({ state: reads > 2 ? "answer" : "question", questionIndex: 0 }));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("自動で再試行します");
    expect(screen.queryByRole("heading", { name: "ただいま休憩中です" })).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(reads).toBe(3);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hides an old slide after controls confirm a new snapshot revision", async () => {
    vi.useFakeTimers();
    let controlsReads = 0;
    let deckReads = 0;
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0, snapshotRevision: 1 }),
      adminResponse: async () => {
        controlsReads += 1;
        return response(
          controls({
            state: "question",
            questionIndex: 0,
            snapshotRevision: controlsReads > 1 ? 2 : 1,
          }),
        );
      },
      deckResponse: async () => {
        deckReads += 1;
        if (deckReads > 1) return response({}, false, 503);
        return response({
          snapshotRevision: 1,
          questionCount: 2,
          questionIndex: 0,
          slides: [deckSlide("question", 0, { state: "question", question })],
        });
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(screen.queryByRole("heading", { name: question.question })).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "スライドを読み込めませんでした" }),
    ).toBeInTheDocument();
  });

  it("does not refresh admin controls when a queued poll callback runs after unmount", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
    });
    try {
      const view = render(<PresentationScreen presenterRequested />);
      await flush();
      const adminTimeout = timeoutSpy.mock.calls.find(([, delay]) => delay === 2500);
      expect(adminTimeout).toBeDefined();
      if (!adminTimeout) throw new Error("expected presenter refresh timeout");
      view.unmount();
      const requestCount = api.fetchMock.mock.calls.filter(
        ([path]) => String(path) === "/api/admin/session",
      ).length;
      act(() => (adminTimeout[0] as () => void)());
      await flush();
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/admin/session"),
      ).toHaveLength(requestCount);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("aborts the active presenter poll when unmounted", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let activeSignal: AbortSignal | undefined;
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      adminResponse: async (signal) => {
        reads += 1;
        if (reads === 2) {
          activeSignal = signal;
          return new Promise<Response>(() => {});
        }
        return response(controls({ state: "question", questionIndex: 0 }));
      },
    });
    const view = render(<PresentationScreen presenterRequested />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(reads).toBe(2);
    expect(activeSignal?.aborted).toBe(false);
    view.unmount();
    expect(activeSignal?.aborted).toBe(true);
  });

  it("ignores a pending cursor-recovery deck after presenter mode is disabled", async () => {
    let deckReads = 0;
    let resolveRecoveryDeck!: (value: Response) => void;
    const api = installApi({
      projectionResponse: async () => response({ state: "standby" }),
      admin: controls({ state: "question", questionIndex: 0 }),
      deckResponse: () => {
        deckReads += 1;
        if (deckReads === 1) return Promise.resolve(response({ snapshotRevision: 1, slides: [] }));
        return new Promise<Response>((resolve) => {
          resolveRecoveryDeck = resolve;
        });
      },
    });
    const view = render(<PresentationScreen presenterRequested />);
    await flush();
    expect(deckReads).toBe(2);
    expect(resolveRecoveryDeck).toBeDefined();

    view.rerender(<PresentationScreen />);
    await flush();
    expect(screen.getByText("ただいま休憩中です")).toBeInTheDocument();

    await act(async () => {
      resolveRecoveryDeck(
        response({
          snapshotRevision: 1,
          slides: [deckSlide("question", 0, { state: "question", question })],
        }),
      );
      await Promise.resolve();
    });
    await flush();
    expect(screen.getByText("ただいま休憩中です")).toBeInTheDocument();
    expect(api.fetchMock).toHaveBeenCalledWith("/api/presentation", expect.anything());
  });

  it("does not start a second presenter refresh while the first session check is pending", async () => {
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

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await flush();
    expect(sessionCalls).toBe(1);
    expect(api.fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
    rejectFirstSession(new Error("temporary failure"));
    await flush();
    expect(sessionCalls).toBe(1);
  });

  it("does not overlap presenter refreshes while a session request is pending", async () => {
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

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await flush();
    expect(sessionReads).toBe(1);
    resolveOldSession(response({ authenticated: true }));
    await flush();
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
  });

  it("queues a visibility session check behind an in-flight presenter refresh", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    let resolveFirstSession!: (value: Response) => void;
    let sessionReads = 0;
    const api = installApi({
      projection: { state: "question", question },
      sessionResponse: () => {
        sessionReads += 1;
        if (sessionReads === 1)
          return new Promise<Response>((resolve) => {
            resolveFirstSession = resolve;
          });
        return Promise.resolve(response({ authenticated: true }));
      },
    });

    try {
      render(<PresentationScreen presenterRequested />);
      await flush();
      expect(sessionReads).toBe(1);

      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await flush();
      expect(sessionReads).toBe(1);

      resolveFirstSession(response({ authenticated: true }));
      await flush();
      expect(sessionReads).toBe(2);
      expect(api.fetchMock).toHaveBeenCalledWith(
        "/api/admin/presentation?view=controls",
        expect.anything(),
      );
    } finally {
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("polls again after an older state response settles", async () => {
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
    expect(adminReads).toBe(1);

    await act(async () => {
      resolveOldState(response(controls({ state: "not_started" })));
      await Promise.resolve();
    });
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();
    expect(adminReads).toBe(2);
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "advance" });
  });

  it("waits for the active poll before sending navigation and uses its latest controls", async () => {
    vi.useFakeTimers();
    let controlReads = 0;
    let resolveSecondControls!: (value: Response) => void;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      actionAdmin: controls({ state: "podium_preview", questionIndex: 0 }),
      adminResponse: () => {
        controlReads += 1;
        if (controlReads === 2)
          return new Promise<Response>((resolve) => {
            resolveSecondControls = resolve;
          });
        return Promise.resolve(
          response(
            controls({ state: controlReads > 2 ? "podium_preview" : "question", questionIndex: 0 }),
          ),
        );
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(controlReads).toBe(2);

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
    await act(async () => {
      resolveSecondControls(response(controls({ state: "answer", questionIndex: 0 })));
      await Promise.resolve();
    });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "advance", expectedSnapshotRevision: 1 });
    expect(screen.getByText("いよいよ、結果発表です")).toBeInTheDocument();
  });

  it("does not send a queued operation when the protected refresh resolves with 401", async () => {
    vi.useFakeTimers();
    let controlReads = 0;
    let resolveSecondControls!: (value: Response) => void;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      adminResponse: () => {
        controlReads += 1;
        if (controlReads === 2)
          return new Promise<Response>((resolve) => {
            resolveSecondControls = resolve;
          });
        return Promise.resolve(response(controls({ state: "question", questionIndex: 0 })));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(controlReads).toBe(2);

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
    await act(async () => {
      resolveSecondControls(response({}, false, 401));
      await Promise.resolve();
    });
    await flush();

    expect(api.actions).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "ただいま休憩中です" })).toBeInTheDocument();
  });

  it("drops presenter controls after an expired admin session", async () => {
    const waitForControls = observePresenterControls();
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
    await waitForControls();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance", expectedSnapshotRevision: 1 });
    await flush();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(1);
  });

  it("keeps presenter access after a mutation is rejected with Origin 403", async () => {
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionError: 403,
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await waitForControls();
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "ただいま休憩中です" })).not.toBeInTheDocument();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(2);
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

    expect(screen.getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: question.question })).not.toBeInTheDocument();
    expect(api.actions).toHaveLength(0);
    expect(api.fetchMock.mock.calls.some(([path]) => String(path) === "/api/presentation")).toBe(
      false,
    );
  });

  it("does not enable presenter actions when session JSON is malformed", async () => {
    vi.useFakeTimers();
    let sessionReads = 0;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      sessionResponse: async () => {
        sessionReads += 1;
        return sessionReads === 1 ? malformedJsonResponse() : response({ authenticated: true });
      },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    await flush();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await flush();

    expect(screen.getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("自動で再試行します");
    expect(
      api.fetchMock.mock.calls.some(
        ([path]) => String(path) === "/api/admin/presentation?view=controls",
      ),
    ).toBe(false);
    expect(api.actions).toHaveLength(0);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await flush();
    expect(sessionReads).toBe(1);
    expect(api.fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(sessionReads).toBe(2);
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation?view=controls",
      expect.anything(),
    );
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
    expect(screen.queryAllByRole("status")).toHaveLength(0);
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

  it("fails closed when admin controls contain malformed values", async () => {
    const api = installApi({
      projection: { state: "question", question },
      admin: {
        state: "question",
        version: 3,
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
      expect(windowAddSpy).not.toHaveBeenCalledWith("keydown", expect.any(Function));
      fireEvent.keyDown(main, { key: "ArrowRight" });
      await flush();
      expect(api.actions).toHaveLength(0);
      expect(screen.getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
    } finally {
      windowAddSpy.mockRestore();
    }
  });

  it("uses the controls returned by a successful action without an extra controls GET", async () => {
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await screen.findByRole("heading", { name: question.question });
    await flush();
    await waitForControls();
    const controlReadsBeforeAction = api.fetchMock.mock.calls.filter(
      ([path]) => String(path) === "/api/admin/presentation?view=controls",
    ).length;

    fireEvent.keyDown(main, { key: "ArrowRight" });

    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(await screen.findByText("THE STORY BEHIND IT")).toBeInTheDocument();
    expect(
      api.fetchMock.mock.calls.filter(
        ([path]) => String(path) === "/api/admin/presentation?view=controls",
      ),
    ).toHaveLength(controlReadsBeforeAction);
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/admin/presentation",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reloads the presenter deck when aggregation advances the snapshot revision", async () => {
    vi.useFakeTimers();
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0, snapshotRevision: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    const deckReads = () =>
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/admin/presentation/deck")
        .length;
    expect(deckReads()).toBe(1);
    api.setDeckSlide("question", 0, {
      state: "question",
      question: { ...question, question: "Updated aggregate question" },
    });
    api.setAdmin({ snapshotRevision: 2 });

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();

    expect(deckReads()).toBe(2);
    expect(screen.getByRole("heading", { name: "Updated aggregate question" })).toBeInTheDocument();
  });

  it("retries when the presenter deck revision is behind current controls", async () => {
    vi.useFakeTimers();
    let deckReads = 0;
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0, snapshotRevision: 2 }),
      deckResponse: async () => {
        deckReads += 1;
        return response({
          snapshotRevision: deckReads === 1 ? 1 : 2,
          questionCount: 2,
          questionIndex: 0,
          slides: [
            {
              state: "question",
              questionIndex: 0,
              projection: {
                state: "question",
                question: { ...question, question: "Recovered current question" },
              },
            },
          ],
        });
      },
    });

    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(deckReads).toBe(1);
    expect(
      screen.getByRole("heading", { name: "スライドを読み込めませんでした" }),
    ).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await flush();

    expect(deckReads).toBe(2);
    expect(screen.getByRole("heading", { name: "Recovered current question" })).toBeInTheDocument();
  });

  it("keeps the presenter fail-closed when the deck revision stays behind after retry", async () => {
    vi.useFakeTimers();
    let deckReads = 0;
    installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0, snapshotRevision: 2 }),
      deckResponse: async () => {
        deckReads += 1;
        return response({
          snapshotRevision: deckReads === 1 ? 2 : 1,
          questionCount: 2,
          questionIndex: deckReads === 1 ? 1 : 0,
          slides: [
            {
              state: "question",
              questionIndex: deckReads === 1 ? 1 : 0,
              projection: { state: "question", question },
            },
          ],
        });
      },
    });

    render(<PresentationScreen presenterRequested />);
    await flush();
    expect(deckReads).toBe(2);
    expect(
      screen.getByRole("heading", { name: "スライドを読み込めませんでした" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: question.question })).not.toBeInTheDocument();
    expect(screen.getAllByText("接続を確認しています。自動で再試行します").length).toBeGreaterThan(
      0,
    );
  });

  it("resynchronizes controls and deck when an action returns another snapshot revision", async () => {
    const waitForControls = observePresenterControls();
    let actionResponses = 0;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0, snapshotRevision: 1 }),
      actionResponse: async () => {
        actionResponses += 1;
        return response(
          controls({
            state: actionResponses === 1 ? "answer" : "question",
            questionIndex: 0,
            snapshotRevision: 2,
          }),
        );
      },
    });
    const main = render(<PresentationScreen presenterRequested />).getByRole("main");
    await screen.findByRole("heading", { name: question.question });
    await flush();
    await waitForControls();
    const deckReadsBeforeAction = api.fetchMock.mock.calls.filter(
      ([path]) => String(path) === "/api/admin/presentation/deck",
    ).length;
    api.setAdmin({ state: "answer", snapshotRevision: 2 });

    fireEvent.keyDown(main, { key: "ArrowRight" });

    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance", expectedSnapshotRevision: 1 });
    expect(
      api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/admin/presentation/deck"),
    ).toHaveLength(deckReadsBeforeAction + 1);
    expect(await screen.findByText("THE STORY BEHIND IT")).toBeInTheDocument();

    fireEvent.keyDown(main, { key: "ArrowLeft" });
    await waitFor(() => expect(api.actions).toHaveLength(2));
  });

  it("fails closed on an invalid successful action payload and resynchronizes controls", async () => {
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      actionResponse: async () => response({ ok: true }),
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await screen.findByRole("heading", { name: question.question });
    await flush();
    await waitForControls();
    const readsBeforeAction = api.fetchMock.mock.calls.filter(
      ([path]) => String(path) === "/api/admin/presentation?view=controls",
    ).length;

    fireEvent.keyDown(main, { key: "ArrowRight" });

    await waitFor(() =>
      expect(
        api.fetchMock.mock.calls.filter(
          ([path]) => String(path) === "/api/admin/presentation?view=controls",
        ),
      ).toHaveLength(readsBeforeAction + 1),
    );
    expect(api.actions).toHaveLength(1);
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
  });

  it("waits for an active controls poll before sending a successful action", async () => {
    vi.useFakeTimers();
    let resolveStaleControls!: (value: Response) => void;
    let controlReads = 0;
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      adminResponse: () => {
        controlReads += 1;
        if (controlReads === 2)
          return new Promise<Response>((resolve) => {
            resolveStaleControls = resolve;
          });
        return Promise.resolve(response(controls({ state: "question", questionIndex: 0 })));
      },
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(controlReads).toBe(2);

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await flush();
    expect(api.actions).toHaveLength(0);
    await act(async () => {
      resolveStaleControls(response(controls({ state: "question", questionIndex: 0 })));
      await Promise.resolve();
    });
    await flush();
    expect(api.actions).toHaveLength(1);

    expect(screen.getByText("THE STORY BEHIND IT")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();
  });

  it("resynchronizes after an action error and accepts a later action", async () => {
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
      actionError: 503,
    });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await screen.findByRole("heading", { name: question.question });
    await flush();
    await waitForControls();
    const readsBeforeAction = api.fetchMock.mock.calls.filter(
      ([path]) => String(path) === "/api/admin/presentation?view=controls",
    ).length;

    fireEvent.keyDown(main, { key: "ArrowRight" });
    await waitFor(() =>
      expect(
        api.fetchMock.mock.calls.filter(
          ([path]) => String(path) === "/api/admin/presentation?view=controls",
        ),
      ).toHaveLength(readsBeforeAction + 1),
    );
    expect(api.actions).toHaveLength(1);
    expect(screen.getByRole("heading", { name: question.question })).toBeInTheDocument();

    fireEvent.keyDown(main, { key: "ArrowRight" });
    await waitFor(() => expect(api.actions).toHaveLength(2));
  });

  it("renders tied winners immediately when the podium advances", async () => {
    const waitForControls = observePresenterControls();
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
    await waitForControls();
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
    const waitForControls = observePresenterControls();
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
    await waitForControls();

    fireEvent.keyDown(main, { key: "ArrowRight" });

    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
    const winnerRegion = await screen.findByRole("region", { name: "第1位の勝者一覧" });
    expect(winnerRegion).toHaveTextContent("葵");
    expect(winnerRegion.className).not.toContain("announce");
  });

  it("does not advance from interactive descendants and advances on a slide click", async () => {
    const waitForControls = observePresenterControls();
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
    await waitForControls();
    const button = document.createElement("button");
    main.append(button);
    fireEvent.click(button);
    expect(api.actions).toHaveLength(0);
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
  });

  it("allows a click event from non-element slide text to advance", async () => {
    const waitForControls = observePresenterControls();
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
    await waitForControls();
    const textTarget = document.createTextNode("slide text");
    screen.getByTestId("presentation-canvas").append(textTarget);

    fireEvent.click(textTarget);
    await waitFor(() => expect(api.actions).toHaveLength(1));
    expect(api.actions[0]).toMatchObject({ action: "advance" });
    expect(main.contains(textTarget)).toBe(true);
  });

  it("allows ArrowRight from non-element slide text", async () => {
    const waitForControls = observePresenterControls();
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
    await waitForControls();
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
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "answer", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "answer", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await waitForControls();
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
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "answer", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "answer", questionIndex: 1 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await waitForControls();
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
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      actionProjection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 1 }),
      actionAdmin: controls({ state: "question", questionIndex: 0 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await waitForControls();
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

  it("swipes previous from the first question to opening", async () => {
    const waitForControls = observePresenterControls();
    const api = installApi({
      projection: { state: "question", question },
      admin: controls({ state: "question", questionIndex: 0 }),
    });
    render(<PresentationScreen presenterRequested />);
    await flush();
    await waitForControls();
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
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "previous" });
  });

  it("does not advance a finished presentation when the slide is clicked", async () => {
    const waitForControls = observePresenterControls();
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
    await waitForControls();
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

  it("swipes previous from an empty podium preview to opening", async () => {
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
    expect(api.actions).toHaveLength(1);
    expect(api.actions[0]).toMatchObject({ action: "previous" });
    expect(await screen.findByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
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
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
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
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
      expect(
        api.fetchMock.mock.calls.filter(
          ([path]) => String(path) === "/api/admin/presentation/deck",
        ),
      ).toHaveLength(1);
      expect(
        api.fetchMock.mock.calls.filter(([path]) => String(path) === "/api/presentation"),
      ).toHaveLength(0);
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1400)).toBe(false);
      view.unmount();
      view = undefined;
      expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      expect(addSpy).not.toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
      expect(windowRemoveSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(windowAddSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    } finally {
      view?.unmount();
      addSpy.mockRestore();
      removeSpy.mockRestore();
      windowAddSpy.mockRestore();
      windowRemoveSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});
