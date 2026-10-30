import { test, expect } from "./fixtures/test";
import { e2eAdminPin } from "./fixtures/admin-auth";
import { expectNoAccessibilityViolations } from "./axe";

declare global {
  interface Window {
    __fullscreenRequests: number;
    __wakeRequests: number[];
    __releaseWakeLock: () => void;
    __rankRevealAnimations: {
      rank: string | null;
      name: string;
      identity?: number;
      startTime?: number | null;
      currentTime?: number | null;
    }[];
    __rankAnimationIdentity: (animation: Animation) => number;
    __rankAnimationTimeline: {
      kind: "start" | "end";
      rank: string | null;
      name: string;
      timestamp: number;
      identity: number;
      startTime: number | null;
      currentTime: number | null;
    }[];
    __answerRevealAnimations: {
      group: string;
      name: string;
      targetId?: number;
      isConnected?: boolean;
      questionId?: string | null;
      questionText?: string;
      timestamp?: number;
      stage?: string;
      className?: string;
      data?: Record<string, string | undefined>;
      style?: {
        inline: string | null;
        animationName: string;
        animationDelay: string;
        animationDuration: string;
        animationPlayState: string;
        opacity: string;
      };
    }[];
    __answerRevealAnimationEnds: { group: string; name: string }[];
    __pauseAnswerRevealAtStart: boolean;
    __answerRevealNodeIdentity: (node: Node) => number;
  }

  interface Document {
    __exitTestFullscreen: () => void;
  }
}

type PresentationState =
  | "not_started"
  | "opening"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "first_prize"
  | "finished";

type E2EWinnerQuestionResult = {
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
};

type E2EWinnerEntry = {
  displayName: string;
  score: number;
  rank: number;
  questionResults?: E2EWinnerQuestionResult[];
};

type PresentationQuestionFixture = {
  id: number;
  question: string;
  choices: string[];
  correctAnswer: string;
  explanation: string;
  answerType?: "selected" | "freeText";
  expectedAnswer?: string;
  responses?: {
    displayName: string;
    answer?: string | null;
    answerKind: "selected" | "freeText" | "legacy" | "unanswered";
    similarity: number | null;
    score: number | null;
  }[];
};

const questions: PresentationQuestionFixture[] = [
  {
    id: 11,
    question: "ふたりが初めて出会った場所は？",
    choices: ["カフェ", "大学", "駅"],
    correctAnswer: "大学",
    explanation: "共通の友人が開いた集まりで出会いました。",
  },
];

