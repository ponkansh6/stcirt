import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationScreen from "@/app/presentation/presentation-screen";

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

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function setup(
  options: {
    projection?: Record<string, unknown>;
    admin?: Record<string, unknown>;
    actionAdmin?: Record<string, unknown>;
    authenticated?: boolean;
    actionStatus?: number;
    actionGate?: () => Promise<void>;
    projectionGetter?: () => Promise<Response>;
    deckGetter?: () => Promise<Response>;
    deckSlides?: DeckSlideFixture[];
  } = {},
) {
  let projection = options.projection ?? {
    state: "question",
    question: {
      id: 1,
      ordinal: 1,
      total: 5,
      question: "思い出の場所は？",
      choices: ["海", "山"],
    },
  };
  let admin = options.admin ?? {
    state: "question",
    questionIndex: 0,
    questionCount: 5,
    projectionHidden: false,
  };
  const slideProjection = (state: DeckProjectionFixture["state"]): DeckProjectionFixture =>
    state === "question" || state === "answer"
      ? ({ ...(projection as Record<string, unknown>), state } as DeckProjectionFixture)
      : state === "third" || state === "second" || state === "first"
        ? { state, winners: [] }
        : { state };
  const deckSlides: DeckSlideFixture[] = [
    ...Array.from({ length: Number(admin.questionCount ?? 0) }, (_, questionIndex) => [
      deckSlide("question", questionIndex, slideProjection("question")),
      deckSlide("answer", questionIndex, slideProjection("answer")),
    ]).flat(),
    deckSlide(
      "podium_preview",
      Number(admin.questionIndex ?? 0),
      slideProjection("podium_preview"),
    ),
    deckSlide("third", Number(admin.questionIndex ?? 0), slideProjection("third")),
    deckSlide("second", Number(admin.questionIndex ?? 0), slideProjection("second")),
    deckSlide("first", Number(admin.questionIndex ?? 0), slideProjection("first")),
    deckSlide("finished", Number(admin.questionIndex ?? 0), slideProjection("finished")),
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
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/presentation")
      return options.projectionGetter ? options.projectionGetter() : response(projection);
    if (path === "/api/admin/session")
      return response({ authenticated: options.authenticated ?? true });
    if (path === "/api/admin/presentation" && init?.method === "POST") {
      await options.actionGate?.();
      if (options.actionAdmin) admin = options.actionAdmin;
      return response({}, options.actionStatus ?? 200);
    }
    if (path === "/api/admin/presentation?view=controls") return response(admin);
    if (path === "/api/admin/presentation/deck")
      return options.deckGetter
        ? options.deckGetter()
        : response({
            questionCount: admin.questionCount,
            questionIndex: admin.questionIndex,
            slides: deckSlides,
          });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
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
  };
}

async function settled() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

