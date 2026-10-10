import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationScreen from "@/app/presentation/presentation-screen";
import { installPresentationFitLayout } from "./presentation-fit-test-helpers";

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

function response(payload: unknown, status = 200) {
  const withRevision =
    payload &&
    typeof payload === "object" &&
    "slides" in payload &&
    !("snapshotRevision" in payload)
      ? { ...payload, snapshotRevision: 1 }
      : payload;
  return new Response(JSON.stringify(withRevision), { status });
}

function setup(
  options: {
    projection?: Record<string, unknown>;
    admin?: Record<string, unknown>;
    actionAdmin?: Record<string, unknown>;
    actionPayload?: unknown;
    actionInvalidJson?: boolean;
    commitBeforeActionError?: boolean;
    authenticated?: boolean;
    actionStatus?: number;
    actionGate?: () => Promise<void>;
    sessionGetter?: () => Promise<Response>;
    projectionGetter?: () => Promise<Response>;
    controlsGetter?: () => Promise<Response>;
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
  let admin = {
    state: "question",
    version: 0,
    snapshotRevision: 1,
    questionIndex: 0,
    questionCount: 5,
    projectionHidden: false,
    ...options.admin,
  };
  const transition = (action: "advance" | "previous") => {
    const { state, questionIndex, questionCount } = admin as {
      state: string;
      questionIndex: number;
      questionCount: number;
      version: number;
      projectionHidden: boolean;
    };
    const order = Array.from({ length: questionCount }, (_, index) => [
      { state: "question", questionIndex: index },
      { state: "answer", questionIndex: index },
    ]).flat();
    order.unshift({ state: "opening", questionIndex: 0 });
    order.push(
      { state: "podium_preview", questionIndex: questionCount },
      { state: "third", questionIndex: questionCount },
      { state: "second", questionIndex: questionCount },
      { state: "first", questionIndex: questionCount },
      { state: "finished", questionIndex: questionCount },
    );
    const current = order.findIndex(
      (slide) => slide.state === state && slide.questionIndex === questionIndex,
    );
    const next = order[current + (action === "advance" ? 1 : -1)];
    if (current < 0 || !next) return admin;
    return {
      ...admin,
      ...next,
      version: Number((admin as { version?: number }).version ?? 0) + 1,
    };
  };
  const slideProjection = (state: DeckProjectionFixture["state"]): DeckProjectionFixture =>
    state === "question" || state === "answer"
      ? {
          state,
          question: {
            id: 1,
            ordinal: 1,
            total: 5,
            question: "思い出の場所は？",
            choices: ["海", "山"],
            ...(typeof (projection as Record<string, unknown>).question === "object" &&
            (projection as Record<string, unknown>).question !== null
              ? ((projection as Record<string, unknown>).question as Record<string, unknown>)
              : {}),
            ...(state === "answer" ? { correctIndex: 0, explanation: "ふたりの思い出です。" } : {}),
          },
        }
      : state === "third" || state === "second" || state === "first"
        ? { state, winners: [] }
        : { state };
  const deckSlides: DeckSlideFixture[] = [
    deckSlide("opening", 0, { state: "opening" }),
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
  if (slideIndex >= 0) {
    const activeState = deckSlides[slideIndex]!.state;
    const activeProjection =
      activeState === "question" || activeState === "answer"
        ? slideProjection(activeState)
        : projection;
    deckSlides[slideIndex] = deckSlide(
      activeState,
      deckSlides[slideIndex]!.questionIndex,
      activeProjection as unknown as DeckProjectionFixture,
    );
  }
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
      return options.sessionGetter
        ? options.sessionGetter()
        : response({ authenticated: options.authenticated ?? true });
    if (path === "/api/admin/presentation" && init?.method === "POST") {
      await options.actionGate?.();
      const status = options.actionStatus ?? 200;
      if ((status >= 200 && status < 300) || options.commitBeforeActionError) {
        const action = JSON.parse(String(init.body)).action as "advance" | "previous";
        admin = options.actionAdmin
          ? {
              ...admin,
              ...options.actionAdmin,
              version: Number((admin as { version?: number }).version ?? 0) + 1,
            }
          : transition(action);
      }
      if (options.actionInvalidJson && status >= 200 && status < 300)
        return new Response("not-json", { status });
      return response(
        status >= 200 && status < 300 ? (options.actionPayload ?? admin) : admin,
        status,
      );
    }
    if (path === "/api/admin/presentation?view=controls")
      return options.controlsGetter ? options.controlsGetter() : response(admin);
    if (path === "/api/admin/presentation/deck")
      return options.deckGetter
        ? options.deckGetter()
        : response({
            snapshotRevision: admin.snapshotRevision,
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
    installPresentationFitLayout();
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

  it("exposes a single slide region without persistent presentation chrome", async () => {
    setup();
    render(<PresentationScreen />);

    expect(await screen.findByRole("region", { name: "現在のスライド" })).toBeInTheDocument();
    expect(screen.queryByText("STCIRT")).not.toBeInTheDocument();
    expect(screen.queryByText("CELEBRATION QUIZ")).not.toBeInTheDocument();
    expect(screen.queryByText("WITH LOVE, ALWAYS")).not.toBeInTheDocument();
  });

  it.each([
    ["standby", { state: "standby" }, ["ただいま休憩中です", "まもなく再開します"]],
    [
      "not_started",
      { state: "not_started" },
      ["しゅんたま検定", "発表が始まるまで、少々お待ちください"],
    ],
    ["opening", { state: "opening" }, ["しゅんたま検定", "これまでの思い出を振り返りましょう"]],
    [
      "question",
      {
        state: "question",
        question: {
          id: 2,
          ordinal: 2,
          total: 5,
          question: "一緒に見た最初の映画は？",
          choices: ["作品A", "作品B", "作品C"],
        },
      },
      ["QUESTION 2", "/ 5", "一緒に見た最初の映画は？", "作品A", "作品B", "作品C"],
    ],
    [
      "answer",
      {
        state: "answer",
        question: {
          id: 2,
          ordinal: 2,
          total: 5,
          question: "一緒に見た最初の映画は？",
          choices: ["作品A", "作品B", "作品C"],
          correctIndex: 1,
          explanation: "共通の友人にすすめられた作品です。",
        },
      },
      [
        "QUESTION 2",
        "一緒に見た最初の映画は？",
        "作品A",
        "作品B",
        "作品C",
        "正解",
        "共通の友人にすすめられた作品です。",
      ],
    ],
    [
      "podium_preview",
      { state: "podium_preview" },
      ["いよいよ、結果発表です", "これから入賞者を発表します。どうぞお楽しみに"],
    ],
    [
      "third",
      { state: "third", winners: [{ displayName: "葵", score: 8.25, rank: 3 }] },
      ["第3位", "8.25 ポイント", "葵"],
    ],
    [
      "second",
      { state: "second", winners: [{ displayName: "凛", score: 9.5, rank: 2 }] },
      ["第2位", "9.50 ポイント", "凛"],
    ],
    [
      "first",
      { state: "first", winners: [{ displayName: "悠", score: 10, rank: 1 }] },
      ["第1位", "10.00 ポイント", "悠"],
    ],
    [
      "finished",
      { state: "finished" },
      [
        "ご参加",
        "ありがとうございました",
        "ふたりの思い出を一緒に祝ってくださり、心から感謝します",
      ],
    ],
  ] as const)(
    "preserves the meaning and labels of the %s slide",
    async (_state, projection, contents) => {
      setup({ projection });
      render(<PresentationScreen />);

      const slide = await screen.findByRole("region", { name: "現在のスライド" });
      for (const content of contents) expect(slide).toHaveTextContent(content);
      if (projection.state === "answer") {
        const correctChoice = screen.getByText("正解").closest("li");
        expect(correctChoice).toHaveTextContent("B作品B");
        expect(correctChoice).toHaveClass(/correct/);
      }
      if (
        projection.state === "third" ||
        projection.state === "second" ||
        projection.state === "first"
      ) {
        const rank = slide.querySelector("[class*='rank']");
        const winner = slide.querySelector("article");
        const name = winner?.querySelector("h1");
        const score = winner?.querySelector("[class*='winnerScore']");
        expect(rank).not.toBeNull();
        expect(name).not.toBeNull();
        expect(score).not.toBeNull();
        expect(slide.querySelectorAll("[class*='rank']")).toHaveLength(1);
        expect(rank?.textContent).toBe(
          projection.state === "third"
            ? "第3位"
            : projection.state === "second"
              ? "第2位"
              : "第1位",
        );
        expect(rank!.compareDocumentPosition(name!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(name?.textContent).toContain(projection.winners[0]!.displayName);
        expect(name?.textContent).toContain("さん");
        expect(name!.compareDocumentPosition(score!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      }
    },
  );

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
    const firstAction = api.calls.find(
      ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
    );
    expect(JSON.parse(String(firstAction?.init?.body))).toMatchObject({
      action: "advance",
      expectedSnapshotRevision: 1,
    });
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
      api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls"),
    ).toHaveLength(1);
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
    await expectDeckLoadFailureToBeInert(async () => response({ slides: [null] }));
  });

  it("reaches the deck parser for a slide with an invalid projection", async () => {
    await expectDeckLoadFailureToBeInert(async () =>
      response({
        snapshotRevision: 1,
        slides: [{ state: "question", questionIndex: 0, projection: null }],
      }),
    );
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

  it("fails closed when the loaded deck does not contain the authoritative control cursor", async () => {
    const api = setup({
      deckGetter: async () =>
        response({
          slides: [
            {
              state: "question",
              questionIndex: 1,
              projection: {
                state: "question",
                question: {
                  id: 2,
                  ordinal: 2,
                  total: 5,
                  question: "別の質問",
                  choices: ["A"],
                },
              },
            },
          ],
        }),
    });
    render(<PresentationScreen presenterRequested />);
    expect(await screen.findByText("スライドを読み込めませんでした")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(2);
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("re-fetches an initially mismatched deck and displays the matching cursor", async () => {
    let deckReads = 0;
    const api = setup({
      deckGetter: async () => {
        deckReads += 1;
        return response({
          slides:
            deckReads === 1
              ? [
                  {
                    state: "question",
                    questionIndex: 1,
                    projection: {
                      state: "question",
                      question: {
                        id: 2,
                        ordinal: 2,
                        total: 5,
                        question: "古いカーソル",
                        choices: ["回答A"],
                      },
                    },
                  },
                ]
              : [
                  {
                    state: "question",
                    questionIndex: 0,
                    projection: {
                      state: "question",
                      question: {
                        id: 1,
                        ordinal: 1,
                        total: 5,
                        question: "再取得した質問",
                        choices: ["回答A"],
                      },
                    },
                  },
                ],
        });
      },
    });
    render(<PresentationScreen presenterRequested />);

    expect(await screen.findByRole("heading", { name: "再取得した質問" })).toBeInTheDocument();
    expect(deckReads).toBe(2);
    expect(screen.queryByText("古いカーソル")).not.toBeInTheDocument();
    expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(2);
  });

  it("clears the private presenter deck when a scheduled controls GET returns 401", async () => {
    vi.useFakeTimers();
    let sessionReads = 0;
    let controlsReads = 0;
    const api = setup({
      sessionGetter: async () => {
        sessionReads += 1;
        return response({ authenticated: true });
      },
      controlsGetter: async () => {
        controlsReads += 1;
        return controlsReads === 1
          ? response({
              state: "question",
              version: 0,
              snapshotRevision: 1,
              questionIndex: 0,
              questionCount: 5,
              projectionHidden: false,
            })
          : response({}, 401);
      },
    });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      await settled();
      expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
      expect(sessionReads).toBe(1);
      expect(controlsReads).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await settled();
      expect(sessionReads).toBe(1);
      expect(controlsReads).toBe(2);
      expect(screen.getByText("ただいま休憩中です")).toBeInTheDocument();
      expect(screen.getByText("ただいま休憩中です")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "思い出の場所は？" })).not.toBeInTheDocument();
      expect(
        api.calls.filter(
          ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
        ),
      ).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it("does not overlap a controls refresh while a deck load is pending", async () => {
    vi.useFakeTimers();
    let resolveDeck!: (value: Response) => void;
    const deckPending = new Promise<Response>((resolve) => {
      resolveDeck = resolve;
    });
    let controlsReads = 0;
    const api = setup({
      controlsGetter: async () => {
        controlsReads += 1;
        return response(
          controlsReads === 1
            ? {
                state: "question",
                version: 0,
                snapshotRevision: 1,
                questionIndex: 0,
                questionCount: 5,
                projectionHidden: false,
              }
            : {
                state: "answer",
                version: 1,
                snapshotRevision: 1,
                questionIndex: 0,
                questionCount: 5,
                projectionHidden: false,
              },
        );
      },
      deckGetter: () => deckPending,
    });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      await settled();
      expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(
        1,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await settled();
      expect(controlsReads).toBe(1);

      await act(async () => {
        resolveDeck(
          response({
            slides: [
              {
                state: "question",
                questionIndex: 0,
                projection: {
                  state: "question",
                  question: {
                    id: 1,
                    ordinal: 1,
                    total: 5,
                    question: "質問",
                    choices: ["A"],
                  },
                },
              },
            ],
          }),
        );
        await deckPending;
      });
      await settled();
      expect(screen.getByRole("heading", { name: "質問" })).toBeInTheDocument();
    } finally {
      resolveDeck(response({ slides: [] }));
      await act(async () => {
        await deckPending;
      });
      await settled();
      view.unmount();
    }
  });

  it("ignores a controls response invalidated when presenter mode is disabled", async () => {
    vi.useFakeTimers();
    let controlsReads = 0;
    let resolveControls!: (value: Response) => void;
    const pendingControls = new Promise<Response>((resolve) => {
      resolveControls = resolve;
    });
    const api = setup({
      controlsGetter: async () => {
        controlsReads += 1;
        return controlsReads === 1
          ? response({
              state: "question",
              version: 0,
              snapshotRevision: 1,
              questionIndex: 0,
              questionCount: 5,
              projectionHidden: false,
            })
          : pendingControls;
      },
    });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      await settled();
      expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(controlsReads).toBe(2);

      view.rerender(<PresentationScreen presenterRequested={false} />);
      await act(async () => {
        resolveControls(
          response({
            state: "answer",
            version: 1,
            snapshotRevision: 1,
            questionIndex: 0,
            questionCount: 5,
            projectionHidden: false,
          }),
        );
        await pendingControls;
      });
      await settled();

      expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
      expect(screen.queryByText("THE STORY BEHIND IT")).not.toBeInTheDocument();
      expect(api.calls.some(({ path }) => path === "/api/admin/presentation/deck")).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("ignores a deck response invalidated when presenter mode is disabled", async () => {
    let resolveDeck!: (value: Response) => void;
    const pendingDeck = new Promise<Response>((resolve) => {
      resolveDeck = resolve;
    });
    const api = setup({ deckGetter: () => pendingDeck });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      expect(await screen.findByText("スライドを読み込んでいます")).toBeInTheDocument();
      view.rerender(<PresentationScreen presenterRequested={false} />);

      await act(async () => {
        resolveDeck(
          response({
            snapshotRevision: 1,
            slides: [
              {
                state: "question",
                questionIndex: 0,
                projection: {
                  state: "answer",
                  question: {
                    id: 1,
                    ordinal: 1,
                    total: 5,
                    question: "思い出の場所は？",
                    choices: ["海", "山"],
                    correctIndex: 0,
                    explanation: "プレゼンター専用の古い回答",
                  },
                },
              },
            ],
          }),
        );
        await pendingDeck;
      });
      await settled();

      expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
      expect(screen.queryByText("THE STORY BEHIND IT")).not.toBeInTheDocument();
      expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(
        1,
      );
    } finally {
      view.unmount();
    }
  });

  it("ignores a rejected deck load after presenter mode is disabled", async () => {
    let rejectDeck!: (error: Error) => void;
    const pendingDeck = new Promise<Response>((_resolve, reject) => {
      rejectDeck = reject;
    });
    const api = setup({ deckGetter: () => pendingDeck });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      expect(await screen.findByText("スライドを読み込んでいます")).toBeInTheDocument();
      view.rerender(<PresentationScreen presenterRequested={false} />);

      await act(async () => {
        rejectDeck(new Error("stale deck request failed"));
        await pendingDeck.catch(() => undefined);
      });
      await settled();

      expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
      expect(screen.queryByText("スライドを読み込めませんでした")).not.toBeInTheDocument();
      expect(api.calls.filter(({ path }) => path === "/api/admin/presentation/deck")).toHaveLength(
        1,
      );
    } finally {
      view.unmount();
    }
  });

  it.each([
    { label: "authenticated", makeResponse: () => response({ authenticated: true }) },
    { label: "unauthenticated", makeResponse: () => response({}, 401) },
  ])(
    "keeps the public slide when a stale $label session response resolves after presenter mode is disabled",
    async ({ makeResponse }) => {
      let resolveSession!: (value: Response) => void;
      const pendingSession = new Promise<Response>((resolve) => {
        resolveSession = resolve;
      });
      const api = setup({ sessionGetter: () => pendingSession });
      const view = render(<PresentationScreen presenterRequested />);

      try {
        await waitFor(() => {
          expect(api.calls.some(({ path }) => path === "/api/admin/session")).toBe(true);
        });
        view.rerender(<PresentationScreen presenterRequested={false} />);
        await settled();
        expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();

        await act(async () => {
          resolveSession(makeResponse());
          await pendingSession;
        });
        await settled();

        expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
        expect(api.calls.filter(({ path }) => path === "/api/admin/session")).toHaveLength(1);
        expect(
          api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls"),
        ).toHaveLength(0);
        expect(api.calls.some(({ path }) => path === "/api/admin/presentation/deck")).toBe(false);
      } finally {
        view.unmount();
      }
    },
  );

  it("renders a rank slide without winners statically", async () => {
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
    expect(region).not.toHaveClass(/announce/);
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
      ).toHaveLength(1);

      await act(async () => {
        resolveDeck(
          response({
            slides: [
              {
                state: "question",
                questionIndex: 0,
                projection: {
                  state: "question",
                  question: {
                    id: 1,
                    ordinal: 1,
                    total: 5,
                    question: "初期カーソルの質問",
                    choices: ["A"],
                  },
                },
              },
            ],
          }),
        );
        await deckPending;
      });
      await settled();
      expect(screen.queryByText("スライドを読み込んでいます")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "初期カーソルの質問" })).toBeInTheDocument();
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

  it("reconciles a malformed successful mutation response from authoritative controls", async () => {
    const api = setup({ actionPayload: { state: "answer" } });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    expect(await screen.findByText("正解")).toBeInTheDocument();
    await settled();

    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("reconciles a successful mutation response with invalid JSON", async () => {
    const api = setup({ actionInvalidJson: true });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    expect(await screen.findByText("正解")).toBeInTheDocument();
    await settled();

    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls"),
    ).toHaveLength(2);
  });

  it("reconciles a confirmed cursor that is absent from the cached deck", async () => {
    let deckReads = 0;
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const api = setup({
      actionAdmin: { state: "answer", questionIndex: 1 },
      actionGate: () => actionGate,
      deckGetter: async () => {
        deckReads += 1;
        return response({
          slides:
            deckReads === 1
              ? [
                  {
                    state: "question",
                    questionIndex: 0,
                    projection: {
                      state: "question",
                      question: {
                        id: 1,
                        ordinal: 1,
                        total: 5,
                        question: "現在の質問",
                        choices: ["A"],
                      },
                    },
                  },
                ]
              : [
                  {
                    state: "answer",
                    questionIndex: 1,
                    projection: {
                      state: "answer",
                      question: {
                        id: 2,
                        ordinal: 2,
                        total: 5,
                        question: "同期後カーソル",
                        choices: ["A"],
                        correctIndex: 0,
                      },
                    },
                  },
                ],
        });
      },
    });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    expect(screen.getByText("現在の質問")).toBeInTheDocument();
    expect(screen.queryByText("同期後カーソル")).not.toBeInTheDocument();
    await act(async () => {
      releaseAction();
      await Promise.resolve();
    });

    expect(await screen.findByText("同期後カーソル")).toBeInTheDocument();
    expect(deckReads).toBe(2);
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("uses the not-started projection returned by a protected mutation", async () => {
    setup({ actionAdmin: { state: "not_started", questionIndex: 0 } });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    expect(await screen.findByText("発表が始まるまで、少々お待ちください")).toBeInTheDocument();
  });

  it("reconciles a failed response after a possibly committed mutation without retrying", async () => {
    const api = setup({ actionStatus: 503, commitBeforeActionError: true });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    expect(await screen.findByText("正解")).toBeInTheDocument();
    await settled();

    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls").length,
    ).toBeGreaterThanOrEqual(2);
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

  it("does not apply a public projection response after unmount", async () => {
    let resolveProjection!: (value: Response) => void;
    const projectionPending = new Promise<Response>((resolve) => {
      resolveProjection = resolve;
    });
    const api = setup({ projectionGetter: () => projectionPending });
    const view = render(<PresentationScreen />);

    try {
      await settled();
      expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(1);
      view.unmount();

      await act(async () => {
        resolveProjection(response({ state: "finished" }));
        await projectionPending;
      });
      await settled();

      expect(view.container).toBeEmptyDOMElement();
    } finally {
      resolveProjection(response({ state: "finished" }));
      await act(async () => {
        await projectionPending;
      });
      await settled();
      view.unmount();
    }
  });

  it.each([
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

  it.each(["opening", "not_started"])(
    "does not request a previous action from the %s slide",
    async (state) => {
      const api = setup({ projection: { state }, admin: { state, questionIndex: 0 } });
      render(<PresentationScreen presenterRequested />);
      await settled();
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowLeft" });
      await settled();
      expect(
        api.calls.filter(
          ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
        ),
      ).toHaveLength(0);
    },
  );

  it.each([
    ["question", 0, 2],
    ["podium_preview", 0, 0],
  ])("returns from the %s first slide to opening", async (state, questionIndex, questionCount) => {
    const api = setup({ projection: { state }, admin: { state, questionIndex, questionCount } });
    render(<PresentationScreen presenterRequested />);
    await waitFor(() =>
      expect(api.calls.some(({ path }) => path === "/api/admin/presentation?view=controls")).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(api.calls.some(({ path }) => path === "/api/admin/presentation/deck")).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText("スライドを読み込んでいます")).not.toBeInTheDocument(),
    );
    if (state === "question") {
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument(),
      );
    }
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowLeft" });
    await settled();
    const mutations = api.calls.filter(
      ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
    );
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0];
    expect(mutation?.init?.body).toContain('"action":"previous"');
    expect(screen.getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
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

  it("renders one rank label followed by the winner name and score after a forward operation", async () => {
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
    expect(await screen.findByText("第3位")).toBeInTheDocument();
    expect(screen.getByText("12.50 ポイント")).toBeInTheDocument();
    expect(screen.getByText("葵", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "第3位の勝者一覧" })).not.toHaveClass(/announce/);
  });

  it("limits visible tied winners to two and reports the remaining count", async () => {
    setup({
      projection: {
        state: "third",
        winners: [
          { displayName: "葵", score: 12.5, rank: 3 },
          { displayName: "凛", score: 12.5, rank: 3 },
          { displayName: "悠", score: 12.5, rank: 3 },
          { displayName: "澪", score: 12.5, rank: 3 },
        ],
      },
      admin: { state: "third", questionIndex: 5, questionCount: 5 },
    });
    render(<PresentationScreen />);
    const region = await screen.findByRole("region", { name: "第3位の勝者一覧" });
    expect(region.querySelectorAll("article")).toHaveLength(2);
    expect(within(region).getByText("葵", { exact: false })).toBeInTheDocument();
    expect(within(region).getByText("凛", { exact: false })).toBeInTheDocument();
    expect(within(region).queryByText("悠", { exact: false })).not.toBeInTheDocument();
    expect(within(region).queryByText("澪", { exact: false })).not.toBeInTheDocument();
    expect(within(region).getByText("ほか 2 名")).toHaveClass(/additionalWinners/);
  });

  it("renders each winner's question answers and distinguishes unavailable scores", async () => {
    setup({
      projection: {
        state: "third",
        winners: [
          {
            displayName: "葵",
            score: 12.5,
            rank: 3,
            questionResults: [
              {
                position: 0,
                question: "一番の問題",
                answer: { kind: "selected", value: "青" },
                correctness: "correct",
              },
              {
                position: 1,
                question: "未回答の設問",
                answer: { kind: "unanswered" },
              },
              {
                position: 2,
                question: "過去形式の設問",
                answer: { kind: "legacy" },
              },
              {
                position: 3,
                question: null,
                answer: { kind: "unavailable" },
              },
              {
                position: 4,
                question: "自由記述",
                answer: { kind: "freeText", value: "保存された回答" },
                scoreStatus: "unavailable",
              },
              {
                position: 5,
                question: "保存済みの0点",
                answer: { kind: "freeText", value: "0点の回答" },
                normalizedScore: 0,
              },
              {
                position: 6,
                question: "未評価の設問",
                answer: { kind: "freeText", value: "未採点の回答" },
                normalizedScore: null,
              },
              {
                position: 7,
                question: "不正解の設問",
                answer: { kind: "selected", value: "赤" },
                correctness: "incorrect",
              },
              {
                position: 8,
                question: "正誤を確認できない設問",
                answer: { kind: "selected", value: null },
                correctness: "unavailable",
              },
              {
                position: 9,
                question: "回答を確認できない自由記述",
                answer: { kind: "freeText", value: null },
                normalizedScore: 0.25,
              },
            ],
          },
        ],
      },
      admin: { state: "third", questionIndex: 5, questionCount: 5 },
    });
    render(<PresentationScreen />);
    const region = await screen.findByRole("region", { name: "第3位の勝者一覧" });
    expect(within(region).getByText("Q1")).toBeInTheDocument();
    expect(within(region).getByText("Q8")).toBeInTheDocument();
    expect(within(region).getByText("Q9")).toBeInTheDocument();
    const correctRow = within(region).getByText("Q1").closest("li") as HTMLLIElement;
    expect(within(correctRow).getByLabelText("正解")).toBeInTheDocument();
    expect(within(correctRow).getByText("○")).toBeInTheDocument();
    expect(within(region).getByText("Q2").parentElement).toHaveTextContent("—");
    expect(within(region).getByText("Q3").parentElement).toHaveTextContent("—");
    expect(within(region).getByText("Q4").parentElement).toHaveTextContent("—");
    const incorrectRow = within(region).getByText("Q8").closest("li") as HTMLLIElement;
    expect(within(incorrectRow).getByLabelText("不正解")).toBeInTheDocument();
    expect(within(incorrectRow).getByText("×")).toBeInTheDocument();
    const unavailableRow = within(region).getByText("Q9").closest("li") as HTMLLIElement;
    expect(within(unavailableRow).getByLabelText("正誤を確認できません")).toBeInTheDocument();
    expect(within(unavailableRow).getByText("—")).toBeInTheDocument();
    const missingFreeTextRow = within(region).getByText("Q10").closest("li") as HTMLLIElement;
    expect(within(missingFreeTextRow).getByText("回答を確認できません")).toBeInTheDocument();
    expect(within(missingFreeTextRow).getByText("得点 0.25")).toBeInTheDocument();
    for (const questionLabel of ["Q1", "Q2", "Q3", "Q4", "Q8", "Q9"]) {
      const nonFreeTextRow = within(region).getByText(questionLabel).closest("li") as HTMLLIElement;
      expect(within(nonFreeTextRow).queryByText("回答を確認できません")).not.toBeInTheDocument();
    }
    expect(screen.getByText("保存された回答")).toBeInTheDocument();
    expect(screen.getByText("得点を確認できません")).toBeInTheDocument();
    expect(screen.getByText("得点 0")).toBeInTheDocument();
    expect(screen.getByText("未採点")).toBeInTheDocument();
    expect(screen.getByText("0点の回答")).toBeInTheDocument();
    expect(screen.getByText("未採点の回答")).toBeInTheDocument();
    expect(screen.getByText("得点 0.25")).toBeInTheDocument();
    for (const hiddenText of [
      "一番の問題",
      "未回答の設問",
      "過去形式の設問",
      "自由記述",
      "保存済みの0点",
      "未評価の設問",
      "不正解の設問",
      "正誤を確認できない設問",
      "回答を確認できない自由記述",
      "青",
      "赤",
      "未回答",
      "過去形式の回答",
    ]) {
      expect(within(region).queryByText(hiddenText, { exact: true })).not.toBeInTheDocument();
    }
    const questionLabels = Array.from(
      region.querySelectorAll("[class*='winnerQuestionLabel']"),
      (label) => label.textContent,
    );
    expect(questionLabels).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10"]);
    const fifthQuestion = within(region).getByText("Q5").closest("li");
    expect(fifthQuestion).toHaveClass(/fifthWinnerQuestion/);
    expect(fifthQuestion).toHaveClass(/freeTextResult/);
    for (const [questionLabel, placementClass] of [
      ["Q1", "firstWinnerQuestion"],
      ["Q2", "secondWinnerQuestion"],
      ["Q3", "thirdWinnerQuestion"],
      ["Q4", "fourthWinnerQuestion"],
    ]) {
      const question = within(region).getByText(questionLabel).closest("li");
      expect(question).toHaveClass(new RegExp(placementClass));
      expect(question).not.toHaveClass(/fifthWinnerQuestion/);
    }
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

  it("keeps rank content static under reduced motion", async () => {
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