async function installAdminApiMock(
  page: import("@playwright/test").Page,
  options: {
    fullscreenSupported?: boolean;
    questionCount?: number;
    question?: PresentationQuestionFixture;
    skipEmptyRanks?: boolean;
  } = {},
) {
  const questionCount = options.questionCount ?? questions.length;
  const presentationQuestion = options.question ?? questions[0];
  if (!options.fullscreenSupported) {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "requestFullscreen", {
        configurable: true,
        value: undefined,
      });
    });
  }
  let authenticated = false;
  let state: PresentationState = "not_started";
  let stageCursor = 0;
  let questionIndex = 0;
  let version = 0;
  let projectionHidden = false;
  let snapshotExists = false;
  let participantResultsVisible = false;
  let winnerEntries: E2EWinnerEntry[] = [
    { displayName: "花子", score: 1, rank: 1 },
    { displayName: "太郎", score: 0, rank: 2 },
  ];
  let snapshotRevision = 0;
  let pauseNextMutation = false;
  let releasePausedMutation: (() => void) | null = null;
  let pausedMutationStarted: (() => void) | null = null;
  let holdNextProjection = false;
  let releaseHeldProjection: (() => void) | null = null;
  let heldProjectionStarted: (() => void) | null = null;
  let successfulParticipantResultsPublished = false;
  let pauseNextParticipantResultsMutation = false;
  let releasePausedParticipantResultsMutation: (() => void) | null = null;
  let participantResultsMutationStarted: (() => void) | null = null;
  const actions: string[] = [];
  const positionLog: { state: PresentationState; questionIndex: number }[] = [];
  const participantResultsMutations: boolean[] = [];
  const participantResultsStageSnapshots: PresentationState[] = [];
  const presentationRouteEvents: string[] = [];
  const stages = () =>
    [
      "not_started",
      "opening",
      ...(questionCount === 0 ? [] : (["question", "answer"] as const)),
      "podium_preview",
      ...(options.skipEmptyRanks && !winnerEntries.some((entry) => entry.rank === 3)
        ? []
        : (["third"] as const)),
      ...(options.skipEmptyRanks && !winnerEntries.some((entry) => entry.rank === 2)
        ? []
        : (["second"] as const)),
      ...(options.skipEmptyRanks && !winnerEntries.some((entry) => entry.rank === 1)
        ? []
        : (["first"] as const)),
      ...(winnerEntries.some((entry) => entry.rank === 1) ? (["first_prize"] as const) : []),
      "finished",
    ] as PresentationState[];

  const payload = () => ({
    state,
    version,
    snapshotRevision,
    questionIndex,
    questionCount,
    questions: questionCount === 0 ? [] : [presentationQuestion],
    entries: winnerEntries,
    projectionHidden,
    participantResultsVisible,
    participantResultsReady: snapshotExists,
  });
  const controlsPayload = () => ({
    state,
    version,
    snapshotRevision,
    questionIndex,
    questionCount,
    projectionHidden,
  });
  const deck = () => ({
    snapshotRevision,
    slides: stages()
      .filter((slideState) => slideState !== "not_started")
      .map((slideState) => {
        let projection: Record<string, unknown>;
        if (slideState === "question" || slideState === "answer") {
          projection = {
            state: slideState,
            question: {
              id: 11,
              ordinal: 1,
              total: 1,
              question: presentationQuestion.question,
              choices: presentationQuestion.choices,
              ...(slideState === "answer"
                ? {
                    correctAnswer: presentationQuestion.correctAnswer,
                    correctIndex: presentationQuestion.choices.indexOf(
                      presentationQuestion.correctAnswer,
                    ),
                    explanation: presentationQuestion.explanation,
                    ...(presentationQuestion.answerType
                      ? { answerType: presentationQuestion.answerType }
                      : {}),
                    ...(presentationQuestion.expectedAnswer !== undefined
                      ? { expectedAnswer: presentationQuestion.expectedAnswer }
                      : {}),
                    ...(presentationQuestion.responses !== undefined
                      ? { responses: presentationQuestion.responses }
                      : {}),
                  }
                : {}),
            },
          };
        } else if (slideState === "third" || slideState === "second" || slideState === "first") {
          const rank = slideState === "third" ? 3 : slideState === "second" ? 2 : 1;
          projection = {
            state: slideState,
            winners: winnerEntries
              .filter((entry) => entry.rank === rank)
              .map(({ displayName, score, rank: winnerRank, questionResults }) => ({
                displayName,
                score,
                rank: winnerRank,
                ...(questionResults ? { questionResults } : {}),
              })),
          };
        } else {
          projection = { state: slideState };
        }
        return { state: slideState, questionIndex: 0, projection };
      }),
  });

  const context = page.context();
  return context
    .route("**/api/admin/session", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { authenticated } });
        return;
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { pin?: string };
        authenticated = body.pin === e2eAdminPin;
        if (!authenticated) {
          await route.fulfill({ status: 401, json: { authenticated } });
          return;
        }
        await route.fallback();
        return;
      }
      if (route.request().method() === "DELETE") {
        authenticated = false;
        await route.fulfill({ json: { authenticated } });
        return;
      }
      await route.fulfill({ status: 405, json: { error: "Method not allowed" } });
    })
    .then(() =>
      context.route("**/api/admin/presentation/deck", async (route) => {
        presentationRouteEvents.push(`deck:get:${snapshotRevision}:${state}`);
        await route.fulfill({ json: deck() });
      }),
    )
    .then(() =>
      context.route(
        (url) => url.pathname === "/api/admin/presentation",
        async (route) => {
          if (route.request().method() === "GET") {
            if (!authenticated) {
              await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
              return;
            }
            if (new URL(route.request().url()).searchParams.get("view") === "controls") {
              presentationRouteEvents.push("controls:get");
              presentationRouteEvents.push("controls:get:200");
              await route.fulfill({ json: controlsPayload() });
              return;
            }
            await route.fulfill({ json: payload() });
            return;
          }
          const body = route.request().postDataJSON() as {
            operationId?: string;
            action?: string;
            expectedSnapshotRevision?: number;
            expectedSessionVersion?: number;
            state?: PresentationState;
            questionIndex?: number;
          };
          if (!authenticated || !body.operationId) {
            await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
            return;
          }
          if (
            body.expectedSnapshotRevision !== undefined &&
            body.expectedSnapshotRevision !== snapshotRevision
          ) {
            await route.fulfill({
              status: 409,
              json: { error: "Presentation snapshot changed concurrently" },
            });
            return;
          }
          if (body.action === "position" && body.expectedSessionVersion !== version) {
            await route.fulfill({
              status: 409,
              json: { error: "Presentation session version changed concurrently" },
            });
            return;
          }
          actions.push(body.action ?? "");
          if (pauseNextMutation) {
            pauseNextMutation = false;
            pausedMutationStarted?.();
            await new Promise<void>((resolve) => {
              releasePausedMutation = resolve;
            });
            releasePausedMutation = null;
          }
          if (body.action === "aggregate") {
            snapshotExists = true;
            snapshotRevision += 1;
          } else if (body.action === "reset" && state !== "not_started") {
            stageCursor = 1;
            state = stages()[stageCursor];
          } else if (body.action === "start" && state === "not_started" && snapshotExists) {
            stageCursor = 1;
            state = stages()[stageCursor];
          } else if (body.action === "position") {
            if (
              body.state &&
              Number.isInteger(body.questionIndex) &&
              stages().includes(body.state)
            ) {
              state = body.state;
              questionIndex = body.questionIndex as number;
              stageCursor = stages().indexOf(state);
              positionLog.push({ state, questionIndex });
            }
          } else if (body.action === "hide") projectionHidden = true;
          else if (body.action === "show") projectionHidden = false;
          version += 1;
          await route.fulfill({ json: controlsPayload() });
        },
      ),
    )
    .then(() =>
      context.route("**/api/presentation", async (route) => {
        let projection: Record<string, unknown>;
        if (projectionHidden) {
          projection = { state: "standby" };
        } else if (state === "question" || state === "answer") {
          projection = {
            state,
            question: {
              id: 11,
              ordinal: 1,
              total: 1,
              question:
                snapshotRevision > 1
                  ? `${presentationQuestion.question}（snapshot ${snapshotRevision}）`
                  : presentationQuestion.question,
              choices: presentationQuestion.choices,
              ...(state === "answer"
                ? {
                    correctAnswer: presentationQuestion.correctAnswer,
                    correctIndex: presentationQuestion.choices.indexOf(
                      presentationQuestion.correctAnswer,
                    ),
                    explanation: presentationQuestion.explanation,
                  }
                : {}),
            },
          };
        } else if (state === "third" || state === "second" || state === "first") {
          const rank = state === "third" ? 3 : state === "second" ? 2 : 1;
          projection = {
            state,
            winners: payload()
              .entries.filter((entry) => entry.rank === rank)
              .map(({ displayName, score, rank: winnerRank, questionResults }) => ({
                displayName,
                score,
                rank: winnerRank,
                ...(questionResults ? { questionResults } : {}),
              })),
          };
        } else {
          projection = { state };
        }
        presentationRouteEvents.push(`projection:get:${state}`);
        if (successfulParticipantResultsPublished) {
          presentationRouteEvents.push(`projection:get:after-results-publish:${state}`);
        }
        if (holdNextProjection) {
          holdNextProjection = false;
          heldProjectionStarted?.();
          await new Promise<void>((resolve) => {
            releaseHeldProjection = resolve;
          });
          releaseHeldProjection = null;
        }
        await route.fulfill({ json: projection });
      }),
    )
    .then(() =>
      context.route("**/api/admin/participant-results", async (route) => {
        const body = route.request().postDataJSON() as { visible?: unknown };
        if (!authenticated) {
          await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
          return;
        }
        if (typeof body.visible !== "boolean") {
          await route.fulfill({ status: 400, json: { error: "Invalid request" } });
          return;
        }
        participantResultsStageSnapshots.push(state);
        if (pauseNextParticipantResultsMutation) {
          pauseNextParticipantResultsMutation = false;
          participantResultsMutationStarted?.();
          await new Promise<void>((resolve) => {
            releasePausedParticipantResultsMutation = resolve;
          });
          releasePausedParticipantResultsMutation = null;
        }
        if (body.visible && !snapshotExists) {
          await route.fulfill({ status: 409, json: { error: "Results are not ready" } });
          return;
        }
        participantResultsVisible = body.visible;
        participantResultsMutations.push(body.visible);
        if (body.visible) successfulParticipantResultsPublished = true;
        await route.fulfill({ json: { visible: participantResultsVisible } });
      }),
    )
    .then(() => ({
      advanceSnapshotRevision: () => {
        snapshotRevision += 1;
        version += 1;
      },
      pauseNextMutation: () => {
        pauseNextMutation = true;
        return new Promise<void>((resolve) => {
          pausedMutationStarted = resolve;
        });
      },
      releasePausedMutation: () => releasePausedMutation?.(),
      holdNextProjection: () => {
        holdNextProjection = true;
        return new Promise<void>((resolve) => {
          heldProjectionStarted = resolve;
        });
      },
      releaseHeldProjection: () => releaseHeldProjection?.(),
      actionLog: actions,
      positionLog,
      setWinnerEntries: (entries: typeof winnerEntries) => {
        winnerEntries = entries;
      },
      setPresentationPosition: (nextState: PresentationState) => {
        state = nextState;
        questionIndex = 0;
        stageCursor = stages().indexOf(nextState);
        version += 1;
      },
      getPresentationState: () => ({ state, questionIndex, version, projectionHidden }),
      getSnapshotRevision: () => snapshotRevision,
      participantResultsMutations,
      participantResultsStageSnapshots,
      getPresentationRouteEvents: () => presentationRouteEvents,
      pauseNextResultsMutation: () => {
        pauseNextParticipantResultsMutation = true;
        return new Promise<void>((resolve) => {
          participantResultsMutationStarted = resolve;
        });
      },
      releasePausedResultsMutation: () => releasePausedParticipantResultsMutation?.(),
    }));
}

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill(e2eAdminPin);
  await page.getByRole("button", { name: "管理ページにログイン" }).click();
  await expect(page.getByText(/現在の状態：/)).toBeVisible();
}

async function startPresentation(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "集計" }).click();
  await expect(page.getByText(/集計済み/)).toBeVisible();
  await page.getByRole("button", { name: "発表を開始" }).click();
  await expect(page.getByText("現在の状態：進行中：オープニング")).toBeVisible();
  const positionResponse = await page.evaluate(async () => {
    const controlsResponse = await fetch("/api/admin/presentation?view=controls");
    if (!controlsResponse.ok) {
      throw new Error(`Presentation controls request failed: ${controlsResponse.status}`);
    }
    const controls = (await controlsResponse.json()) as {
      version: number;
      snapshotRevision: number;
    };
    const response = await fetch("/api/admin/presentation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        action: "position",
        state: "question",
        questionIndex: 0,
        expectedSnapshotRevision: controls.snapshotRevision,
        expectedSessionVersion: controls.version,
      }),
    });
    return { ok: response.ok, status: response.status };
  });
  expect(positionResponse.ok, `Position request failed: ${positionResponse.status}`).toBe(true);
  await expect(page.getByText("現在の状態：進行中：問題")).toBeVisible();
}

async function openPresenter(page: import("@playwright/test").Page) {
  const controlsResponse = nextAdminRefresh(page);
  const deckResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/presentation/deck" &&
      response.request().method() === "GET",
  );
  await page.goto("/presentation?presenter=1");
  await Promise.all([controlsResponse, deckResponse]);
  await expect(page.getByTestId("presentation-canvas")).toBeVisible();
  await waitForRenderFrames(page);
}