describe("presentation projection and presenter progression", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "op-1") });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders read-only projection and never requests admin APIs for spectators", async () => {
    const api = setup({ authenticated: true });
    render(<PresentationScreen />);
    expect(await screen.findByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await settled();
    expect(api.calls.some(({ path }) => path.startsWith("/api/admin/presentation"))).toBe(false);
    expect(
      api.calls.some(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toBe(false);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("removes start and publication controls from the presenter projection", async () => {
    const api = setup({
      projection: { state: "not_started" },
      admin: { state: "not_started", questionIndex: 0, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    expect(await screen.findByText("発表が始まるまで、少々お待ちください")).toBeInTheDocument();
    await settled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("main"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("maps keyboard and horizontal pointer gestures to one previous/advance action", async () => {
    const api = setup({ admin: { state: "question", questionIndex: 1, questionCount: 5 } });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    fireEvent.keyDown(main, { key: "ArrowLeft" });
    await settled();
    fireEvent.keyDown(main, { key: " " });
    await settled();
    fireEvent.keyDown(main, { key: "Enter" });
    await settled();
    fireEvent.pointerDown(main, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 240,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 1, isPrimary: true, clientX: 100, clientY: 105 });
    fireEvent.click(main);
    await settled();
    const actions = api.calls
      .filter(({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST")
      .map(({ init }) => JSON.parse(String(init?.body)).action);
    expect(actions).toEqual(["advance", "previous", "advance", "advance", "advance"]);
  });

  it("ignores modified/repeated keys and interactive targets", async () => {
    const api = setup();
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    fireEvent.keyDown(main, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(main, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(main, { key: "ArrowRight", shiftKey: true });
    const button = document.createElement("button");
    main.append(button);
    fireEvent.keyDown(button, { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("ignores vertical, canceled, and secondary pointer gestures", async () => {
    const api = setup();
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    fireEvent.pointerDown(main, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 1, isPrimary: true, clientX: 205, clientY: 220 });
    fireEvent.pointerDown(main, {
      pointerId: 2,
      isPrimary: false,
      button: 0,
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 2, isPrimary: false, clientX: 80, clientY: 100 });
    fireEvent.pointerDown(main, {
      pointerId: 3,
      isPrimary: true,
      button: 0,
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerCancel(main, { pointerId: 3 });
    fireEvent.pointerUp(main, { pointerId: 3, isPrimary: true, clientX: 80, clientY: 100 });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("single-flights a key mutation while a second intentional input arrives", async () => {
    let release!: () => void;
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = setup({
      actionGate: () => {
        started();
        return actionGate;
      },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await actionStarted;
    fireEvent.keyDown(main, { key: "ArrowRight" });
    fireEvent.pointerDown(main, {
      pointerId: 8,
      isPrimary: true,
      button: 0,
      clientX: 220,
      clientY: 120,
    });
    fireEvent.pointerUp(main, { pointerId: 8, isPrimary: true, clientX: 80, clientY: 122 });
    fireEvent.click(main);
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settled();
  });

  it("loads the presenter deck once and refreshes only controls while a mutation is in flight", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = setup({
      actionGate: () => {
        started();
        return actionGate;
      },
    });
    render(<PresentationScreen presenterRequested />);
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await actionStarted;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(1);
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(0);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settled();
    expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(1);
    expect(
      api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls").length,
    ).toBeGreaterThanOrEqual(2);
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(0);
  });

  async function expectDeckLoadFailureToBeInert(deckGetter: () => Promise<Response>) {
    const api = setup({ deckGetter });
    render(<PresentationScreen presenterRequested />);

    expect(await screen.findByText("スライドを読み込めませんでした")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    fireEvent.click(screen.getByTestId("presentation-canvas"));
    await settled();

    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  }

  it("fails closed when the presenter deck request is unavailable", async () => {
    await expectDeckLoadFailureToBeInert(async () => response({ error: "offline" }, 503));
  });

  it("fails closed when the presenter deck response is malformed", async () => {
    await expectDeckLoadFailureToBeInert(async () => response({ slides: null }));
  });

  it("fails closed when the presenter deck response contains invalid JSON", async () => {
    await expectDeckLoadFailureToBeInert(async () => new Response("not-json"));
  });

  it("shows loading UI while the presenter deck request is pending", async () => {
    let resolveDeck!: (value: Response) => void;
    const deckPending = new Promise<Response>((resolve) => {
      resolveDeck = resolve;
    });
    const api = setup({ deckGetter: () => deckPending });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      expect(await screen.findByText("スライドを読み込んでいます")).toBeInTheDocument();
      expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(
        1,
      );
    } finally {
      await act(async () => {
        resolveDeck(response({ slides: [] }));
        await deckPending;
      });
      await settled();
      view.unmount();
    }
  });

  it("keeps the projection hidden when presenter controls hide it", async () => {
    setup({
      admin: {
        state: "question",
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: true,
      },
    });
    render(<PresentationScreen presenterRequested />);

    expect(await screen.findByText("ただいま休憩中です")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "思い出の場所は？" })).not.toBeInTheDocument();
  });

  it("uses control state when the loaded deck has no matching slide", async () => {
    const api = setup({ deckGetter: async () => response({ slides: [] }) });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await waitFor(() =>
      expect(
        api.calls.filter(
          ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
        ),
      ).toHaveLength(1),
    );
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("announces a rank slide without a winners array", async () => {
    const api = setup({
      projection: { state: "podium_preview" },
      admin: { state: "podium_preview", questionIndex: 5, questionCount: 5 },
      actionAdmin: { state: "third", questionIndex: 5, questionCount: 5 },
      deckGetter: async () =>
        response({
          slides: [
            {
              state: "podium_preview",
              questionIndex: 5,
              projection: { state: "podium_preview" },
            },
            {
              state: "third",
              questionIndex: 5,
              projection: { state: "third" },
            },
          ],
        }),
    });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    const region = await screen.findByRole("region", { name: "第3位の勝者一覧" });
    await settled();

    expect(screen.getByText("該当する受賞者はいません")).toBeInTheDocument();
    expect(region).toHaveClass(/announce/);
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("shares a pending deck request across overlapping presenter refreshes", async () => {
    vi.useFakeTimers();
    let resolveDeck!: (value: Response) => void;
    const deckPending = new Promise<Response>((resolve) => {
      resolveDeck = resolve;
    });
    const api = setup({ deckGetter: () => deckPending });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      await settled();
      expect(screen.getByText("スライドを読み込んでいます")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await settled();
      expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(
        1,
      );
      expect(
        api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls"),
      ).toHaveLength(2);

      await act(async () => {
        resolveDeck(response({ slides: [] }));
        await deckPending;
      });
      await settled();
      expect(screen.queryByText("スライドを読み込んでいます")).not.toBeInTheDocument();
      expect(screen.getByRole("main")).toBeInTheDocument();
    } finally {
      await act(async () => {
        resolveDeck(response({ slides: [] }));
        await deckPending;
      });
      await settled();
      view.unmount();
    }
  });

  it("reschedules spectator polling while a presenter mutation is in flight", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = setup({
      actionGate: () => {
        started();
        return actionGate;
      },
    });
    const view = render(<PresentationScreen presenterRequested />);
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await actionStarted;

    view.rerender(<PresentationScreen />);
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(0);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(1);
  });

  it("refreshes controls after a 409 without refetching slides or retrying the operation", async () => {
    const api = setup({ actionStatus: 409 });
    render(<PresentationScreen presenterRequested />);
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await waitFor(() =>
      expect(
        api.calls.filter(
          ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
        ),
      ).toHaveLength(1),
    );
    await settled();
    expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(1);
    expect(
      api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls").length,
    ).toBeGreaterThanOrEqual(2);
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(0);
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("retries a failed public projection poll and keeps the viewport shell", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const api = setup({
      projectionGetter: async () => {
        reads += 1;
        return reads === 1 ? response({ error: "offline" }, 503) : response({ state: "finished" });
      },
    });
    render(<PresentationScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("main")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: /ご参加/ })).toBeInTheDocument();
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(2);
    expect(screen.getByRole("main")).toHaveAttribute("aria-label", "プレゼンテーションスライド");
  });

  it.each([
    ["question", 0, 2, "ArrowLeft"],
    ["podium_preview", 0, 0, "ArrowLeft"],
    ["finished", 2, 2, "ArrowRight"],
    ["not_started", 0, 5, "Enter"],
  ])("keeps the %s boundary inert", async (state, questionIndex, questionCount, key) => {
    const api = setup({ projection: { state }, admin: { state, questionIndex, questionCount } });
    render(<PresentationScreen presenterRequested />);
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("requests fullscreen before a stage mutation and tolerates rejection", async () => {
    const api = setup();
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main");
    await settled();
    const fullscreenOrder: string[] = [];
    main.requestFullscreen = vi.fn(() => {
      fullscreenOrder.push("fullscreen");
      return Promise.reject(new Error("denied"));
    });
    const originalFetch = api.fetchMock.getMockImplementation();
    api.fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/admin/presentation" && init?.method === "POST")
        fullscreenOrder.push("mutation");
      return originalFetch!(input, init);
    });
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    expect(fullscreenOrder.slice(0, 2)).toEqual(["fullscreen", "mutation"]);
    expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
  });

  it("removes presenter progression immediately after a protected API returns 401", async () => {
    const api = setup({ actionStatus: 401 });
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main");
    await settled();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await waitFor(() =>
      expect(
        api.calls.some(
          ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
        ),
      ).toBe(true),
    );
    await settled();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("renders fifth-question model answer without participant response content", async () => {
    setup({
      projection: {
        state: "answer",
        question: {
          id: 5,
          ordinal: 5,
          total: 5,
          question: "最後の質問",
          choices: [],
          answerType: "freeText",
          expectedAnswer: "家族で旅行",
          responses: undefined,
        },
      },
    });
    render(<PresentationScreen />);
    expect(await screen.findByText("家族で旅行")).toBeInTheDocument();
    expect(screen.queryByText(/回答|類似度|得点/)).not.toBeInTheDocument();
  });

  it("renders rank, points, then name and plays entrance motion only for forward operations", async () => {
    const api = setup({
      projection: { state: "podium_preview" },
      admin: { state: "podium_preview", questionIndex: 5, questionCount: 5 },
      actionAdmin: { state: "third", questionIndex: 5, questionCount: 5 },
    });
    api.setDeckSlide("third", 5, {
      state: "third",
      winners: [{ displayName: "葵", score: 12.5, rank: 3 }],
    });
    render(<PresentationScreen presenterRequested />);
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    expect(await screen.findByText("3位")).toBeInTheDocument();
    expect(screen.getByText("12.50 ポイント")).toBeInTheDocument();
    expect(screen.getByText("葵", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "第3位の勝者一覧" })).toHaveClass(/announce/);
  });

  it("keeps initial and previous-stage rank renders static", async () => {
    setup({
      projection: { state: "third", winners: [{ displayName: "葵", score: 12.5, rank: 3 }] },
      admin: { state: "third", questionIndex: 5, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const region = await screen.findByRole("region", { name: "第3位の勝者一覧" });
    expect(region).not.toHaveClass(/announce/);
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowLeft" });
    await settled();
    expect(region).not.toHaveClass(/announce/);
  });

  it("does not add rank motion classes under reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })),
    );
    const api = setup({
      projection: { state: "podium_preview" },
      admin: { state: "podium_preview", questionIndex: 5, questionCount: 5 },
    });
    api.setDeckSlide("third", 5, {
      state: "third",
      winners: [{ displayName: "葵", score: 12.5, rank: 3 }],
    });
    render(<PresentationScreen presenterRequested />);
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    const region = await screen.findByRole("region", { name: "第3位の勝者一覧" });
    await settled();
    expect(region).not.toHaveClass(/announce/);
  });
});
