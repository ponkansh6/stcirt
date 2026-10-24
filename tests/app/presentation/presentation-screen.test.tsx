import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationScreen from "@/app/presentation/presentation-screen";
import { installPresentationFitLayout } from "./presentation-fit-test-helpers";

type WinnerFixture = {
  displayName: string;
  score: number;
  rank: number;
  questionResults?: {
    position: number;
    question: string | null;
    answer:
      | { kind: "selected"; value: string | null }
      | { kind: "freeText"; value: string | null }
      | { kind: "unanswered" }
      | { kind: "legacy" }
      | { kind: "unavailable" };
    correctness?: "correct" | "incorrect" | "unavailable";
    normalizedScore?: number | null;
    scoreStatus?: "unavailable";
  }[];
};
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
    actionStatuses?: number[];
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
  let actionCallCount = 0;
  let deckSlides: DeckSlideFixture[] = [];
  const transition = (targetState: string, targetIndex: number) => {
    const next = deckSlides.find(
      (slide) => slide.state === targetState && slide.questionIndex === targetIndex,
    );
    if (!next) return admin;
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
  deckSlides = [
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
      const status = options.actionStatuses?.[actionCallCount++] ?? options.actionStatus ?? 200;
      if ((status >= 200 && status < 300) || options.commitBeforeActionError) {
        const action = JSON.parse(String(init.body)) as {
          action: string;
          state?: string;
          questionIndex?: number;
        };
        admin = options.actionAdmin
          ? {
              ...admin,
              ...options.actionAdmin,
              version: Number((admin as { version?: number }).version ?? 0) + 1,
            }
          : action.action === "position" &&
              typeof action.state === "string" &&
              typeof action.questionIndex === "number"
            ? transition(action.state, action.questionIndex)
            : admin;
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

function createMediaQueryList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
}

function currentPresenceEntry(className: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[class*='${className}']`)).find(
    (entry) => !entry.closest('[aria-hidden="true"]'),
  );
}

describe("presentation projection and presenter progression", () => {
  beforeEach(() => {
    installPresentationFitLayout();
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "op-1") });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => createMediaQueryList(true)),
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
    expect(document.querySelector("[class*='questionMotion']")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全画面表示" })).not.toBeInTheDocument();
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

  it.each([
    ["opening", { state: "opening" }, "openingMotion"],
    [
      "question",
      {
        state: "question",
        question: { id: 1, ordinal: 1, total: 5, question: "設問", choices: ["A", "B"] },
      },
      "questionMotion",
    ],
    ["podium preview", { state: "podium_preview" }, "podiumPreviewMotion"],
    ["finished", { state: "finished" }, "finishedMotion"],
    [
      "answer",
      {
        state: "answer",
        question: {
          id: 1,
          ordinal: 1,
          total: 5,
          question: "設問",
          choices: ["A", "B"],
          correctIndex: 0,
          explanation: "補足",
        },
      },
      null,
    ],
    ["rank", { state: "third", winners: [{ displayName: "花子", score: 1, rank: 3 }] }, null],
  ] as const)(
    "applies generic entry only to the selected %s stage",
    async (_name, projection, entryClass) => {
      setup({ projection });
      render(<PresentationScreen />);
      await settled();

      const slide = screen.getByTestId("presentation-natural-layer");
      if (entryClass) {
        expect(slide.querySelector(`[class*='${entryClass}']`)).toBeInTheDocument();
        expect(slide.querySelectorAll("[class*='Motion']")).toHaveLength(1);
      } else {
        expect(slide.querySelector("[class*='Motion']")).not.toBeInTheDocument();
      }
      if (_name === "rank") {
        expect(slide.querySelector("[class*='winnerReveal']")).toBeInTheDocument();
      }
    },
  );

  it("keeps a question entry mounted across same-ID polls and replaces it for a new question ID", async () => {
    vi.useFakeTimers();
    let projection: Record<string, unknown> = {
      state: "question",
      question: {
        id: 11,
        ordinal: 1,
        total: 5,
        question: "短い設問",
        choices: ["A", "B"],
      },
    };
    const api = setup({ projectionGetter: async () => response(projection) });
    render(<PresentationScreen />);
    await settled();
    const firstEntry = currentPresenceEntry("questionMotion");
    expect(firstEntry).toBeInTheDocument();

    projection = {
      state: "question",
      question: {
        id: 11,
        ordinal: 1,
        total: 5,
        question: "同じIDのpollで届いた長い設問文".repeat(8),
        choices: ["A", "B", "C", "D"],
      },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    await settled();

    expect(currentPresenceEntry("questionMotion")).toBe(firstEntry);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("heading", { name: /同じIDのpoll/ })).toBeInTheDocument();

    projection = {
      state: "question",
      question: {
        id: 12,
        ordinal: 2,
        total: 5,
        question: "新しい設問",
        choices: ["次の選択肢"],
      },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    await settled();

    const nextEntry = currentPresenceEntry("questionMotion");
    expect(nextEntry).toBeInTheDocument();
    expect(nextEntry).not.toBe(firstEntry);
    expect(screen.getByRole("heading", { name: "新しい設問" })).toBeInTheDocument();
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(3);
  });

  it("keeps an answer entry mounted across same-ID polls and replaces it for a new ID", async () => {
    vi.useFakeTimers();
    let projection: Record<string, unknown> = {
      state: "answer",
      question: {
        id: 21,
        ordinal: 1,
        total: 5,
        question: "短い設問",
        choices: ["A", "B"],
        correctIndex: 0,
        explanation: "最初の補足",
      },
    };
    const api = setup({ projectionGetter: async () => response(projection) });
    render(<PresentationScreen />);
    await settled();
    const firstEntry = currentPresenceEntry("answerReveal");
    expect(firstEntry).toBeInTheDocument();

    projection = {
      state: "answer",
      question: {
        id: 21,
        ordinal: 1,
        total: 5,
        question: "更新後の設問",
        choices: ["A", "B", "C"],
        correctIndex: 1,
        explanation: "同じIDの補足更新",
      },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    await settled();

    expect(currentPresenceEntry("answerReveal")).toBe(firstEntry);
    expect(screen.getByText("同じIDの補足更新")).toBeInTheDocument();

    projection = {
      state: "answer",
      question: {
        id: 22,
        ordinal: 2,
        total: 5,
        question: "次の設問",
        choices: ["C", "D"],
        correctIndex: 0,
        explanation: "次の補足",
      },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    await settled();

    const nextEntry = currentPresenceEntry("answerReveal");
    expect(nextEntry).toBeInTheDocument();
    expect(nextEntry).not.toBe(firstEntry);
    expect(screen.getByText("次の補足")).toBeInTheDocument();
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(3);
  });

  it("does not retain an exiting slide when reduced motion is enabled", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => createMediaQueryList(true)),
    );
    setup();
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main", { name: "プレゼンテーションスライド" });
    await settled();

    fireEvent.keyDown(main, { key: "ArrowRight" });
    expect(await screen.findByText("正解")).toBeInTheDocument();
    await settled();

    expect(
      document.querySelector(
        "[data-testid='presentation-natural-layer'] [aria-hidden='true'][inert]",
      ),
    ).not.toBeInTheDocument();
  });

  it("announces only the concise slide stage and documents focused keyboard controls", async () => {
    setup({
      projection: {
        state: "question",
        question: {
          id: 1,
          ordinal: 1,
          total: 5,
          question: "思い出の場所は？",
          choices: ["海", "山"],
        },
      },
    });
    render(<PresentationScreen presenterRequested />);
    await settled();

    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    expect(main).toHaveAttribute("aria-describedby", "presentation-keyboard-help");
    expect(screen.getByText(/左右矢印キーで前後のスライド/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("第1問");
    expect(screen.getByRole("status")).not.toHaveTextContent("思い出の場所は？");
    expect(main).not.toHaveAttribute("aria-live");
    expect(main.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("advances and reverses from the focused presentation surface", async () => {
    const api = setup({ admin: { state: "question", questionIndex: 1, questionCount: 5 } });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    await settled();
    main.focus();
    expect(main).toHaveFocus();

    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    fireEvent.keyDown(main, { key: "ArrowLeft" });
    await settled();

    const positionWrites = api.calls
      .filter(({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST")
      .map(({ init }) => JSON.parse(String(init?.body)));
    expect(positionWrites).toMatchObject([
      { action: "position", state: "answer", questionIndex: 1 },
      { action: "position", state: "question", questionIndex: 1 },
    ]);
  });

  it.each(["Enter", " "])("advances with the focused surface %s key", async (key) => {
    const api = setup({ admin: { state: "question", questionIndex: 1, questionCount: 5 } });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    await settled();
    main.focus();
    expect(main).toHaveFocus();

    fireEvent.keyDown(main, { key });
    await settled();

    expect(
      api.calls
        .filter(({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST")
        .map(({ init }) => JSON.parse(String(init?.body)).action),
    ).toEqual(["position"]);
  });

  it("does not navigate when the fullscreen button is activated", async () => {
    const api = setup({ admin: { state: "question", questionIndex: 1, questionCount: 5 } });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    const fullscreenButton = await screen.findByRole("button", { name: "全画面表示" });
    await settled();

    fireEvent.keyDown(fullscreenButton, { key: "ArrowRight" });
    fireEvent.click(fullscreenButton);
    await settled();

    expect(main).toBeInTheDocument();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it.each([
    {
      name: "question",
      projection: {
        state: "question",
        question: {
          id: 1,
          ordinal: 1,
          total: 5,
          question: "秘密の問題文",
          choices: ["秘密の選択肢", "別の選択肢"],
        },
      },
      admin: { state: "question", questionIndex: 0, questionCount: 5 },
      expected: "第1問",
      forbidden: ["秘密の問題文", "秘密の選択肢"],
    },
    {
      name: "answer",
      projection: {
        state: "answer",
        question: {
          id: 1,
          ordinal: 1,
          total: 5,
          question: "秘密の問題文",
          choices: ["秘密の選択肢", "別の選択肢"],
          correctAnswer: "秘密の正解",
          explanation: "秘密の解説",
          responses: [
            {
              displayName: "秘密の回答者",
              answer: "秘密の回答",
              answerKind: "freeText",
              similarity: 1,
              score: 1,
            },
          ],
        },
      },
      admin: { state: "answer", questionIndex: 0, questionCount: 5 },
      expected: "第1問の解説",
      forbidden: ["秘密の問題文", "秘密の正解", "秘密の解説", "秘密の回答者", "秘密の回答"],
    },
    {
      name: "rank",
      projection: {
        state: "first",
        winners: [{ displayName: "秘密の受賞者", score: 100, rank: 1 }],
      },
      admin: { state: "first", questionIndex: 5, questionCount: 5 },
      expected: "第一位を発表します",
      forbidden: ["秘密の受賞者", "100"],
    },
  ])(
    "keeps the $name live announcement concise",
    async ({ projection, admin, expected, forbidden }) => {
      setup({ projection, admin });
      render(<PresentationScreen presenterRequested />);
      await settled();

      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(expected);
      for (const privateSlideContent of forbidden) {
        expect(status).not.toHaveTextContent(privateSlideContent);
      }
    },
  );

  it("limits presentation motion when reduced motion is requested", () => {
    const stylesheet = readFileSync(
      join(process.cwd(), "src/app/presentation/presentation-screen.module.css"),
      "utf8",
    );

    expect(stylesheet).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(stylesheet).toMatch(
      /@keyframes presentationEntry\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translateY\(-12px\);/s,
    );
    const entryKeyframes = stylesheet.match(/@keyframes presentationEntry\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(entryKeyframes).toBeDefined();
    expect(
      Array.from(
        new Set(
          Array.from(
            entryKeyframes!.matchAll(/^\s*([a-z-]+):/gm),
            ([, property]) => property ?? "",
          ),
        ),
      ).sort(),
    ).toEqual(["opacity", "transform"]);
    expect(stylesheet).toMatch(
      /\.questionMotion > \.choices > li:nth-child\(n \+ 4\)\s*\{[^}]*animation-delay:\s*255ms;/s,
    );
    expect(stylesheet).toMatch(
      /\.openingMotion \.openingTitle,[\s\S]*?\.finishedMotion \.subtitle\s*\{[^}]*animation:\s*none !important;[^}]*animation-delay:\s*0s !important;[^}]*opacity:\s*1 !important;[^}]*transform:\s*none !important;/,
    );
    expect(stylesheet).not.toMatch(
      /\.(?:answerReview|winners)\s*\{[^}]*animation:\s*presentationEntry/,
    );
    expect(stylesheet).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(stylesheet).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(stylesheet).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(stylesheet).toMatch(/scroll-behavior:\s*auto\s*!important/);
    expect(stylesheet).toMatch(/\.winners\s*\{[^}]*--rank-reveal-boundary:\s*760ms;/s);
    expect(stylesheet).toMatch(/\.winners\s*\{[^}]*--rank-reveal-duration:\s*540ms;/s);
    expect(stylesheet).not.toMatch(/\.winnerReveal\s*\{[^}]*animation:\s*rankWinnerReveal/s);
    expect(stylesheet).toMatch(
      /\.winnerContent\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(stylesheet).toMatch(
      /\.winnerContent\s*\{[^}]*animation:\s*rankWinnerReveal var\(--rank-reveal-duration\) cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)\s*var\(--rank-reveal-boundary\) both;/s,
    );
    expect(stylesheet).toMatch(
      /\.winnerReveal\[data-reveal-eligible="true"\]::before,\s*\.winnerReveal\[data-reveal-eligible="true"\]::after\s*\{[^}]*animation:\s*rankRevealAnticipation var\(--rank-reveal-boundary\) ease-out 0ms both;/s,
    );
    expect(stylesheet).toMatch(
      /\.winnerReveal::before,\s*\.winnerReveal::after\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*transform-origin:\s*center;/s,
    );
    expect(stylesheet).toMatch(
      /\.answerReveal\s*\{\s*animation:\s*answerRevealFade 350ms ease 100ms backwards;/,
    );
    expect(stylesheet).toMatch(
      /\.answerSupplement\s*\{\s*animation:\s*answerRevealFade 300ms ease 350ms backwards;/,
    );
    expect(stylesheet).toMatch(
      /\.answerReveal,\s*\.answerSupplement\s*\{\s*animation:\s*none;\s*animation-delay:\s*0s;\s*opacity:\s*1;/,
    );
    expect(stylesheet).toMatch(
      /\.screen \.winnerContent,\s*\.screen \.rankHeader,\s*\.screen \.rank::before\s*\{\s*animation:\s*none !important;/,
    );
    expect(stylesheet).toMatch(
      /\.screen \.winnerReveal::before,\s*\.screen \.winnerReveal::after\s*\{[^}]*animation:\s*none !important;[^}]*opacity:\s*0\s*!important;/s,
    );
  });

  it("keeps the opening frame decorative and outside the fitted content layer", () => {
    const stylesheet = readFileSync(
      join(process.cwd(), "src/app/presentation/presentation-screen.module.css"),
      "utf8",
    );

    expect(stylesheet).toMatch(
      /\.openingFrame\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(stylesheet).toMatch(
      /\.openingFrame::before\s*\{[^}]*inset:\s*2\.5%;[^}]*border:\s*2px solid/s,
    );
    expect(stylesheet).toMatch(
      /\.openingFrame::after\s*\{[^}]*inset:\s*calc\(2\.5% \+ 6px\);[^}]*border:\s*1px solid/s,
    );
    expect(stylesheet).toMatch(/\.fitViewport\s*\{[^}]*z-index:\s*1;/s);
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
      ["しゅんたま検定", "解答解説・表彰", "発表が始まるまで、少々お待ちください"],
    ],
    ["opening", { state: "opening" }, ["しゅんたま検定", "解答解説・表彰", "検定"]],
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
      ["問 2", "一緒に見た最初の映画は？", "作品A", "作品B", "作品C"],
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
        "問 2",
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
      ["第三位", "8.25 ポイント", "葵"],
    ],
    [
      "second",
      { state: "second", winners: [{ displayName: "凛", score: 9.5, rank: 2 }] },
      ["第二位", "9.50 ポイント", "凛"],
    ],
    [
      "first",
      { state: "first", winners: [{ displayName: "悠", score: 10, rank: 1 }] },
      ["第一位", "10.00 ポイント", "悠"],
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
        expect(slide.querySelector("img[class*='presentationFrame']")).toHaveAttribute(
          "src",
          "/certificate_reference_style_16x9.svg",
        );
        const rank = slide.querySelector("[class*='rankHeader'] h1[class*='rank']");
        const winner = slide.querySelector("article");
        const name = winner?.querySelector("h1");
        const score = winner?.querySelector("[class*='winnerScore']");
        expect(rank).not.toBeNull();
        expect(slide.querySelectorAll("[data-testid='presentation-exam-stamp']")).toHaveLength(1);
        const certificateLabel = slide.querySelector("[class*='certificateLabel']");
        expect(certificateLabel?.textContent).toBe("認定証");
        expect(rank!.compareDocumentPosition(certificateLabel!)).toBe(
          Node.DOCUMENT_POSITION_PRECEDING,
        );
        expect(name).not.toBeNull();
        expect(score).not.toBeNull();
        expect(slide.querySelectorAll("[class*='rankHeader'] h1[class*='rank']")).toHaveLength(1);
        expect(rank?.textContent).toBe(
          projection.state === "third"
            ? "第三位"
            : projection.state === "second"
              ? "第二位"
              : "第一位",
        );
        expect(rank!.compareDocumentPosition(name!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
        expect(name?.textContent).toContain(projection.winners[0]!.displayName);
        expect(name?.textContent).toContain(`${projection.winners[0]!.displayName}\u00a0殿`);
        expect(name!.compareDocumentPosition(score!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      }
    },
  );

  it.each(["not_started", "opening"] as const)(
    "renders the exam cover without English labels in %s",
    async (state) => {
      setup({ projection: { state } });
      render(<PresentationScreen />);

      const slide = await screen.findByRole("region", { name: "現在のスライド" });
      expect(within(slide).getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
      expect(within(slide).getByText("解答解説・表彰")).toBeInTheDocument();
      expect(slide.querySelector("img[class*='presentationFrame']")).toBeNull();
      const frame = slide.querySelector("[class*='openingFrame']");
      expect(frame).toHaveAttribute("aria-hidden", "true");
      expect(frame?.parentElement).toBe(slide);
      expect(frame?.closest("[data-testid='presentation-fit-layer']")).toBeNull();
      const lockup = slide.querySelector("[class*='openingLockup']");
      const waitSlot = slide.querySelector("[class*='openingWaitSlot']");
      expect(lockup).not.toBeNull();
      expect(slide.querySelectorAll("[data-testid='presentation-exam-stamp']")).toHaveLength(
        state === "opening" ? 1 : 0,
      );
      expect(waitSlot).not.toBeNull();
      if (state === "opening") {
        expect(waitSlot).toHaveAttribute("aria-hidden", "true");
      } else {
        expect(waitSlot).not.toHaveAttribute("aria-hidden");
      }
      expect(within(slide).queryByText("PRESENTATION")).not.toBeInTheDocument();
      expect(
        within(slide).queryByText("これまでの思い出を振り返りましょう"),
      ).not.toBeInTheDocument();
      if (state === "not_started") {
        expect(within(slide).getByText("発表が始まるまで、少々お待ちください")).toBeInTheDocument();
      }
    },
  );

  it("removes start and publication controls from the presenter projection", async () => {
    const api = setup({
      projection: { state: "not_started" },
      admin: { state: "not_started", questionIndex: 0, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main", { name: "プレゼンテーションスライド" });
    await within(main).findByRole("button", { name: "全画面表示" });
    const presenter = within(screen.getByRole("main"));
    expect(presenter.getByRole("button", { name: "全画面表示" })).toBeVisible();
    expect(presenter.queryByRole("button", { name: "発表を開始" })).not.toBeInTheDocument();
    expect(presenter.queryByRole("button", { name: "参加者結果を公開" })).not.toBeInTheDocument();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    fireEvent.keyDown(main, { key: "Enter" });
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
    expect(actions).toEqual(["position", "position", "position", "position", "position"]);
    const firstAction = api.calls.find(
      ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
    );
    expect(JSON.parse(String(firstAction?.init?.body))).toMatchObject({
      action: "position",
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

  it("keeps local navigation responsive while its cursor write is in flight", async () => {
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
    ).toBeGreaterThanOrEqual(1);
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
    const region = await screen.findByRole("region", { name: "第三位の勝者一覧" });
    await settled();

    const emptyMessage = screen.getByText("該当する受賞者はいません");
    expect(emptyMessage).toBeInTheDocument();
    expect(region.querySelector("[class*='winnerReveal']")).toContainElement(emptyMessage);
    expect(region.querySelector("[class*='winnerReveal']")).toHaveAttribute(
      "data-reveal-eligible",
      "false",
    );
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

  it("keeps spectator polling independent from a presenter cursor write", async () => {
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
    expect(api.calls.filter(({ path }) => path === "/api/presentation")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(
      api.calls.filter(({ path }) => path === "/api/presentation").length,
    ).toBeGreaterThanOrEqual(2);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(
      api.calls.filter(({ path }) => path === "/api/presentation").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("reconciles a 409 and retries the latest cursor without refetching slides", async () => {
    vi.useFakeTimers();
    const api = setup({ actionStatuses: [409, 200] });
    render(<PresentationScreen presenterRequested />);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    await settled();
    await act(async () => vi.advanceTimersByTimeAsync(10));
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
    ).toHaveLength(2);
  });

  it("keeps the latest local cursor while a 409 reconciliation poll is unavailable", async () => {
    vi.useFakeTimers();
    let controlsReads = 0;
    const api = setup({
      actionStatuses: [409, 200],
      controlsGetter: async () => {
        controlsReads += 1;
        if (controlsReads === 2) return response({ error: "offline" }, 503);
        return response({
          state: "question",
          version: 0,
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
        });
      },
    });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();

    expect(screen.getByText("正解")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    await settled();

    expect(controlsReads).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("正解")).toBeInTheDocument();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("retries an ambiguous 503 with the same absolute cursor while navigation stays local", async () => {
    vi.useFakeTimers();
    let controlsReads = 0;
    const api = setup({
      actionStatuses: [503, 200],
      commitBeforeActionError: true,
      deckSlides: [
        deckSlide("question", 1, {
          state: "question",
          question: {
            id: 2,
            ordinal: 2,
            total: 5,
            question: "次の設問",
            choices: ["C", "D"],
          },
        }),
      ],
      controlsGetter: async () => {
        controlsReads += 1;
        if (controlsReads === 2) return response({ error: "offline" }, 503);
        return response({
          state: controlsReads === 1 ? "question" : "answer",
          version: controlsReads === 1 ? 0 : 1,
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
        });
      },
    });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    expect(screen.getByText("正解")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settled();
    expect(screen.getByText("正解")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    const actions = api.calls.filter(
      ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
    );
    expect(actions).toHaveLength(3);
    expect(
      actions
        .map(({ init }) => JSON.parse(String(init?.body)))
        .map((body) => ({
          action: body.action,
          expectedSnapshotRevision: body.expectedSnapshotRevision,
        })),
    ).toEqual([
      { action: "position", expectedSnapshotRevision: 1 },
      { action: "position", expectedSnapshotRevision: 1 },
      { action: "position", expectedSnapshotRevision: 1 },
    ]);
    expect(screen.getByRole("heading", { name: "次の設問" })).toBeInTheDocument();
    expect(screen.queryByText("正解")).not.toBeInTheDocument();
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
    ).toBe(1);
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
    ).toHaveLength(1);
  });

  it.each(["question", "answer"] as const)(
    "keeps the cached cursor local when the server reports another %s cursor",
    async (confirmedState) => {
      let deckReads = 0;
      let controlsReads = 0;
      let releaseAction!: () => void;
      const actionGate = new Promise<void>((resolve) => {
        releaseAction = resolve;
      });
      let releaseControls!: (value: Response) => void;
      const controlsGate = new Promise<Response>((resolve) => {
        releaseControls = resolve;
      });
      const api = setup({
        actionAdmin: { state: confirmedState, questionIndex: 1 },
        actionGate: () => actionGate,
        controlsGetter: async () => {
          controlsReads += 1;
          if (controlsReads === 1)
            return response({
              state: "question",
              version: 0,
              snapshotRevision: 1,
              questionIndex: 0,
              questionCount: 5,
              projectionHidden: false,
            });
          if (controlsReads === 2) return controlsGate;
          return response({
            state: confirmedState,
            version: 1,
            snapshotRevision: 1,
            questionIndex: 1,
            questionCount: 5,
            projectionHidden: false,
          });
        },
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
                    {
                      state: "answer",
                      questionIndex: 0,
                      projection: {
                        state: "answer",
                        question: {
                          id: 1,
                          ordinal: 1,
                          total: 5,
                          question: "現在の質問",
                          choices: ["A"],
                          correctIndex: 0,
                        },
                      },
                    },
                  ]
                : [
                    {
                      state: confirmedState,
                      questionIndex: 1,
                      projection:
                        confirmedState === "question"
                          ? {
                              state: "question",
                              question: {
                                id: 2,
                                ordinal: 2,
                                total: 5,
                                question: "同期後カーソル",
                                choices: ["A"],
                              },
                            }
                          : {
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
      const view = render(<PresentationScreen presenterRequested />);

      try {
        await settled();
        fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
        await settled();
        expect(screen.getByText("正解")).toBeInTheDocument();
        await act(async () => {
          releaseAction();
          await Promise.resolve();
        });

        expect(screen.getByText("正解")).toBeInTheDocument();
        expect(screen.queryByText("同期後カーソル")).not.toBeInTheDocument();
        expect(deckReads).toBe(1);
        expect(controlsReads).toBe(1);
        expect(
          api.calls.filter(
            ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
          ),
        ).toHaveLength(1);
      } finally {
        releaseAction();
        releaseControls(
          response({
            state: confirmedState,
            version: 1,
            snapshotRevision: 1,
            questionIndex: 1,
            questionCount: 5,
            projectionHidden: false,
          }),
        );
        await settled();
        view.unmount();
      }
    },
  );

  it("applies not-started controls through polling after navigation", async () => {
    vi.useFakeTimers();
    const api = setup({ actionAdmin: { state: "not_started", questionIndex: 0 } });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    await settled();
    expect(screen.getByText("発表が始まるまで、少々お待ちください")).toBeInTheDocument();
  });

  it("retries an ambiguously failed absolute position write idempotently", async () => {
    vi.useFakeTimers();
    const api = setup({ actionStatuses: [503, 200], commitBeforeActionError: true });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await settled();

    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(2);
    expect(
      api.calls.filter(({ path }) => path === "/api/admin/presentation?view=controls").length,
    ).toBe(1);
  });

  it("drops an outstanding position write when presenter mode is disabled", async () => {
    vi.useFakeTimers();
    let rejectAction!: (error: Error) => void;
    const actionGate = new Promise<void>((_resolve, reject) => {
      rejectAction = reject;
    });
    const api = setup({
      actionGate: () => actionGate,
      controlsGetter: async () =>
        response({
          state: "answer",
          version: 1,
          snapshotRevision: 1,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
        }),
    });
    const view = render(<PresentationScreen presenterRequested />);

    try {
      await settled();
      fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
      expect(screen.getByText("第1問")).toBeInTheDocument();
      expect(
        api.calls.filter(
          ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
        ),
      ).toHaveLength(1);

      view.rerender(<PresentationScreen presenterRequested={false} />);
      view.rerender(<PresentationScreen presenterRequested />);
      await settled();
      expect(screen.getByText("正解")).toBeInTheDocument();

      await act(async () => {
        rejectAction(new Error("aborted position write"));
        await actionGate.catch(() => undefined);
      });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await settled();

      expect(
        api.calls.filter(
          ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
        ),
      ).toHaveLength(1);
      expect(screen.getByText("正解")).toBeInTheDocument();
    } finally {
      view.unmount();
    }
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
    expect(mutation?.init?.body).toContain('"action":"position"');
    expect(screen.getByRole("heading", { name: "しゅんたま検定" })).toBeInTheDocument();
  });

  it("keeps progression gestures independent of fullscreen", async () => {
    const api = setup();
    const requestFullscreen = vi.fn().mockRejectedValue(new Error("denied"));
    render(<PresentationScreen presenterRequested />);
    const main = await screen.findByRole("main");
    await settled();
    main.requestFullscreen = requestFullscreen;
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    fireEvent.click(main);
    await settled();
    fireEvent.pointerDown(main, {
      pointerId: 21,
      isPrimary: true,
      button: 0,
      clientX: 240,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 21, isPrimary: true, clientX: 100, clientY: 102 });
    await settled();
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(3);
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
    const answerHeading = screen.getByRole("heading", { name: "模範解答" });
    expect(answerHeading).toBeInTheDocument();
    expect(answerHeading.closest("[class*='answerReveal']")).toContainElement(
      screen.getByText("家族で旅行"),
    );
    expect(
      screen.getByTestId("presentation-natural-layer").querySelector("[class*='Motion']"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/秘密の回答者|秘密の参加者回答/)).not.toBeInTheDocument();
  });

  it("keeps every multiple-choice answer in an ordered list with its correct marker", async () => {
    setup({
      projection: {
        state: "answer",
        question: {
          id: 1,
          ordinal: 1,
          total: 5,
          question: "思い出の場所は？",
          choices: ["海", "山", "森"],
          correctIndex: 1,
        },
      },
    });
    render(<PresentationScreen />);

    expect(await screen.findByText("問")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "思い出の場所は？" })).toBeInTheDocument();
    const choices = screen.getByRole("list");
    expect(choices.tagName).toBe("OL");
    expect(within(choices).getAllByRole("listitem")).toHaveLength(3);
    expect(within(choices).getByText("海")).toBeInTheDocument();
    expect(within(choices).getByText("山")).toBeInTheDocument();
    expect(within(choices).getByText("森")).toBeInTheDocument();
    const correctChoice = within(choices).getAllByRole("listitem")[1]!;
    expect(within(correctChoice).getByText("正解")).toBeInTheDocument();
    expect(choices).not.toHaveAttribute("aria-hidden");
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
    expect(await screen.findByText("第三位")).toBeInTheDocument();
    expect(screen.getByText("12.50 ポイント")).toBeInTheDocument();
    expect(screen.getByText("葵", { exact: false })).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "第三位の勝者一覧" });
    expect(region).not.toHaveClass(/announce/);
    expect(region.querySelector("[class*='rankOrnament']")).toHaveAttribute("aria-hidden", "true");
    const medal = region.querySelector("[data-testid='presentation-exam-stamp']");
    expect(medal).toHaveAttribute("aria-hidden", "true");
    const reveal = region.querySelector("[class*='winnerReveal']");
    expect(reveal).toBeInTheDocument();
    expect(reveal).toHaveAttribute("data-reveal-eligible", "false");
    expect(reveal).toHaveTextContent("葵");
    expect(reveal).toHaveTextContent("12.50 ポイント");
    expect(reveal).not.toHaveAttribute("aria-hidden");
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
    const region = await screen.findByRole("region", { name: "第三位の勝者一覧" });
    expect(region.querySelectorAll("article")).toHaveLength(2);
    expect(within(region).getByText("葵", { exact: false })).toBeInTheDocument();
    expect(within(region).getByText("凛", { exact: false })).toBeInTheDocument();
    expect(within(region).queryByText("悠", { exact: false })).not.toBeInTheDocument();
    expect(within(region).queryByText("澪", { exact: false })).not.toBeInTheDocument();
    expect(within(region).getByText("ほか 2 名")).toHaveClass(/additionalWinners/);
    expect(region.querySelector("[class*='winnerReveal']")).toHaveAttribute(
      "data-reveal-eligible",
      "false",
    );
  });

  it("reveals a first-place tie together under one eligible group", async () => {
    setup({
      projection: {
        state: "first",
        winners: [
          { displayName: "花子", score: 15, rank: 1 },
          { displayName: "太郎", score: 15, rank: 1 },
          { displayName: "凛", score: 15, rank: 1 },
        ],
      },
      admin: { state: "first", questionIndex: 5, questionCount: 5 },
    });
    render(<PresentationScreen />);

    const region = await screen.findByRole("region", { name: "第一位の勝者一覧" });
    expect(region.querySelector("[class*='Motion']")).not.toBeInTheDocument();
    const reveal = region.querySelector("[class*='winnerReveal']");
    expect(reveal).toHaveAttribute("data-reveal-eligible", "true");
    expect(reveal?.querySelectorAll("article")).toHaveLength(2);
    expect(within(reveal as HTMLElement).getByText("花子", { exact: false })).toBeInTheDocument();
    expect(within(reveal as HTMLElement).getByText("太郎", { exact: false })).toBeInTheDocument();
    expect(within(reveal as HTMLElement).getByText("ほか 1 名")).toBeInTheDocument();
  });

  it("shows two cards for 24 shared-rank winners with paired names and scores", async () => {
    const winners = Array.from({ length: 24 }, (_, index) => ({
      displayName: `受賞者${String(index + 1).padStart(2, "0")}`,
      score: 12.5,
      rank: 3,
    }));
    setup({
      projection: { state: "third", winners },
      admin: { state: "third", questionIndex: 5, questionCount: 5 },
    });
    render(<PresentationScreen />);

    expect(await screen.findByRole("heading", { name: "第三位" })).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "第三位の勝者一覧" });
    const cards = Array.from(region.querySelectorAll("article"));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("受賞者01");
    expect(cards[0]).toHaveTextContent("12.50 ポイント");
    expect(cards[1]).toHaveTextContent("受賞者02");
    expect(cards[1]).toHaveTextContent("12.50 ポイント");
    expect(within(region).getByText("ほか 22 名")).toBeVisible();
    for (const hiddenWinner of winners.slice(2)) {
      expect(
        within(region).queryByText(hiddenWinner.displayName, { exact: false }),
      ).not.toBeInTheDocument();
    }
  });

  it("keeps compact rank answers private while preserving free text and score states", async () => {
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
    const region = await screen.findByRole("region", { name: "第三位の勝者一覧" });
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
    expect(screen.getByText("得点 0.00")).toBeInTheDocument();
    expect(screen.getByText("未採点")).toBeInTheDocument();
    expect(screen.getByText("0点の回答")).toBeInTheDocument();
    expect(screen.getByText("未採点の回答")).toBeInTheDocument();
    expect(screen.getByText("得点 0.25")).toBeInTheDocument();
    const savedFreeText = within(region).getByText("Q5").closest("li") as HTMLLIElement;
    expect(within(savedFreeText).getByText("保存された回答")).toBeInTheDocument();
    expect(within(savedFreeText).getByText("得点を確認できません")).toBeInTheDocument();
    const zeroScoreFreeText = within(region).getByText("Q6").closest("li") as HTMLLIElement;
    expect(within(zeroScoreFreeText).getByText("0点の回答")).toBeInTheDocument();
    expect(within(zeroScoreFreeText).getByText("得点 0.00")).toBeInTheDocument();
    const unscoredFreeText = within(region).getByText("Q7").closest("li") as HTMLLIElement;
    expect(within(unscoredFreeText).getByText("未採点の回答")).toBeInTheDocument();
    expect(within(unscoredFreeText).getByText("未採点")).toBeInTheDocument();
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
            ],
          },
          { displayName: "凛", score: 10, rank: 3 },
          { displayName: "悠", score: 9, rank: 3 },
        ],
      },
      admin: { state: "third", questionIndex: 5, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const region = await screen.findByRole("region", { name: "第三位の勝者一覧" });
    expect(within(region).getByRole("heading", { name: "第三位" })).toBeVisible();
    expect(within(region).getByText("葵", { exact: false })).toBeVisible();
    expect(within(region).getByText("12.50 ポイント")).toBeVisible();
    expect(within(region).getByText("凛", { exact: false })).toBeVisible();
    expect(within(region).getByText("10.00 ポイント")).toBeVisible();
    const answerRow = within(region).getByText("Q1").closest("li") as HTMLLIElement;
    expect(within(answerRow).getByText("○")).toBeVisible();
    expect(within(answerRow).getByLabelText("正解")).toBeVisible();
    expect(within(region).getByText("ほか 1 名")).toBeVisible();
    expect(region).not.toHaveClass(/announce/);
    expect(region.querySelector("[class*='rankOrnament']")).toHaveAttribute("aria-hidden", "true");
    const reveal = region.querySelector("[class*='winnerReveal']");
    expect(reveal).toHaveTextContent("葵");
    expect(reveal).toHaveTextContent("12.50 ポイント");
    expect(reveal).toHaveTextContent("ほか 1 名");
    expect(reveal).not.toHaveAttribute("aria-hidden");
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowLeft" });
    await settled();
    expect(region).not.toHaveClass(/announce/);
  });

  it("renders rank content immediately under reduced motion with decorative markup hidden from assistive technology", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => createMediaQueryList(true)),
    );
    const api = setup({
      projection: { state: "podium_preview" },
      admin: { state: "podium_preview", questionIndex: 5, questionCount: 5 },
    });
    api.setDeckSlide("third", 5, {
      state: "third",
      winners: [
        {
          displayName: "葵",
          score: 12.5,
          rank: 3,
          questionResults: [
            {
              position: 4,
              question: "自由記述",
              answer: { kind: "freeText", value: "保存された回答" },
              normalizedScore: 0.75,
            },
          ],
        },
        { displayName: "凛", score: 12.5, rank: 3 },
        { displayName: "悠", score: 12.5, rank: 3 },
      ],
    });
    render(<PresentationScreen presenterRequested />);
    await settled();
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });
    const region = await screen.findByRole("region", { name: "第三位の勝者一覧" });
    await settled();
    expect(region).not.toHaveClass(/announce/);
    expect(within(region).getByRole("heading", { name: "第三位" })).toBeInTheDocument();
    expect(within(region).getByText("葵", { exact: false })).toBeInTheDocument();
    expect(within(region).getAllByText("12.50 ポイント")).toHaveLength(2);
    expect(within(region).getByText("凛", { exact: false })).toBeInTheDocument();
    expect(within(region).getByText("ほか 1 名")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("第三位を発表します");
    expect(screen.getByRole("status")).not.toHaveTextContent("葵");
    const reveal = region.querySelector("[class*='winnerReveal']");
    expect(reveal).toBeInTheDocument();
    expect(reveal).toHaveTextContent("葵");
    expect(within(reveal as HTMLElement).getByText("保存された回答")).toBeVisible();
    expect(within(reveal as HTMLElement).getByText("得点 0.75")).toBeVisible();
    expect(region.querySelector("[class*='rankOrnament']")).toHaveAttribute("aria-hidden", "true");
  });

  it("does not write position when mutation is in flight during operate", async () => {
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
      admin: { state: "question", questionIndex: 1, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await actionStarted;
    fireEvent.keyDown(main, { key: "ArrowRight" });
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

  it("triggers admin refresh after timer during position conflict recovery", async () => {
    vi.useFakeTimers();
    let controlsReads = 0;
    const api = setup({
      actionStatuses: [409],
      controlsGetter: async () => {
        controlsReads += 1;
        return response({
          state: "question",
          version: 1,
          snapshotRevision: 1,
          questionIndex: 1,
          questionCount: 5,
          projectionHidden: false,
        });
      },
      admin: { state: "question", questionIndex: 1, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);

    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await settled();
    expect(controlsReads).toBeGreaterThanOrEqual(1);
  });

  it("does not retry position when unauthenticated after failure", async () => {
    vi.useFakeTimers();
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((r) => {
      releaseAction = r;
    });
    const api = setup({
      actionGate: () => actionGate,
      admin: { state: "question", questionIndex: 1, questionCount: 5 },
    });
    const view = render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();

    view.rerender(<PresentationScreen presenterRequested={false} />);
    await settled();

    await act(async () => {
      releaseAction();
      await Promise.resolve();
    });
    await settled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("ignores stale retry when generation changes", async () => {
    vi.useFakeTimers();
    const api = setup({
      actionStatuses: [503, 200],
      commitBeforeActionError: true,
      admin: { state: "question", questionIndex: 1, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("is no-op on retry when presenter is not requested or authenticated", async () => {
    vi.useFakeTimers();
    setup({
      actionStatus: 503,
      commitBeforeActionError: true,
      admin: { state: "question", questionIndex: 1, questionCount: 5 },
    });
    const view = render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();
    view.rerender(<PresentationScreen presenterRequested={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await settled();
  });

  it("does not nullify current controller in writer finally when controller was replaced", async () => {
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const api = setup({
      actionGate: () => {
        startedFirst();
        return firstGate;
      },
      admin: { state: "question", questionIndex: 1, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await firstStarted;
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await act(async () => {
      releaseFirst();
      await Promise.resolve();
    });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("coalesces a gesture during an in-flight position write into a single POST", async () => {
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const api = setup({
      actionGate: () => actionGate,
      admin: { state: "question", questionIndex: 1, questionCount: 5 },
    });
    render(<PresentationScreen presenterRequested />);
    const main = screen.getByRole("main");
    await settled();
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowRight" });
    await settled();

    fireEvent.pointerDown(main, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerUp(main, { pointerId: 1, isPrimary: true, clientX: 300, clientY: 100 });
    await settled();
    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(1);

    await act(async () => {
      releaseAction();
      await Promise.resolve();
    });
    await settled();
  });

  it("keeps progression inert while a refreshed revision has not loaded its deck", async () => {
    let controlsReads = 0;
    let deckReads = 0;
    let resolveRefreshedDeck!: (value: Response) => void;
    const refreshedDeck = new Promise<Response>((resolve) => {
      resolveRefreshedDeck = resolve;
    });
    const api = setup({
      admin: { state: "question", questionIndex: 0, questionCount: 5 },
      controlsGetter: async () => {
        controlsReads += 1;
        return response({
          state: "question",
          version: controlsReads,
          snapshotRevision: controlsReads === 1 ? 1 : 2,
          questionIndex: 0,
          questionCount: 5,
          projectionHidden: false,
        });
      },
      deckGetter: () => {
        deckReads += 1;
        return deckReads === 1
          ? Promise.resolve(
              response({
                snapshotRevision: 1,
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
                        question: "思い出の場所は？",
                        choices: ["海", "山"],
                      },
                    },
                  },
                  {
                    state: "answer",
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
                      },
                    },
                  },
                ],
              }),
            )
          : refreshedDeck;
      },
    });
    render(<PresentationScreen presenterRequested />);
    await settled();

    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(deckReads).toBe(2));
    fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowRight" });

    expect(
      api.calls.filter(
        ({ path, init }) => path === "/api/admin/presentation" && init?.method === "POST",
      ),
    ).toHaveLength(0);

    resolveRefreshedDeck(
      response({
        snapshotRevision: 2,
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
                question: "思い出の場所は？",
                choices: ["海", "山"],
              },
            },
          },
          {
            state: "answer",
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
              },
            },
          },
        ],
      }),
    );
    await settled();
  });
});