async function waitForRenderFrames(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function waitForCurrentPresentationEntryAnimations(page: import("@playwright/test").Page) {
  const result = await page.evaluate(async () => {
    const openingTitle = document.querySelector<HTMLElement>(
      "[class*='openingMotion'] [class*='openingTitle']",
    );
    const questionHeading = document.querySelector<HTMLElement>("#question-heading");
    const podiumTitle = document.querySelector<HTMLElement>("#podium-title");
    const finishedTitle = document.querySelector<HTMLElement>("#finished-title");
    let targets: HTMLElement[] = [];
    let animationName = "presentationEntry";

    if (openingTitle) {
      targets = [openingTitle];
      animationName = "openingTitleEntry";
    } else if (questionHeading?.nextElementSibling instanceof HTMLOListElement) {
      targets = [
        questionHeading.previousElementSibling,
        questionHeading,
        ...Array.from(questionHeading.nextElementSibling.querySelectorAll("li")),
      ].filter((element): element is HTMLElement => element instanceof HTMLElement);
    } else if (podiumTitle) {
      targets = [podiumTitle, podiumTitle.nextElementSibling].filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
    } else if (finishedTitle) {
      targets = [finishedTitle, finishedTitle.nextElementSibling].filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
    }

    const animations = targets.flatMap((target) => {
      const matches = target
        .getAnimations()
        .filter((animation) => (animation as CSSAnimation).animationName.endsWith(animationName));
      if (matches.length !== 1) {
        throw new Error(`Expected one ${animationName} animation on ${target.tagName}`);
      }
      const endTime = matches[0]?.effect?.getComputedTiming().endTime;
      if (typeof endTime !== "number" || !Number.isFinite(endTime) || endTime <= 0) {
        throw new Error(`Expected a finite ${animationName} animation`);
      }
      return matches;
    });
    await Promise.all(animations.map((animation) => animation.finished));
    return {
      targetCount: targets.length,
      animationCount: animations.length,
      finishedCount: animations.filter((animation) => animation.playState === "finished").length,
    };
  });
  expect(result.targetCount).toBeGreaterThan(0);
  expect(result.animationCount).toBe(result.targetCount);
  expect(result.finishedCount).toBe(result.animationCount);
}

function nextAdminRefresh(page: import("@playwright/test").Page) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/presentation" &&
      new URL(response.url()).searchParams.get("view") === "controls" &&
      response.request().method() === "GET",
  );
}

function nextAdminMutation(page: import("@playwright/test").Page) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/presentation" &&
      response.request().method() === "POST",
  );
}

function slideFor(page: import("@playwright/test").Page, state: PresentationState) {
  switch (state) {
    case "opening":
      return page.getByRole("heading", { name: /^しゅんたま\s*検定$/ });
    case "question":
      return page.getByRole("heading", { name: questions[0].question });
    case "answer":
      return page.locator("[class*='answerReview']");
    case "podium_preview":
      return page.getByRole("heading", { name: "いよいよ、結果発表です" });
    case "third":
      return page.getByRole("region", { name: "第三位の勝者一覧" });
    case "second":
      return page.getByRole("region", { name: "第二位の勝者一覧" });
    case "first":
      return page.getByRole("region", { name: "第一位の勝者一覧" });
    case "first_prize":
      return page.getByRole("heading", { name: "和牛カタログ" });
    case "finished":
      return page.getByRole("heading", { name: /ご参加.*ありがとうございました/ });
    default:
      throw new Error(`No projection slide locator for ${state}`);
  }
}

function entryFor(page: import("@playwright/test").Page, state: PresentationState) {
  switch (state) {
    case "opening":
      return page.locator("[class*='openingMotion'] [class*='openingTitle']");
    case "question":
      return page.locator("#question-heading");
    case "podium_preview":
      return page.locator("#podium-title");
    case "finished":
      return page.locator("#finished-title");
    default:
      throw new Error(`No generic entrance target for ${state}`);
  }
}

async function inspectEntryAnimation(
  target: import("@playwright/test").Locator,
  animationName = "presentationEntry",
) {
  return target.evaluate((element, expectedAnimationName) => {
    const style = getComputedStyle(element);
    const animation = element
      .getAnimations()
      .find((candidate) =>
        (candidate as CSSAnimation).animationName.endsWith(expectedAnimationName),
      );
    animation?.pause();
    if (animation) animation.currentTime = 0;
    const frames =
      animation?.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
    const first = frames[0];
    const last = frames.at(-1);
    const matrixFor = (transform: unknown) =>
      new DOMMatrixReadOnly(typeof transform === "string" ? transform : "none").m42;
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      animationFillMode: style.animationFillMode,
      firstOpacity: first?.opacity,
      firstTranslateY: matrixFor(first?.transform),
      lastOpacity: last?.opacity,
      lastTranslateY: matrixFor(last?.transform),
    };
  }, animationName);
}

async function expectPresentationEntryAnimation(
  target: import("@playwright/test").Locator,
  state: PresentationState,
) {
  const isOpening = state === "opening";
  const animation = await inspectEntryAnimation(
    target,
    isOpening ? "openingTitleEntry" : "presentationEntry",
  );
  const durationMs = Number.parseFloat(animation.animationDuration);
  const durationInMs = animation.animationDuration.endsWith("ms") ? durationMs : durationMs * 1000;
  expect(animation.animationName).toMatch(isOpening ? /openingTitleEntry$/ : /presentationEntry$/);
  expect(durationInMs).toBeGreaterThan(0);
  expect(durationInMs).toBeLessThanOrEqual(400);
  expect(animation.animationFillMode).toBe("both");
  expect(Number(animation.firstOpacity)).toBe(0);
  expect(Number(animation.lastOpacity)).toBe(1);
  if (isOpening) {
    expect(animation.firstTranslateY).toBe(0);
    expect(animation.lastTranslateY).toBe(0);
  } else {
    expect(animation.firstTranslateY).toBe(-12);
    expect(animation.lastTranslateY).toBe(0);
  }
}

async function advancePresenterTo(page: import("@playwright/test").Page, state: PresentationState) {
  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, state)).toBeVisible();
  await mutation;
}

function rankRegionFor(page: import("@playwright/test").Page, rank: "third" | "second" | "first") {
  return page
    .getByTestId("presentation-canvas")
    .locator(`section[class*="winners"][data-rank="${rank}"]:visible`);
}

async function expectRankAnticipation(
  region: import("@playwright/test").Locator,
  context: string,
  eligible: boolean,
  motion: "normal" | "reduced" = "normal",
) {
  const reveal = region.locator("[class*='winnerReveal']");
  await expect(reveal, context).toHaveAttribute("data-reveal-eligible", String(eligible));
  await expect(region.locator("[class*='rankHalo']"), context).toHaveCount(0);
  const state = await reveal.evaluate((element) => ({
    hiddenFromAccessibility: element.getAttribute("aria-hidden") !== "true",
    beforeAnimation: getComputedStyle(element, "::before").animationName,
    afterAnimation: getComputedStyle(element, "::after").animationName,
    beforeContent: getComputedStyle(element, "::before").content,
    afterContent: getComputedStyle(element, "::after").content,
    text: element.textContent?.trim() ?? "",
  }));
  expect(state.hiddenFromAccessibility, `${context}: winner content remains accessible`).toBe(true);
  expect(state.text, `${context}: winner content remains present`).not.toBe("");
  expect(state.beforeContent, `${context}: before decoration is empty CSS content`).toBe('""');
  expect(state.afterContent, `${context}: after decoration is empty CSS content`).toBe('""');
  const expectedAnimation = eligible && motion === "normal" ? "rankRevealAnticipation" : null;
  if (expectedAnimation) {
    expect(state.beforeAnimation, `${context}: before decoration eligibility`).toContain(
      expectedAnimation,
    );
    expect(state.afterAnimation, `${context}: after decoration eligibility`).toContain(
      expectedAnimation,
    );
  } else {
    expect(state.beforeAnimation, `${context}: before decoration eligibility`).toBe("none");
    expect(state.afterAnimation, `${context}: after decoration eligibility`).toBe("none");
  }
  return reveal;
}

async function advanceTo(page: import("@playwright/test").Page, target: PresentationState) {
  const stages: PresentationState[] = [
    "question",
    "answer",
    "podium_preview",
    "third",
    "second",
    "first",
    "first_prize",
    "finished",
  ];
  const targetIndex = stages.indexOf(target);
  if (targetIndex < 0) throw new Error(`Invalid projection target: ${target}`);
  await expect(slideFor(page, "question")).toBeVisible();
  for (let index = 0; index < targetIndex; index += 1) {
    const adminRefresh = nextAdminMutation(page);
    await page.locator("main").press("ArrowRight");
    await expect(slideFor(page, stages[index + 1])).toBeVisible();
    await adminRefresh;
    await waitForRenderFrames(page);
  }
  await expect(slideFor(page, target)).toBeVisible();
}

async function installAnswerRevealAnimationProbe(
  page: import("@playwright/test").Page,
  expectedQuestionId: number | string,
) {
  await page.addInitScript((expectedQuestionId) => {
    window.__answerRevealAnimations = [];
    window.__answerRevealAnimationEnds = [];
    window.__pauseAnswerRevealAtStart = true;
    const targetIds = new WeakMap<Node, number>();
    let nextTargetId = 1;
    window.__answerRevealNodeIdentity = (node) => {
      let targetId = targetIds.get(node);
      if (targetId === undefined) {
        targetId = nextTargetId++;
        targetIds.set(node, targetId);
      }
      return targetId;
    };
    const answerRevealGroup = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return null;
      return target.matches("[class*='answerReveal']")
        ? "answer"
        : target.matches("[class*='answerSupplement']")
          ? "supplement"
          : null;
    };
    document.addEventListener(
      "animationstart",
      (event) => {
        const group = answerRevealGroup(event.target);
        if (!group) return;
        if (window.__pauseAnswerRevealAtStart && event.target instanceof HTMLElement) {
          for (const animation of event.target.getAnimations()) {
            animation.pause();
            animation.currentTime = 0;
          }
        }
        const element = event.target as HTMLElement;
        const targetId = window.__answerRevealNodeIdentity(element);
        const question = element.closest<HTMLElement>("[class*='answerReview']");
        const computedStyle = getComputedStyle(element);
        window.__answerRevealAnimations.push({
          group,
          name: (event as AnimationEvent).animationName,
          targetId,
          isConnected: element.isConnected,
          questionId:
            question?.getAttribute("data-question-id") ??
            question?.querySelector<HTMLElement>("[data-question-id]")?.dataset.questionId ??
            String(expectedQuestionId),
          questionText: question?.querySelector("h1")?.textContent?.trim() ?? "",
          timestamp: performance.now(),
          stage: question ? "answer" : "unknown",
          className: element.className,
          data: { ...element.dataset },
          style: {
            inline: element.getAttribute("style"),
            animationName: computedStyle.animationName,
            animationDelay: computedStyle.animationDelay,
            animationDuration: computedStyle.animationDuration,
            animationPlayState: computedStyle.animationPlayState,
            opacity: computedStyle.opacity,
          },
        });
      },
      true,
    );
    document.addEventListener(
      "animationend",
      (event) => {
        const group = answerRevealGroup(event.target);
        if (!group) return;
        window.__answerRevealAnimationEnds.push({
          group,
          name: (event as AnimationEvent).animationName,
        });
      },
      true,
    );
  }, expectedQuestionId);
}

async function expectAnswerRevealFitDuringAndAfter(
  page: import("@playwright/test").Page,
  entryStartIndex: number,
) {
  const answer = page.locator("[class*='answerReview'] [class*='answerReveal']");
  const supplement = page.locator("[class*='answerSupplement']");
  const endCountBefore = await page.evaluate(() => window.__answerRevealAnimationEnds.length);
  await expect
    .poll(() => page.evaluate(() => window.__answerRevealAnimations.length))
    .toBe(entryStartIndex + 2);
  await expect
    .poll(() => answer.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe("paused");
  await expect
    .poll(() => supplement.evaluate((element) => element.getAnimations()[0]?.playState))
    .toBe("paused");
  await expect(answer).toHaveCSS("animation-delay", "0.1s");
  await expect(answer).toHaveCSS("animation-duration", "0.35s");
  await expect(supplement).toHaveCSS("animation-delay", "0.35s");
  await expect(supplement).toHaveCSS("animation-duration", "0.3s");
  await expect(answer).toHaveCSS("opacity", "0");
  await expect(supplement).toHaveCSS("opacity", "0");
  const answerCurrentTime = await answer.evaluate(
    (element) => element.getAnimations()[0]?.currentTime,
  );
  expect(answerCurrentTime).not.toBeNull();
  expect(answerCurrentTime).toBe(0);
  const supplementCurrentTime = await supplement.evaluate(
    (element) => element.getAnimations()[0]?.currentTime,
  );
  expect(supplementCurrentTime).not.toBeNull();
  expect(supplementCurrentTime).toBe(0);

  const inspectFit = async () =>
    page.getByTestId("presentation-fit-viewport").evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect();
      const fitLayer = document.querySelector<HTMLElement>(
        "[data-testid='presentation-fit-layer']",
      );
      const naturalLayer = document.querySelector<HTMLElement>(
        "[data-testid='presentation-natural-layer']",
      );
      const content = viewport.querySelector<HTMLElement>("[class*='answerReview']");
      const outOfBounds = Array.from(viewport.querySelectorAll("*"))
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .filter(
          (rect) =>
            rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1 ||
            rect.top < bounds.top - 1 ||
            rect.bottom > bounds.bottom + 1,
        ).length;
      return {
        scale: Number(fitLayer?.style.getPropertyValue("--presentation-fit-scale")),
        fitReady: naturalLayer?.dataset.fitReady,
        outOfBounds,
        contentHasNaturalArea: Boolean(
          content && content.offsetWidth > 0 && content.offsetHeight > 0,
        ),
        contentCanScroll: Boolean(
          content &&
          (content.scrollHeight > content.clientHeight + 1 ||
            content.scrollWidth > content.clientWidth + 1),
        ),
        pageCanScroll: document.documentElement.scrollHeight > innerHeight,
      };
    });
  const during = await inspectFit();
  const assertFit = (geometry: Awaited<ReturnType<typeof inspectFit>>) => {
    expect(geometry.fitReady).toBe("true");
    expect(geometry.scale).toBeGreaterThan(0);
    expect(geometry.scale).toBeLessThanOrEqual(1);
    expect(geometry.outOfBounds).toBe(0);
    expect(geometry.contentHasNaturalArea).toBe(true);
    expect(geometry.contentCanScroll).toBe(false);
    expect(geometry.pageCanScroll).toBe(false);
  };
  assertFit(during);

  await page.evaluate(() => {
    window.__pauseAnswerRevealAtStart = false;
    for (const selector of ["[class*='answerReveal']", "[class*='answerSupplement']"])
      document
        .querySelector<HTMLElement>(selector)
        ?.getAnimations()
        .forEach((animation) => animation.play());
  });
  await expect
    .poll(() => page.evaluate(() => window.__answerRevealAnimationEnds.length))
    .toBe(endCountBefore + 2);
  expect(
    await page.evaluate(() =>
      window.__answerRevealAnimationEnds.slice(-2).map(({ group }) => group),
    ),
  ).toEqual(["answer", "supplement"]);
  await expect(answer).toHaveCSS("opacity", "1");
  await expect(supplement).toHaveCSS("opacity", "1");
  const after = await inspectFit();
  assertFit(after);
  expect(after.scale).toBeCloseTo(during.scale, 5);
  return { during, after };
}

test("@chromium presenter keyboard progression ignores keys from nested interactive controls", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);

  const fullscreenButton = page.locator("main").getByRole("button", { name: "全画面表示" });
  await expect(fullscreenButton).toBeVisible();
  for (const key of ["ArrowRight", "ArrowLeft", "Enter", "Space"] as const) {
    await fullscreenButton.press(key);
    await expect(slideFor(page, "question")).toBeVisible();
    expect(mock.actionLog).toEqual(["aggregate", "start", "position"]);
  }

  let mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "answer")).toBeVisible();
  await mutation;

  mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "question")).toBeVisible();
  await mutation;

  mutation = nextAdminMutation(page);
  await page.locator("main").press("Enter");
  await expect(slideFor(page, "answer")).toBeVisible();
  await mutation;
  expect(mock.actionLog).toEqual([
    "aggregate",
    "start",
    "position",
    "position",
    "position",
    "position",
  ]);
});

test("@chromium admin opens or reuses a named presenter tab after start without fullscreen", async ({
  page,
}) => {
  await installAdminApiMock(page, { fullscreenSupported: true });
  await signIn(page);
  await page.reload();
  await expect(page.getByText("現在の状態：未開始")).toBeVisible();
  await startPresentation(page);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "投影画面を開く / 投影タブへ戻る" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/presentation\?presenter=1$/);
  await expect(popup.getByRole("heading", { name: questions[0].question })).toBeVisible();
  await page.getByRole("button", { name: "投影画面を開く / 投影タブへ戻る" }).click();
  await expect.poll(() => page.context().pages().length).toBe(2);
  expect(popup.isClosed()).toBe(false);
  await expect(popup).toHaveURL(/\/presentation\?presenter=1$/);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test("@chromium generic slide entrances honor their stage", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  await signIn(page);
  mock.setPresentationPosition("opening");
  await openPresenter(page);

  const naturalLayer = page.getByTestId("presentation-natural-layer");
  const normalMotionStages: PresentationState[] = [
    "opening",
    "question",
    "podium_preview",
    "finished",
  ];
  for (const state of normalMotionStages) {
    await expect(slideFor(page, state)).toBeVisible();
    await expectPresentationEntryAnimation(entryFor(page, state), state);
    const presenceEntry = naturalLayer.locator(":scope > div > div");
    await expect(presenceEntry).toHaveCSS("opacity", "1");
    const liveRegions = page.locator('main [aria-live="polite"]');
    await expect(liveRegions).toHaveCount(1);
    await expect(naturalLayer.locator('[aria-live="polite"]')).toHaveCount(0);
    if (state === "question") {
      const firstChoice = page.locator("#question-heading + ol li").first();
      expect(
        await firstChoice.evaluate((element) => getComputedStyle(element).animationName),
      ).toMatch(/presentationEntry$/);
      const delay = await firstChoice.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).animationDelay),
      );
      expect(delay).toBeGreaterThan(0);
    }
    if (state !== "finished") {
      const nextState: PresentationState =
        state === "opening"
          ? "question"
          : state === "question"
            ? "answer"
            : state === "podium_preview"
              ? "third"
              : state === "first"
                ? "first_prize"
                : state === "first_prize"
                  ? "finished"
                  : "finished";
      await advancePresenterTo(page, nextState);
      if (nextState === "answer") {
        const answerReveal = page.locator("[class*='answerReveal']");
        await expect(answerReveal).toHaveCSS("animation-name", /answerRevealFade/);
        await expect(naturalLayer.locator(":scope > div > div")).toHaveCSS("opacity", "1");
        await advancePresenterTo(page, "podium_preview");
        await expect(naturalLayer.locator(":scope > div > div")).toHaveCSS("opacity", "1");
      }
      if (nextState === "third") {
        await expectRankAnticipation(
          rankRegionFor(page, "third"),
          "rank ceremony coexists with the Motion slide wrapper",
          false,
        );
        await expect(naturalLayer.locator(":scope > div > div")).toHaveCSS("opacity", "1");
      }
      if (nextState === "third") {
        await advancePresenterTo(page, "second");
        await advancePresenterTo(page, "first");
        await expectRankAnticipation(
          rankRegionFor(page, "first"),
          "first-place ceremony coexists with the Motion slide wrapper",
          true,
        );
        await expect(naturalLayer.locator(":scope > div > div")).toHaveCSS("opacity", "1");
        await advancePresenterTo(page, "first_prize");
        await advancePresenterTo(page, "finished");
      }
    }
  }
});

test("@chromium exiting presentation slides become unavailable while the next stage waits", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  await signIn(page);
  mock.setPresentationPosition("opening");
  await openPresenter(page);
  await expect(slideFor(page, "opening")).toBeVisible();
  const main = page.locator("main");
  await page
    .getByTestId("presentation-natural-layer")
    .locator("h1")
    .evaluate((heading) => {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
    });

  const mutation = nextAdminMutation(page);
  await page.keyboard.press("ArrowRight");
  await mutation;

  const exitingSlide = page
    .getByTestId("presentation-natural-layer")
    .locator('[aria-hidden="true"][inert]');
  await expect(exitingSlide).toHaveCount(1);
  await expect(exitingSlide).toHaveAttribute("aria-hidden", "true");
  await expect(exitingSlide).toHaveAttribute("inert", "");
  await expect(exitingSlide).toHaveCSS("pointer-events", "none");
  await expect(slideFor(page, "question")).toHaveCount(0);
  await expect(
    page
      .getByTestId("presentation-natural-layer")
      .locator('section[class*="opening"], section[class*="question"], section[class*="answer"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId("presentation-fit-layer")).toHaveCount(1);
  await expect(page.getByTestId("presentation-natural-layer")).toHaveCount(1);
  const exitAnimation = await exitingSlide.evaluate((element) =>
    element
      .getAnimations()
      .map((animation) => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect)) return null;
        return {
          duration: effect.getComputedTiming().duration,
          easing: effect.getTiming().easing,
          keyframes: effect.getKeyframes(),
        };
      })
      .find((animation) => animation?.duration === 140),
  );
  expect(exitAnimation).toBeDefined();
  expect(["ease-out", "cubic-bezier(0, 0, 0.58, 1)"]).toContain(exitAnimation?.easing);
  expect(Number(exitAnimation?.keyframes.at(-1)?.opacity)).toBe(0);
  await expect
    .poll(() => main.evaluate((element) => element.ownerDocument.activeElement === element))
    .toBe(true);
  await expect(slideFor(page, "question")).toBeVisible();
});

test("@chromium rapid presenter navigation settles on the latest slide after exit", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  await signIn(page);
  mock.setPresentationPosition("opening");
  await openPresenter(page);
  await expect(slideFor(page, "opening")).toBeVisible();

  const firstMutationStarted = mock.pauseNextMutation();
  const firstMutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await firstMutationStarted;

  const latestMutation = page.waitForResponse((response) => {
    const request = response.request();
    if (
      new URL(response.url()).pathname !== "/api/admin/presentation" ||
      request.method() !== "POST"
    ) {
      return false;
    }
    return request.postDataJSON().state === "podium_preview";
  });
  await page.locator("main").evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });

  mock.releasePausedMutation();
  await Promise.all([firstMutation, latestMutation]);
  await expect(slideFor(page, "podium_preview")).toBeVisible();
  expect(mock.positionLog.at(-1)).toMatchObject({ state: "podium_preview", questionIndex: 0 });
});

test("@chromium selected-answer and supplement groups replay on stage re-entry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installAnswerRevealAnimationProbe(page, questions[0].id);
  await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);

  const enterAnswer = async () => {
    const mutation = nextAdminMutation(page);
    await page.locator("main").press("ArrowRight");
    await expect(slideFor(page, "answer")).toBeVisible();
    await mutation;
  };
  await enterAnswer();
  const ordinal = page.locator("[class*='answerReview'] [class*='ordinal']");
  const questionHeading = page.getByRole("heading", { name: questions[0].question });
  const answerList = page.locator("[class*='answerReview'] ol[class*='answerReveal']");
  const supplement = page.locator("[class*='answerSupplement']");
  await expect(ordinal).toHaveText("問 1");
  await expect(questionHeading).toBeVisible();
  await expect(answerList).toBeAttached();
  await expect(answerList).not.toHaveAttribute("aria-hidden");
  await expect(answerList).not.toHaveAttribute("inert");
  await expect(answerList).toHaveCSS("animation-delay", "0.1s");
  await expect(answerList).toHaveCSS("animation-duration", "0.35s");
  await expect(supplement).toBeAttached();
  await expect(supplement).toHaveCSS("animation-delay", "0.35s");
  await expect(supplement).toHaveCSS("animation-duration", "0.3s");
  await expect.poll(() => page.evaluate(() => window.__answerRevealAnimations.length)).toBe(2);
  expect(
    await page.evaluate(() => window.__answerRevealAnimations.map(({ group }) => group)),
  ).toEqual(["answer", "supplement"]);
  expect(
    await page.evaluate(() =>
      window.__answerRevealAnimations.every(({ name }) => name.includes("answerRevealFade")),
    ),
  ).toBe(true);

  await expectAnswerRevealFitDuringAndAfter(page, 0);
  const previous = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "question")).toBeVisible();
  await previous;
  const reentry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "answer")).toBeVisible();
  await reentry;
  await expect.poll(() => page.evaluate(() => window.__answerRevealAnimations.length)).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__answerRevealAnimationEnds.length)).toBe(4);
});

test("@chromium presenter can leave and advance stages during an active answer reveal", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    window.__answerRevealAnimations = [];
    window.__answerRevealAnimationEnds = [];
    document.addEventListener(
      "animationstart",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.matches("[class*='answerReveal'], [class*='answerSupplement']")) return;
        for (const animation of target.getAnimations()) {
          animation.pause();
          animation.currentTime = 150;
        }
        window.__answerRevealAnimations.push({
          group: target.matches("[class*='answerReveal']") ? "answer" : "supplement",
          name: (event as AnimationEvent).animationName,
        });
      },
      true,
    );
    document.addEventListener(
      "animationend",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.matches("[class*='answerReveal'], [class*='answerSupplement']")) return;
        window.__answerRevealAnimationEnds.push({
          group: target.matches("[class*='answerReveal']") ? "answer" : "supplement",
          name: (event as AnimationEvent).animationName,
        });
      },
      true,
    );
  });
  await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);

  const answerEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "answer")).toBeVisible();
  await answerEntry;
  await expect
    .poll(() => page.evaluate(() => window.__answerRevealAnimations.length))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .locator("[class*='answerReview'] [class*='answerReveal']")
        .evaluate((element) => element.getAnimations()[0]?.playState),
    )
    .toBe("paused");
  const firstRevealProgress = await page
    .locator("[class*='answerReview'] [class*='answerReveal']")
    .evaluate((element) => element.getAnimations()[0]?.effect?.getComputedTiming().progress);
  expect(firstRevealProgress).toBeGreaterThan(0);
  expect(firstRevealProgress).toBeLessThan(1);
  expect(
    await page.evaluate(
      () => window.__answerRevealAnimationEnds.filter(({ group }) => group === "answer").length,
    ),
  ).toBe(0);
  const startsBeforeLeaving = await page.evaluate(() => window.__answerRevealAnimations.length);

  const leaveDuringReveal = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "question")).toBeVisible();
  await leaveDuringReveal;

  const reentry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "answer")).toBeVisible();
  await reentry;
  await expect
    .poll(() => page.evaluate(() => window.__answerRevealAnimations.length))
    .toBeGreaterThan(startsBeforeLeaving);
  await expect
    .poll(() =>
      page
        .locator("[class*='answerReview'] [class*='answerReveal']")
        .evaluate((element) => element.getAnimations()[0]?.playState),
    )
    .toBe("paused");
  const reentryProgress = await page
    .locator("[class*='answerReview'] [class*='answerReveal']")
    .evaluate((element) => element.getAnimations()[0]?.effect?.getComputedTiming().progress);
  expect(reentryProgress).toBeGreaterThan(0);
  expect(reentryProgress).toBeLessThan(1);
  expect(
    await page.evaluate(
      () => window.__answerRevealAnimationEnds.filter(({ group }) => group === "answer").length,
    ),
  ).toBe(0);
  const advanceDuringReveal = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "podium_preview")).toBeVisible();
  await advanceDuringReveal;
});

test("@chromium free-text model answer and published responses share their planned reveal groups", async ({
  page,
}) => {
  const freeTextQuestion: PresentationQuestionFixture = {
    ...questions[0],
    answerType: "freeText",
    expectedAnswer: "家族で訪れた海辺",
    responses: [
      {
        displayName: "葵",
        answerKind: "freeText",
        answer: "海辺",
        similarity: 0.8,
        score: 1,
      },
    ],
  };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    window.__answerRevealAnimationEnds = [];
    document.addEventListener(
      "animationend",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const group = target.matches("[class*='answerReveal']")
          ? "answer"
          : target.matches("[class*='answerSupplement']")
            ? "supplement"
            : null;
        if (group)
          window.__answerRevealAnimationEnds.push({
            group,
            name: (event as AnimationEvent).animationName,
          });
      },
      true,
    );
  });
  await installAdminApiMock(page, { question: freeTextQuestion });
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "answer")).toBeVisible();
  await mutation;

  const answerGroup = page.locator("[class*='answerReveal']");
  const supplement = page.locator("[class*='answerSupplement']");
  await expect(answerGroup.getByRole("heading", { name: "模範解答" })).toBeVisible();
  await expect(answerGroup).toContainText("家族で訪れた海辺");
  await expect(supplement.getByRole("listitem")).toContainText("葵：海辺");
  await expect(answerGroup).toHaveCSS("animation-delay", "0.1s");
  await expect(answerGroup).toHaveCSS("animation-duration", "0.35s");
  await expect(supplement).toHaveCSS("animation-delay", "0.35s");
  await expect(supplement).toHaveCSS("animation-duration", "0.3s");
  await expect.poll(() => page.evaluate(() => window.__answerRevealAnimationEnds.length)).toBe(2);
  await expect(answerGroup).toHaveCSS("opacity", "1");
  await expect(supplement).toHaveCSS("opacity", "1");
  await expectNoAccessibilityViolations(page, "presentation free-text answer and responses");
});

test("@chromium every stage keeps its fixture text inside the canvas content bounds", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    window.__answerRevealAnimationEnds = [];
    document.addEventListener(
      "animationend",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const group = target.matches("[class*='answerReveal']")
          ? "answer"
          : target.matches("[class*='answerSupplement']")
            ? "supplement"
            : null;
        if (group)
          window.__answerRevealAnimationEnds.push({
            group,
            name: (event as AnimationEvent).animationName,
          });
      },
      true,
    );
  });
  await installAdminApiMock(page);
  const inspectSlide = async () => {
    await waitForRenderFrames(page);
    return page.getByTestId("presentation-fit-viewport").evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect();
      const outOfBounds = Array.from(viewport.querySelectorAll("*"))
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .filter(
          (rect) =>
            rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1 ||
            rect.top < bounds.top - 1 ||
            rect.bottom > bounds.bottom + 1,
        ).length;
      return {
        text: viewport.textContent ?? "",
        outOfBounds,
        pageCanScroll: document.documentElement.scrollHeight > innerHeight,
      };
    });
  };
  await page.goto("/presentation");
  await expect(page.getByRole("heading", { name: /^しゅんたま\s*検定$/ })).toBeVisible();
  await expect(page.getByText("発表が始まるまで、少々お待ちください")).toBeVisible();
  await expectNoAccessibilityViolations(page, "presentation waiting state");
  const notStartedInspection = await inspectSlide();
  expect(notStartedInspection.text).toContain("しゅんたま検定");
  expect(notStartedInspection.outOfBounds).toBe(0);
  expect(notStartedInspection.pageCanScroll).toBe(false);
  await expect(page.getByRole("heading", { name: /^しゅんたま\s*検定$/ })).toBeVisible();

  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);

  const stages: {
    state: PresentationState;
    text: string[];
  }[] = [
    {
      state: "question",
      text: [questions[0].question, ...questions[0].choices],
    },
    {
      state: "answer",
      text: [questions[0].question, ...questions[0].choices, "正解", questions[0].explanation],
    },
    { state: "podium_preview", text: ["いよいよ、結果発表です", "どうぞお楽しみに"] },
    { state: "third", text: ["該当する受賞者はいません", "第三位"] },
    { state: "second", text: ["太郎", "0.00 ポイント", "第二位"] },
    { state: "first", text: ["花子", "1.00 ポイント", "第一位"] },
    { state: "first_prize", text: ["1位の景品", "和牛カタログ"] },
    { state: "finished", text: ["ご参加", "ありがとうございました"] },
  ];

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    await expect(slideFor(page, stage.state)).toBeVisible();
    if (
      stage.state === "question" ||
      stage.state === "podium_preview" ||
      stage.state === "finished"
    ) {
      await waitForCurrentPresentationEntryAnimations(page);
    }
    const inspection = await inspectSlide();
    for (const text of stage.text) expect(inspection.text).toContain(text);
    if (stage.state === "first_prize") {
      const beef = page.getByRole("img", { name: "和牛の写真" });
      const catalog = page.getByRole("img", { name: "和牛カタログの表紙" });
      await expect(beef).toBeVisible();
      await expect(catalog).toBeVisible();
      await expect(beef).toHaveCSS("object-fit", "contain");
      await expect(catalog).toHaveCSS("object-fit", "contain");
      expect(inspection.outOfBounds).toBe(0);
      expect(inspection.pageCanScroll).toBe(false);
    }
    if (stage.state === "question" || stage.state === "answer") {
      if (stage.state === "answer") {
        await expect
          .poll(() => page.evaluate(() => window.__answerRevealAnimationEnds.length))
          .toBe(2);
      }
      await expectNoAccessibilityViolations(page, `presentation ${stage.state} state`);
    }
    expect(inspection.outOfBounds).toBe(0);
    expect(inspection.pageCanScroll).toBe(false);

    const nextStage = stages[index + 1];
    if (!nextStage) continue;
    const adminRefresh = nextAdminMutation(page);
    await page.locator("main").press("ArrowRight");
    await expect(slideFor(page, nextStage.state)).toBeVisible();
    await adminRefresh;
  }
});

test("@chromium first-prize position is shared with the public projection and survives reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 450 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await installAdminApiMock(page);
  await signIn(page);
  mock.setPresentationPosition("first");
  await openPresenter(page);

  let mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "first_prize")).toBeVisible();
  await mutation;
  await expect(page.getByRole("img", { name: "和牛の写真" })).toBeVisible();
  await expect(page.getByRole("img", { name: "和牛カタログの表紙" })).toBeVisible();

  const publicPage = await page.context().newPage();
  await publicPage.setViewportSize({ width: 640, height: 360 });
  await publicPage.goto("/presentation");
  await expect(publicPage.getByRole("heading", { name: "和牛カタログ" })).toBeVisible();
  await expect(publicPage.getByRole("img", { name: "和牛の写真" })).toBeVisible();
  await expect(publicPage.getByRole("img", { name: "和牛カタログの表紙" })).toBeVisible();
  const canvas = publicPage.getByTestId("presentation-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width / bounds!.height).toBeCloseTo(16 / 9, 2);

  await page.reload();
  await expect(slideFor(page, "first_prize")).toBeVisible();
  await expect(page.getByRole("img", { name: "和牛カタログの表紙" })).toBeVisible();

  mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "first")).toBeVisible();
  await mutation;
  await expect(publicPage.getByRole("region", { name: "第一位の勝者一覧" })).toBeVisible();
  mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "first_prize")).toBeVisible();
  await mutation;
  mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "finished")).toBeVisible();
  await mutation;
  await expect(
    publicPage.getByRole("heading", { name: /ご参加.*ありがとうございました/ }),
  ).toBeVisible();

  mock.setPresentationPosition("first_prize");
  await expect(slideFor(page, "first_prize")).toBeVisible();
  const adminPage = await page.context().newPage();
  await adminPage.goto("/admin/presentation");
  const reset = adminPage.getByRole("button", { name: "最初に戻る" });
  await expect(reset).toBeVisible();
  const resetMutation = nextAdminMutation(adminPage);
  await reset.click();
  await resetMutation;
  await expect(slideFor(page, "opening")).toBeVisible();
  await expect(slideFor(publicPage, "opening")).toBeVisible();
  expect(mock.getPresentationState().state).toBe("opening");
  await adminPage.close();
  await publicPage.close();
});

test("@chromium rank reveal can advance into first prize while its automatic animation is active", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installAdminApiMock(page);
  await signIn(page);
  const mockPosition = nextAdminMutation(page);
  await page.evaluate(async () => {
    const controlsResponse = await fetch("/api/admin/presentation?view=controls");
    const controls = (await controlsResponse.json()) as {
      version: number;
      snapshotRevision: number;
    };
    const response = await fetch("/api/admin/presentation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        action: "position",
        state: "second",
        questionIndex: 0,
        expectedSnapshotRevision: controls.snapshotRevision,
        expectedSessionVersion: controls.version,
      }),
    });
    if (!response.ok) throw new Error(`Position request failed: ${response.status}`);
  });
  await mockPosition;
  await openPresenter(page);

  let mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "first")).toBeVisible();
  await mutation;
  const winnerContent = rankRegionFor(page, "first").locator("[class*='winnerContent']");
  await expect
    .poll(() =>
      winnerContent.evaluate((element) => {
        const animation = element
          .getAnimations()
          .find((candidate) =>
            (candidate as CSSAnimation).animationName.endsWith("rankWinnerReveal"),
          );
        const progress = animation?.effect?.getComputedTiming().progress;
        return progress !== null && progress !== undefined && progress > 0 && progress < 1;
      }),
    )
    .toBe(true);

  mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "first_prize")).toBeVisible();
  await mutation;
});

test("@chromium finished skips the first-prize position when there is no first-place winner", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page, { skipEmptyRanks: true });
  mock.setWinnerEntries([{ displayName: "凛", score: 9, rank: 2 }]);
  mock.setPresentationPosition("finished");
  await signIn(page);
  await openPresenter(page);

  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "second")).toBeVisible();
  await mutation;
  expect(mock.getPresentationState().state).toBe("second");
  await expect(page.getByRole("heading", { name: "和牛カタログ" })).toHaveCount(0);
});

test("@chromium long answer content remains complete and fits without an internal scroll region", async ({
  page,
}) => {
  const explanation = Array.from({ length: 36 }, (_, index) =>
    `解説段落${index + 1}：思い出の内容を省略せずに表示します。`.repeat(4),
  ).join("\n");
  const lastLine = "解説段落36：思い出の内容を省略せずに表示します。";
  let allowStandby = false;
  await page.route("**/api/presentation", async (route) => {
    if (allowStandby) {
      await route.fulfill({ json: { state: "standby" } });
      return;
    }
    await route.fulfill({
      json: {
        state: "answer",
        question: {
          id: 11,
          ordinal: 1,
          total: 1,
          question: "ふたりが初めて出会った場所は？",
          choices: ["カフェ", "大学", "駅"],
          correctIndex: 1,
          explanation,
        },
      },
    });
  });
  await page.goto("/presentation");

  const answerContent = page.locator('[class*="answerContent"]');
  const finalExplanation = answerContent.locator("p").last();
  await expect(finalExplanation).toContainText(lastLine);
  await expect(answerContent).toContainText("解説段落1：思い出の内容を省略せずに表示します。");
  await expect
    .poll(() =>
      page
        .getByTestId("presentation-fit-layer")
        .evaluate((node) => Number(node.style.getPropertyValue("--presentation-fit-scale"))),
    )
    .toBeLessThan(0.95);
  const denseAnswerScale = await page
    .getByTestId("presentation-fit-layer")
    .evaluate((node) => Number(node.style.getPropertyValue("--presentation-fit-scale")));
  const geometry = await page.getByTestId("presentation-canvas").evaluate((canvas) => {
    const canvasRect = canvas.getBoundingClientRect();
    const explanation = canvas.querySelector("[class*='explanation']");
    const explanationRect = explanation?.getBoundingClientRect();
    const answer = canvas.querySelector("[class*='answerContent']");
    return {
      canvasRect: {
        top: canvasRect.top,
        bottom: canvasRect.bottom,
      },
      explanationRect: explanationRect
        ? { top: explanationRect.top, bottom: explanationRect.bottom }
        : null,
      pageCanScroll: document.documentElement.scrollHeight > innerHeight,
      answerCanScroll: answer instanceof HTMLElement && answer.scrollHeight > answer.clientHeight,
      text: answer?.textContent ?? "",
    };
  });
  expect(geometry.text).toContain(lastLine);
  expect(geometry.pageCanScroll).toBe(false);
  expect(geometry.answerCanScroll).toBe(false);
  expect(geometry.explanationRect).toBeDefined();
  expect(geometry.explanationRect!.top).toBeGreaterThanOrEqual(geometry.canvasRect.top - 1);
  expect(geometry.explanationRect!.bottom).toBeLessThanOrEqual(geometry.canvasRect.bottom + 1);
  const answerBounds = await page.getByTestId("presentation-fit-viewport").evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect();
    const outOfBounds = Array.from(viewport.querySelectorAll("*"))
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .filter(
        (rect) =>
          rect.left < bounds.left - 1 ||
          rect.right > bounds.right + 1 ||
          rect.top < bounds.top - 1 ||
          rect.bottom > bounds.bottom + 1,
      ).length;
    return { outOfBounds };
  });
  expect(answerBounds.outOfBounds).toBe(0);
  await expect(finalExplanation).toBeVisible();
  const nextProjectionPoll = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/presentation",
  );
  allowStandby = true;
  await nextProjectionPoll;
  await expect(page.getByText("ただいま休憩中です")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("presentation-fit-layer")
        .evaluate((node) => Number(node.style.getPropertyValue("--presentation-fit-scale"))),
    )
    .toBeGreaterThan(denseAnswerScale);
  const standbyScale = await page
    .getByTestId("presentation-fit-layer")
    .evaluate((node) => Number(node.style.getPropertyValue("--presentation-fit-scale")));
  expect(standbyScale).toBeGreaterThan(0.99);
});

test("@chromium finished results are published only from admin and publication does not advance the stage", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "finished");
  const presenter = page.getByRole("main");
  await expect(presenter.getByRole("button")).toHaveCount(1);
  await expect(presenter.getByRole("button", { name: "全画面表示" })).toBeVisible();
  const finishedState = mock.getPresentationState();
  await page.goto("/admin/presentation");
  await expect(page.getByText("現在の状態：終了")).toBeVisible();
  await page.getByRole("button", { name: "参加者結果を公開" }).click();
  await expect(page.getByText("参加者結果は公開済みです")).toBeVisible();
  expect(mock.participantResultsMutations).toEqual([true]);
  expect(mock.getPresentationState()).toEqual(finishedState);
  await page.reload();
  await expect(page.getByText("参加者結果は公開済みです")).toBeVisible();
  expect(mock.participantResultsMutations).toEqual([true]);
  await page.getByRole("button", { name: "参加者結果を非公開" }).click();
  await expect(page.getByRole("button", { name: "参加者結果を公開" })).toBeVisible();
  await page.getByRole("button", { name: "参加者結果を公開" }).click();
  await expect(page.getByText("参加者結果は公開済みです")).toBeVisible();
  expect(mock.participantResultsMutations).toEqual([true, false, true]);
  expect(mock.getPresentationState()).toEqual(finishedState);
});

test("@chromium presenter progression never requests fullscreen and manual fullscreen exits with Escape", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page, { fullscreenSupported: true });
  await page.addInitScript(() => {
    window.__fullscreenRequests = 0;
    let fullscreenActive = false;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => (fullscreenActive ? document.querySelector("main") : null),
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: function requestFullscreen() {
        window.__fullscreenRequests += 1;
        fullscreenActive = true;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && fullscreenActive) {
        fullscreenActive = false;
        document.dispatchEvent(new Event("fullscreenchange"));
      }
    });
  });
  await signIn(page);
  await startPresentation(page);
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(0);
  await openPresenter(page);
  const fullscreenButton = page.locator("main").getByRole("button", { name: "全画面表示" });
  await expect(fullscreenButton).toBeVisible();
  let adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(0);

  await fullscreenButton.click();
  await expect(page.locator("main").getByRole("button", { name: "全画面表示" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("main").getByRole("button", { name: "全画面表示" })).toBeVisible();
  adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  expect(mock.actionLog).toEqual(["aggregate", "start", "position", "position", "position"]);
});

test("@chromium native presenter fullscreen API enters and exits without automatic re-entry", async ({
  page,
}) => {
  await installAdminApiMock(page, { fullscreenSupported: true });
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);

  expect(await page.evaluate(() => document.fullscreenEnabled)).toBe(true);
  const button = page.locator("main").getByRole("button", { name: "全画面表示" });
  await expect(button).toBeVisible();
  await button.click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector("main")))
    .toBe(true);
  await expect(slideFor(page, "question")).toBeVisible();
  await expect(page.locator("main").getByRole("button", { name: "全画面表示" })).toHaveCount(0);

  // This case exercises the browser's real fullscreen API. Escape behavior is
  // covered separately by the deterministic mocked fullscreen test above.
  const fullscreenExit = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        document.addEventListener("fullscreenchange", () => resolve(), { once: true });
      }),
  );
  await page.evaluate(async () => document.exitFullscreen());
  await fullscreenExit;
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator("main").getByRole("button", { name: "全画面表示" })).toBeVisible();

  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await mutation;
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator("main").getByRole("button", { name: "全画面表示" })).toBeVisible();
});

test("@chromium opening cover stays on the same state before and after native fullscreen", async ({
  page,
}) => {
  await installAdminApiMock(page, { fullscreenSupported: true });
  await signIn(page);
  await page.getByRole("button", { name: "集計" }).click();
  await expect(page.getByText(/集計済み/)).toBeVisible();
  await page.getByRole("button", { name: "発表を開始" }).click();
  await expect(page.getByText("現在の状態：進行中：オープニング")).toBeVisible();
  await openPresenter(page);

  await expect(slideFor(page, "opening")).toBeVisible();
  await page.locator("main").getByRole("button", { name: "全画面表示" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector("main")))
    .toBe(true);
  await expect(slideFor(page, "opening")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await waitForRenderFrames(page);
});

test("@chromium authenticated presenter captures all podium ranks in native fullscreen", async ({
  page,
}) => {
  const viewport = { width: 1920, height: 1080 };
  await page.setViewportSize(viewport);
  const mock = await installAdminApiMock(page, { fullscreenSupported: true });
  mock.setWinnerEntries([
    { displayName: "三位の受賞者", score: 0.75, rank: 3 },
    { displayName: "二位の受賞者", score: 0.8, rank: 2 },
    { displayName: "一位の受賞者", score: 0.9, rank: 1 },
  ]);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");

  await expect(slideFor(page, "third")).toBeVisible();
  const fullscreenButton = page.locator("main").getByRole("button", { name: "全画面表示" });
  await expect(fullscreenButton).toBeVisible();
  await fullscreenButton.click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector("main")))
    .toBe(true);

  const ranks = [
    { state: "third" as const, label: "第三位" },
    { state: "second" as const, label: "第二位" },
    { state: "first" as const, label: "第一位" },
  ];
  for (const [index, rank] of ranks.entries()) {
    await expect(slideFor(page, rank.state)).toBeVisible();
    await expect(page.getByRole("region", { name: `${rank.label}の勝者一覧` })).toBeVisible();
    expect(mock.getPresentationState().state).toBe(rank.state);
    expect(page.viewportSize()).toEqual(viewport);
    expect(
      await page.evaluate(() => document.fullscreenElement === document.querySelector("main")),
    ).toBe(true);
    const nextRank = ranks[index + 1];
    if (nextRank) {
      const refresh = nextAdminMutation(page);
      await page.locator("main").press("ArrowRight");
      await expect(slideFor(page, nextRank.state)).toBeVisible();
      await refresh;
    }
  }
});
