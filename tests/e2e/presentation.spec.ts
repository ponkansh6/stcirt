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
  let failAdminRead = false;
  let failNextAdminRead = false;
  let failNextDeckRead = false;
  let failNextMutationUnauthorized = false;
  let failNextMutationConflict = false;
  let pauseNextMutation = false;
  let releasePausedMutation: (() => void) | null = null;
  let pausedMutationStarted: (() => void) | null = null;
  let holdNextProjection = false;
  let releaseHeldProjection: (() => void) | null = null;
  let heldProjectionStarted: (() => void) | null = null;
  let failNextParticipantResultsMutation = false;
  let successfulParticipantResultsPublished = false;
  let pauseNextParticipantResultsMutation = false;
  let releasePausedParticipantResultsMutation: (() => void) | null = null;
  let participantResultsMutationStarted: (() => void) | null = null;
  const actions: string[] = [];
  const positionLog: { state: PresentationState; questionIndex: number }[] = [];
  const participantResultsMutations: boolean[] = [];
  const participantResultsStageSnapshots: PresentationState[] = [];
  const presentationRouteEvents: string[] = [];
  const stages: PresentationState[] = [
    "not_started",
    "opening",
    ...(questionCount === 0 ? [] : (["question", "answer"] as const)),
    "podium_preview",
    "third",
    "second",
    "first",
    "finished",
  ];

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
    slides: (
      [
        "opening",
        ...(questionCount === 0 ? [] : (["question", "answer"] as const)),
        "podium_preview",
        "third",
        "second",
        "first",
        "finished",
      ] as const
    ).map((slideState) => {
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
        if (failNextDeckRead) {
          failNextDeckRead = false;
          await route.fulfill({ status: 503, json: { error: "Unavailable" } });
          return;
        }
        await route.fulfill({ json: deck() });
      }),
    )
    .then(() =>
      context.route(
        (url) => url.pathname === "/api/admin/presentation",
        async (route) => {
          if (route.request().method() === "GET") {
            if (failNextAdminRead) {
              failNextAdminRead = false;
              if (new URL(route.request().url()).searchParams.get("view") === "controls") {
                presentationRouteEvents.push("controls:get:503");
              }
              await route.fulfill({ status: 503, json: { error: "Unavailable" } });
              return;
            }
            if (failAdminRead) {
              if (new URL(route.request().url()).searchParams.get("view") === "controls") {
                presentationRouteEvents.push("controls:get:503");
              }
              await route.fulfill({ status: 503, json: { error: "Unavailable" } });
              return;
            }
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
          if (failNextMutationUnauthorized) {
            failNextMutationUnauthorized = false;
            authenticated = false;
            await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
            return;
          }
          if (failNextMutationConflict) {
            failNextMutationConflict = false;
            if (body.action === "position" && body.state && Number.isInteger(body.questionIndex)) {
              state = body.state;
              questionIndex = body.questionIndex as number;
              stageCursor = stages.indexOf(state);
            }
            version += 1;
            presentationRouteEvents.push("mutation:position:409");
            await route.fulfill({
              status: 409,
              json: { error: "Presentation state changed concurrently" },
            });
            return;
          }
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
            state = stages[stageCursor];
          } else if (body.action === "start" && state === "not_started" && snapshotExists) {
            stageCursor = 1;
            state = stages[stageCursor];
          } else if (body.action === "position") {
            if (body.state && Number.isInteger(body.questionIndex) && stages.includes(body.state)) {
              state = body.state;
              questionIndex = body.questionIndex as number;
              stageCursor = stages.indexOf(state);
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
        if (failNextParticipantResultsMutation) {
          failNextParticipantResultsMutation = false;
          await route.fulfill({ status: 503, json: { error: "Unavailable" } });
          return;
        }
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
      failAdminReads: () => {
        failAdminRead = true;
      },
      failNextAdminRead: () => {
        failNextAdminRead = true;
      },
      failNextDeckRead: () => {
        failNextDeckRead = true;
      },
      advanceSnapshotRevision: () => {
        snapshotRevision += 1;
        version += 1;
      },
      failNextMutationAsUnauthorized: () => {
        failNextMutationUnauthorized = true;
      },
      conflictNextMutation: () => {
        failNextMutationConflict = true;
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
        stageCursor = stages.indexOf(nextState);
        version += 1;
      },
      getPresentationState: () => ({ state, questionIndex, version, projectionHidden }),
      getSnapshotRevision: () => snapshotRevision,
      participantResultsMutations,
      participantResultsStageSnapshots,
      getPresentationRouteEvents: () => presentationRouteEvents,
      failNextResultsMutation: () => {
        failNextParticipantResultsMutation = true;
      },
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
    const openingTitle = document.querySelector<HTMLElement>("#opening-title");
    const questionHeading = document.querySelector<HTMLElement>("#question-heading");
    const podiumTitle = document.querySelector<HTMLElement>("#podium-title");
    const finishedTitle = document.querySelector<HTMLElement>("#finished-title");
    let targets: HTMLElement[] = [];

    if (openingTitle) {
      const section = openingTitle.closest("section");
      targets = [
        openingTitle.parentElement,
        ...Array.from(section?.querySelectorAll("p") ?? []),
      ].filter((element): element is HTMLElement => element instanceof HTMLElement);
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
        .filter((animation) =>
          (animation as CSSAnimation).animationName.endsWith("presentationEntry"),
        );
      if (matches.length !== 1) {
        throw new Error(`Expected one presentationEntry animation on ${target.tagName}`);
      }
      const endTime = matches[0]?.effect?.getComputedTiming().endTime;
      if (typeof endTime !== "number" || !Number.isFinite(endTime) || endTime <= 0) {
        throw new Error("Expected a finite presentationEntry animation");
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
    case "finished":
      return page.getByRole("heading", { name: /ご参加.*ありがとうございました/ });
    default:
      throw new Error(`No projection slide locator for ${state}`);
  }
}

function entryFor(page: import("@playwright/test").Page, state: PresentationState) {
  switch (state) {
    case "opening":
      return page.locator("#opening-title").locator("xpath=..");
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

async function inspectEntryAnimation(target: import("@playwright/test").Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    const animation = element
      .getAnimations()
      .find((candidate) => (candidate as CSSAnimation).animationName.endsWith("presentationEntry"));
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
  });
}

async function expectPresentationEntryAnimation(target: import("@playwright/test").Locator) {
  const animation = await inspectEntryAnimation(target);
  const durationMs = Number.parseFloat(animation.animationDuration);
  const durationInMs = animation.animationDuration.endsWith("ms") ? durationMs : durationMs * 1000;
  expect(animation.animationName).toMatch(/presentationEntry$/);
  expect(durationInMs).toBeGreaterThan(0);
  expect(durationInMs).toBeLessThanOrEqual(400);
  expect(animation.animationFillMode).toBe("both");
  expect(Number(animation.firstOpacity)).toBe(0);
  expect(animation.firstTranslateY).toBe(-12);
  expect(Number(animation.lastOpacity)).toBe(1);
  expect(animation.lastTranslateY).toBe(0);
}

async function expectReducedEntry(target: import("@playwright/test").Locator) {
  await expect(target).toHaveCSS("animation-name", "none");
  await expect(target).toHaveCSS("animation-delay", "0s");
  await expect(target).toHaveCSS("opacity", "1");
  await expect(target).toHaveCSS("transform", "none");
}

async function advancePresenterTo(page: import("@playwright/test").Page, state: PresentationState) {
  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, state)).toBeVisible();
  await mutation;
}

async function returnPresenterTo(page: import("@playwright/test").Page, state: PresentationState) {
  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
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

async function pauseRankRevealBeforeEntry(page: import("@playwright/test").Page) {
  return page.addStyleTag({
    content: rankRevealPauseStyles,
  });
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

const rankRevealPauseStyles = `
  @media (prefers-reduced-motion: no-preference) {
    [class*="winnerReveal"],
    [class*="winnerReveal"]::before,
    [class*="winnerReveal"]::after,
    [class*="winnerContent"] {
      animation-play-state: paused !important;
    }
  }
`;

async function pauseRankRevealOnNextDocument(page: import("@playwright/test").Page) {
  await page.addInitScript((content) => {
    const installKey = "rank-reveal-test-pause-installed";
    if (sessionStorage.getItem(installKey)) return;
    sessionStorage.setItem(installKey, "true");
    const install = () => {
      if (document.getElementById("rank-reveal-test-pause")) return;
      const style = document.createElement("style");
      style.id = "rank-reveal-test-pause";
      style.textContent = content;
      (document.head ?? document.documentElement).append(style);
    };
    if (document.head) install();
    else document.addEventListener("DOMContentLoaded", install, { once: true });
  }, rankRevealPauseStyles);
  return page.locator("#rank-reveal-test-pause");
}

async function expectRankRevealGeometry(
  region: import("@playwright/test").Locator,
  phase: "during-delay" | "after-reveal" = "after-reveal",
  pauseStyle?:
    | import("@playwright/test").Locator
    | Awaited<ReturnType<typeof pauseRankRevealBeforeEntry>>,
) {
  const revealLocator = region.locator("[class*='winnerReveal']");
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    if (phase === "during-delay") {
      if (!pauseStyle) throw new Error("during-delay geometry requires a pre-armed pause style");
      await expect
        .poll(
          () =>
            revealLocator.evaluate((element) =>
              element
                .getAnimations({ subtree: true })
                .some((candidate) =>
                  (candidate as CSSAnimation).animationName.includes("rankWinnerReveal"),
                ),
            ),
          { timeout: 3000 },
        )
        .toBe(true);
      const timeline = await revealLocator.evaluate(async (element) => {
        const animation = element
          .getAnimations({ subtree: true })
          .find((candidate) =>
            (candidate as CSSAnimation).animationName.includes("rankWinnerReveal"),
          );
        if (!animation) return null;
        animation.pause();
        await animation.ready;
        animation.currentTime = 0;
        const stage = element as HTMLElement;
        const inner = stage.querySelector<HTMLElement>("[class*='winnerContent']");
        const pseudoAnimations = stage
          .getAnimations({ subtree: true })
          .filter((candidate) =>
            (candidate as CSSAnimation).animationName.includes("rankRevealAnticipation"),
          );
        if (stage.dataset.revealEligible === "true") {
          for (const pseudoAnimation of pseudoAnimations) {
            pseudoAnimation.pause();
            await pseudoAnimation.ready;
            pseudoAnimation.currentTime = 200;
          }
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          stageOpacity: getComputedStyle(stage).opacity,
          contentOpacity: inner ? getComputedStyle(inner).opacity : null,
          pseudoOpacities: [
            getComputedStyle(stage, "::before").opacity,
            getComputedStyle(stage, "::after").opacity,
          ],
          delay: getComputedStyle((animation.effect as KeyframeEffect).target as HTMLElement)
            .animationDelay,
          duration: getComputedStyle((animation.effect as KeyframeEffect).target as HTMLElement)
            .animationDuration,
        };
      });
      expect(timeline).not.toBeNull();
      expect(timeline?.stageOpacity).toBe("1");
      if (timeline?.contentOpacity !== null) expect(timeline?.contentOpacity).toBe("0");
      if ((await revealLocator.getAttribute("data-reveal-eligible")) === "true") {
        expect(timeline?.pseudoOpacities.some((value) => Number(value) > 0)).toBe(true);
      }
      expect(timeline?.delay).toBe("0.76s");
      expect(timeline?.duration).toBe("0.54s");
      await expect(region.locator("[class*='certificateLabel']")).toHaveCSS("opacity", "1");
      await expect(region.locator("[class*='rankHeader'] h1[class*='rank']")).toHaveCSS(
        "opacity",
        "1",
      );
    } else {
      await expect(revealLocator).toHaveCSS("opacity", "1");
    }

    const geometry = await region.evaluate((rankRegion) => {
      const reveal = rankRegion.querySelector<HTMLElement>("[class*='winnerReveal']");
      const header = rankRegion.querySelector<HTMLElement>("[class*='rankHeader']");
      const canvas = document.querySelector<HTMLElement>("[data-testid='presentation-canvas']");
      const content = document.querySelector<HTMLElement>(
        "[data-testid='presentation-fit-viewport']",
      );
      const revealRect = reveal?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      const winnerContent = reveal?.querySelector<HTMLElement>("[class*='winnerContent']");
      const winnerContentRect = winnerContent?.getBoundingClientRect();
      const winnerContentOpacity = winnerContent
        ? Number(getComputedStyle(winnerContent).opacity)
        : 0;
      const regionRect = rankRegion.getBoundingClientRect();
      const canvasRect = canvas?.getBoundingClientRect();
      const contentRect = content?.getBoundingClientRect();
      const measuredElements = Array.from(
        rankRegion.querySelectorAll<HTMLElement>(
          [
            "winnerReveal",
            "winnerContent",
            "winnerRankGroup",
            "winnerNames",
            "winnerIdentity",
            "winnerScore",
            "winnerQuestionResults",
            "additionalWinners",
            "noWinner",
          ]
            .map((name) => `[class*='${name}']`)
            .join(", ") + ", article, article h1, [aria-label='設問別の回答'] li",
        ),
      );
      const inside = (rect: DOMRect, bounds: DOMRect | undefined) =>
        Boolean(
          bounds &&
          rect.left >= bounds.left - 1 &&
          rect.right <= bounds.right + 1 &&
          rect.top >= bounds.top - 1 &&
          rect.bottom <= bounds.bottom + 1,
        );
      const overlaps = (left: DOMRect | undefined, right: DOMRect | undefined) =>
        Boolean(
          left &&
          right &&
          left.left < right.right - 1 &&
          left.right > right.left + 1 &&
          left.top < right.bottom - 1 &&
          left.bottom > right.top + 1,
        );
      const measured = measuredElements.map((element) => {
        const rect = element.getBoundingClientRect();
        const classes = element.className.toString();
        const isFitContainer = [
          "winnerContent",
          "winnerRankGroup",
          "winnerNames",
          "winner__",
          "winnerIdentity",
          "winnerQuestionResults",
        ].some((name) => classes.includes(name));
        const isRevealStage = classes.includes("winnerReveal");
        return {
          rect,
          element: `${element.tagName.toLowerCase()}.${classes
            .split(/\s+/)
            .filter(Boolean)
            .join(".")}`,
          visible: getComputedStyle(element).visibility === "visible",
          overflows:
            (isFitContainer &&
              (element.scrollWidth > element.clientWidth + 1 ||
                element.scrollHeight > element.clientHeight + 1)) ||
            (isRevealStage && element.scrollWidth > element.clientWidth + 1),
          scrollMetrics: {
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          },
        };
      });
      const cardRects = Array.from(rankRegion.querySelectorAll<HTMLElement>("article"), (card) =>
        card.getBoundingClientRect(),
      );
      const additionalWinnerRects = Array.from(
        rankRegion.querySelectorAll<HTMLElement>("[class*='additionalWinners']"),
        (summary) => summary.getBoundingClientRect(),
      );
      const nameScorePairs = Array.from(
        rankRegion.querySelectorAll<HTMLElement>("article"),
        (card) => ({
          name: card.querySelector<HTMLElement>("h1")?.getBoundingClientRect(),
          score: card.querySelector<HTMLElement>("[class*='winnerScore']")?.getBoundingClientRect(),
        }),
      );
      const identityResultPairs = Array.from(
        rankRegion.querySelectorAll<HTMLElement>("article"),
        (card) => ({
          identity: card
            .querySelector<HTMLElement>("[class*='winnerIdentity']")
            ?.getBoundingClientRect(),
          answerList: card
            .querySelector<HTMLElement>("[aria-label='設問別の回答']")
            ?.getBoundingClientRect(),
        }),
      );
      const answerRows = Array.from(
        rankRegion.querySelectorAll<HTMLElement>("[aria-label='設問別の回答'] li"),
        (row) => row.getBoundingClientRect(),
      );
      const textRects = Array.from(
        rankRegion.querySelectorAll<HTMLElement>(
          "[class*='winnerName'], [class*='winnerQuestionAnswer']",
        ),
      ).flatMap((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return Array.from(range.getClientRects());
      });
      const rectSummary = (rect: DOMRect | undefined) =>
        rect
          ? {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            }
          : null;
      const pairsDoNotOverlap = (rects: DOMRect[]) =>
        rects.every((rect, index) =>
          rects.slice(index + 1).every((other) => !overlaps(rect, other)),
        );

      return {
        revealFound: Boolean(reveal),
        decorationsHiddenFromAssistiveTech: [
          rankRegion.querySelector("[class*='rankOrnament']"),
          rankRegion.querySelector("[data-testid='presentation-exam-stamp']"),
        ].every((element) => element?.getAttribute("aria-hidden") === "true"),
        anticipationIsGeneratedOutsideTheDom:
          !rankRegion.querySelector("[class*='rankHalo']") &&
          Boolean(
            reveal &&
            reveal.getAttribute("aria-hidden") !== "true" &&
            reveal.textContent?.trim() &&
            getComputedStyle(reveal, "::before").content === '""' &&
            getComputedStyle(reveal, "::after").content === '""',
          ),
        revealInsideCanvas: Boolean(revealRect && inside(revealRect, canvasRect)),
        revealInsideContent: Boolean(revealRect && inside(revealRect, contentRect)),
        headerInsideCanvas: Boolean(headerRect && inside(headerRect, canvasRect)),
        headerDoesNotOverlapVisibleWinnerText:
          winnerContentOpacity <= 0 || textRects.every((rect) => !overlaps(headerRect, rect)),
        revealGeometry: {
          phase: winnerContentOpacity > 0 ? "winner-visible" : "winner-hidden",
          winnerContentOpacity,
          header: rectSummary(headerRect),
          winnerContent: rectSummary(winnerContentRect),
          winnerText: textRects.map(rectSummary),
        },
        descendantsInsideRegionAndViewport:
          measured.length > 0 &&
          measured.every(({ rect }) => inside(rect, regionRect) && inside(rect, contentRect)),
        descendantsHaveAreaAndAreVisible:
          measured.length > 0 &&
          measured.every(({ rect, visible }) => rect.width > 0 && rect.height > 0 && visible),
        noClippedContainerContent: measured.every(({ overflows }) => !overflows),
        overflowingContainers: measured
          .filter(({ overflows }) => overflows)
          .map(({ element, scrollMetrics }) => ({ element, ...scrollMetrics })),
        textInsideRegionAndViewport:
          (textRects.length > 0 || Boolean(rankRegion.querySelector("[class*='noWinner']"))) &&
          textRects.every((rect) => inside(rect, regionRect) && inside(rect, contentRect)),
        textInsideCanvas: textRects.every((rect) => inside(rect, canvasRect)),
        cardsDoNotOverlap: pairsDoNotOverlap(cardRects),
        remainingCountDoesNotOverlapCards: additionalWinnerRects.every((summary) =>
          cardRects.every((card) => !overlaps(summary, card)),
        ),
        namesDoNotOverlapScores: nameScorePairs.every(({ name, score }) =>
          score ? !overlaps(name, score) : true,
        ),
        identitiesDoNotOverlapAnswerLists: identityResultPairs.every(({ identity, answerList }) =>
          answerList ? !overlaps(identity, answerList) : true,
        ),
        answerRowsDoNotOverlap: pairsDoNotOverlap(answerRows),
      };
    });
    expect(geometry.revealFound).toBe(true);
    expect(geometry.decorationsHiddenFromAssistiveTech).toBe(true);
    expect(geometry.anticipationIsGeneratedOutsideTheDom).toBe(true);
    expect(geometry.revealInsideCanvas).toBe(true);
    expect(geometry.revealInsideContent).toBe(true);
    expect(
      geometry.headerInsideCanvas,
      `rank header stays within the presentation canvas: ${JSON.stringify(geometry.revealGeometry)}`,
    ).toBe(true);
    expect(
      geometry.headerDoesNotOverlapVisibleWinnerText,
      `rank header does not overlap visible winner text: ${JSON.stringify(geometry.revealGeometry)}`,
    ).toBe(true);
    expect(geometry.descendantsInsideRegionAndViewport).toBe(true);
    expect(geometry.descendantsHaveAreaAndAreVisible).toBe(true);
    expect(
      geometry.noClippedContainerContent,
      `content containers fit without clipping: ${JSON.stringify(geometry.overflowingContainers)}`,
    ).toBe(true);
    expect(geometry.textInsideRegionAndViewport).toBe(true);
    expect(
      geometry.textInsideCanvas,
      `winner text stays within the presentation canvas: ${JSON.stringify(geometry.revealGeometry)}`,
    ).toBe(true);
    expect(geometry.cardsDoNotOverlap).toBe(true);
    expect(geometry.remainingCountDoesNotOverlapCards).toBe(true);
    expect(geometry.namesDoNotOverlapScores).toBe(true);
    expect(geometry.identitiesDoNotOverlapAnswerLists).toBe(true);
    expect(geometry.answerRowsDoNotOverlap).toBe(true);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  let cleanupError: unknown;
  let hasCleanupError = false;
  if (pauseStyle) {
    try {
      if ("evaluateAll" in pauseStyle) {
        await pauseStyle.evaluateAll((styles) => styles.forEach((style) => style.remove()));
      } else {
        await pauseStyle.evaluate((style) => style.parentNode?.removeChild(style));
      }
    } catch (error) {
      cleanupError = error;
      hasCleanupError = true;
    }
  }
  if (phase === "during-delay") {
    try {
      await revealLocator.evaluate(async (element) => {
        const animations = element
          .getAnimations({ subtree: true })
          .filter((animation) =>
            ["rankWinnerReveal", "rankRevealAnticipation"].some((name) =>
              (animation as CSSAnimation).animationName.includes(name),
            ),
          );
        for (const animation of animations) animation.play();
        await Promise.all(animations.map((animation) => animation.finished));
      });
    } catch (error) {
      cleanupError = error;
      hasCleanupError = true;
    }
  }

  if (hasPrimaryError) throw primaryError;
  if (hasCleanupError) throw cleanupError;
}

async function captureFirstPlaceRevealTimeline(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  region: import("@playwright/test").Locator,
) {
  const compareScreenshotLineBands = async (
    screenshot: Buffer,
    hiddenLineScreenshot: Buffer,
    clip: { x: number; y: number; width: number; height: number },
  ) => {
    return page.evaluate(
      async ({ lineBytes, hiddenBytes, clipHeight }) => {
        const decode = async (bytes: number[]) =>
          createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: "image/png" }));
        const [lineBitmap, hiddenBitmap] = await Promise.all([
          decode(lineBytes),
          decode(hiddenBytes),
        ]);
        if (lineBitmap.width !== hiddenBitmap.width || lineBitmap.height !== hiddenBitmap.height) {
          throw new Error("Line and hidden-line screenshot dimensions differ");
        }
        const canvas = document.createElement("canvas");
        canvas.width = lineBitmap.width;
        canvas.height = lineBitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");
        context.drawImage(hiddenBitmap, 0, 0);
        const hidden = context.getImageData(0, 0, canvas.width, canvas.height).data;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(lineBitmap, 0, 0);
        const line = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const bandHeight = Math.max(1, Math.ceil((lineBitmap.height / clipHeight) * 6));
        const countLineBand = (top: boolean) => {
          let changedPixels = 0;
          let warmPixels = 0;
          const startY = top ? 0 : lineBitmap.height - bandHeight;
          const endY = top ? bandHeight : lineBitmap.height;
          for (let y = startY; y < endY; y += 1) {
            for (let x = 0; x < lineBitmap.width; x += 1) {
              const index = (y * lineBitmap.width + x) * 4;
              const red = line[index];
              const green = line[index + 1];
              const blue = line[index + 2];
              const delta =
                Math.abs(red - hidden[index]) +
                Math.abs(green - hidden[index + 1]) +
                Math.abs(blue - hidden[index + 2]);
              if (delta >= 8) changedPixels += 1;
              if (red >= green && red - blue >= 8) warmPixels += 1;
            }
          }
          return { changedPixels, warmPixels };
        };
        return {
          width: lineBitmap.width,
          height: lineBitmap.height,
          bandHeight,
          lines: [countLineBand(true), countLineBand(false)],
        };
      },
      {
        lineBytes: Array.from(screenshot),
        hiddenBytes: Array.from(hiddenLineScreenshot),
        clipHeight: clip.height,
      },
    );
  };
  const stages = [
    { width: 1280, height: 720 },
    { width: 480, height: 900 },
  ];
  const times = [0, 120, 350, 500, 600, 759, 760, 761, 900, 1180, 1300] as const;
  type TimelineFrame = {
    stageOpacity: string;
    rankRegionOpacity: string;
    winnerOpacity: number | null;
    winnerTranslateY: number | null;
    winnerScale: number | null;
    contentZIndex: number | null;
    lineBoxes: {
      zIndex: number;
      box: { left: number; top: number; right: number; bottom: number };
    }[];
    lineOpacities: number[];
    ancestorsVisible: boolean;
    stageInsideViewport: boolean;
    rankRegionInsideViewport: boolean;
    stageRect: { x: number; y: number; width: number; height: number };
    lineProbePointsUnclipped: boolean;
  };

  for (const viewport of stages) {
    await page.setViewportSize(viewport);
    await waitForRenderFrames(page);
    let naturalStageRect: { x: number; y: number; width: number; height: number } | null = null;
    let zeroMillisecondFrame: TimelineFrame | null = null;
    const assertTimelineFrame = (frame: TimelineFrame, time: number) => {
      expect(frame.stageOpacity, `stage opacity at ${time}ms`).toBe("1");
      expect(frame.rankRegionOpacity, `rank region opacity at ${time}ms`).toBe("1");
      expect(frame.winnerOpacity, `winner text composite opacity at ${time}ms`).not.toBeNull();
      expect(frame.ancestorsVisible, `stage ancestors at ${time}ms`).toBe(true);
      expect(frame.stageInsideViewport, `stage bounds at ${time}ms`).toBe(true);
      expect(frame.rankRegionInsideViewport, `rank region bounds at ${time}ms`).toBe(true);
      expect(frame.lineProbePointsUnclipped, `line clipping at ${time}ms`).toBe(true);
      if (!naturalStageRect) naturalStageRect = frame.stageRect;
      expect(frame.stageRect, `natural stage size at ${time}ms`).toEqual(naturalStageRect);

      if (time === 350) {
        expect(frame.contentZIndex, "winner content stacking index at 350ms").not.toBeNull();
        expect(
          frame.lineBoxes.every(
            ({ zIndex }) => zIndex > (frame.contentZIndex ?? Number.POSITIVE_INFINITY),
          ),
          "announcement lines stack above winner content at 350ms",
        ).toBe(true);
      }

      if (time > 0 && time < 760) {
        expect(
          frame.lineOpacities.every((opacity) => opacity > 0),
          `both announcement lines are painted at ${time}ms`,
        ).toBe(true);
      } else {
        expect(frame.lineOpacities).toEqual([0, 0]);
      }
      if (time <= 760) expect(frame.winnerOpacity).toBe(0);
      if (time === 759) expect(frame.winnerOpacity).toBe(0);
      if (time === 760) expect(frame.winnerOpacity).toBe(0);
      if (time === 761) {
        expect(Number(frame.winnerOpacity)).toBeGreaterThan(0);
        expect(Number(frame.winnerOpacity)).toBeLessThan(1);
      }
      const linesVisible = frame.lineOpacities.some((opacity) => opacity > 0);
      const winnerVisible = Number(frame.winnerOpacity) > 0;
      if (linesVisible) {
        expect(
          frame.winnerOpacity,
          `winner stays transparent while announcement lines are visible at ${time}ms (lines: ${JSON.stringify(frame.lineOpacities)})`,
        ).toBe(0);
      }
      if (winnerVisible) {
        expect(
          frame.lineOpacities,
          `announcement lines stay transparent while winner text is visible at ${time}ms (winner opacity: ${frame.winnerOpacity})`,
        ).toEqual([0, 0]);
      }
      if (time === 0) expect(frame.winnerTranslateY).toBeGreaterThan(20);
      if (time === 1180) {
        expect(Math.abs(frame.winnerTranslateY ?? Number.POSITIVE_INFINITY)).toBeLessThan(4);
        expect(frame.winnerScale).toBeLessThanOrEqual(1.005);
      }
      if (time === 900) {
        expect(Number(frame.winnerOpacity)).toBeGreaterThan(0);
        expect(Number(frame.winnerOpacity)).toBeLessThan(1);
      }
      if (time === 1300) expect(frame.winnerOpacity).toBe(1);
    };

    for (const time of times) {
      const frame: TimelineFrame | null = await region.evaluate(async (rankRegion, currentTime) => {
        const regionElement = rankRegion as HTMLElement;
        const reveal = regionElement.matches("[class*='winnerReveal']")
          ? regionElement
          : regionElement.querySelector<HTMLElement>("[class*='winnerReveal']");
        if (!reveal) return null;

        const animations = reveal.getAnimations({ subtree: true });
        const slideAnimations = regionElement
          .getAnimations({ subtree: true })
          .filter((animation) =>
            /rankHeaderEntrance|rankPlateEntrance|rankStampEntrance|rankOrnamentEntrance|rankLineShimmer/.test(
              (animation as CSSAnimation).animationName,
            ),
          );
        for (const animation of slideAnimations) {
          const timing = animation.effect?.getComputedTiming();
          const endTime = Number(timing?.delay ?? 0) + Number(timing?.duration ?? 0);
          animation.pause();
          animation.currentTime = Math.min(currentTime, endTime);
        }
        const contentAnimation = animations.find((animation) =>
          (animation as CSSAnimation).animationName.includes("rankWinnerReveal"),
        );
        const lineAnimations = animations.filter((animation) =>
          (animation as CSSAnimation).animationName.includes("rankRevealAnticipation"),
        );
        if (!contentAnimation || lineAnimations.length !== 2) return null;

        contentAnimation.pause();
        contentAnimation.currentTime = currentTime;
        for (const lineAnimation of lineAnimations) {
          lineAnimation.pause();
          lineAnimation.currentTime = currentTime;
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const host = reveal;
        const winnerContent = host.querySelector<HTMLElement>("[class*='winnerContent']");
        const rect = host.getBoundingClientRect();
        const ancestors: HTMLElement[] = [];
        for (let parent = host.parentElement; parent; parent = parent.parentElement) {
          ancestors.push(parent);
        }
        const lineOpacities = [
          getComputedStyle(host, "::before").opacity,
          getComputedStyle(host, "::after").opacity,
        ].map(Number);
        const stageStyle = getComputedStyle(host);
        const stageScaleX = rect.width / Number.parseFloat(stageStyle.width);
        const stageScaleY = rect.height / Number.parseFloat(stageStyle.height);
        const contentStyle = winnerContent ? getComputedStyle(winnerContent) : null;
        const contentTransform = contentStyle
          ? new DOMMatrixReadOnly(contentStyle.transform)
          : null;
        const contentZIndex = contentStyle ? Number.parseInt(contentStyle.zIndex, 10) : null;
        const lineBoxes = ["::before", "::after"].map((pseudo) => {
          const style = getComputedStyle(host, pseudo);
          const width = Number.parseFloat(style.width);
          const height = Number.parseFloat(style.height);
          const localLeft = Number.parseFloat(style.left);
          const localTop =
            style.top === "auto"
              ? Number.parseFloat(stageStyle.height) - Number.parseFloat(style.bottom) - height
              : Number.parseFloat(style.top);
          const pseudoTransform = new DOMMatrixReadOnly(style.transform);
          const transformedLocalWidth = width * Math.abs(pseudoTransform.a);
          return {
            zIndex: Number.parseInt(style.zIndex, 10),
            box: {
              left: rect.left + (localLeft + (width - transformedLocalWidth) / 2) * stageScaleX,
              top: rect.top + localTop * stageScaleY,
              right: rect.left + (localLeft + (width + transformedLocalWidth) / 2) * stageScaleX,
              bottom: rect.top + (localTop + height) * stageScaleY,
            },
          };
        });
        const winnerText = host.querySelector<HTMLElement>("[class*='winnerIdentity']");
        let winnerOpacity = winnerText ? 1 : null;
        for (let node = winnerText; node && node !== host; node = node.parentElement) {
          winnerOpacity = Number(winnerOpacity) * Number(getComputedStyle(node).opacity);
        }
        return {
          stageOpacity: getComputedStyle(host).opacity,
          rankRegionOpacity: getComputedStyle(regionElement).opacity,
          winnerOpacity,
          winnerTranslateY: contentTransform?.f ?? null,
          winnerScale: contentTransform ? Math.hypot(contentTransform.a, contentTransform.b) : null,
          contentOpacity: winnerContent ? getComputedStyle(winnerContent).opacity : null,
          contentZIndex,
          lineBoxes,
          lineOpacities,
          ancestorsVisible: ancestors.every(
            (ancestor) =>
              getComputedStyle(ancestor).opacity === "1" &&
              getComputedStyle(ancestor).visibility === "visible",
          ),
          stageInsideViewport:
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= window.innerWidth &&
            rect.bottom <= window.innerHeight,
          rankRegionInsideViewport: (() => {
            const regionRect = regionElement.getBoundingClientRect();
            return (
              regionRect.left >= 0 &&
              regionRect.top >= 0 &&
              regionRect.right <= window.innerWidth &&
              regionRect.bottom <= window.innerHeight
            );
          })(),
          stageRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          lineProbePoints: [
            { x: rect.left + rect.width / 2, y: rect.top + 1 },
            { x: rect.left + rect.width / 2, y: rect.bottom - 1 },
          ],
          lineProbePointsUnclipped: [
            { x: rect.left + rect.width / 2, y: rect.top + 1 },
            { x: rect.left + rect.width / 2, y: rect.bottom - 1 },
          ].every(({ x, y }) =>
            ancestors.every((ancestor) => {
              const style = getComputedStyle(ancestor);
              const bounds = ancestor.getBoundingClientRect();
              const clipsX = ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
              const clipsY = ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
              return (
                (!clipsX || (x >= bounds.left && x <= bounds.right)) &&
                (!clipsY || (y >= bounds.top && y <= bounds.bottom))
              );
            }),
          ),
        };
      }, time);

      expect(frame, `first-place reveal frame at ${time}ms`).not.toBeNull();

      const screenshotPath = [500, 1300].includes(time)
        ? testInfo.outputPath(`first-place-${viewport.width}x${viewport.height}-${time}ms.png`)
        : undefined;
      if (screenshotPath) {
        await page.screenshot({ path: screenshotPath, animations: "allow" });
      }
      const clipX = Math.max(0, Math.floor(frame!.stageRect.x - 2));
      const clipY = Math.max(0, Math.floor(frame!.stageRect.y - 2));
      const pixelClip = {
        x: clipX,
        y: clipY,
        width: Math.min(
          viewport.width - clipX,
          Math.ceil(frame!.stageRect.x + frame!.stageRect.width + 2) - clipX,
        ),
        height: Math.min(
          viewport.height - clipY,
          Math.ceil(frame!.stageRect.y + frame!.stageRect.height + 2) - clipY,
        ),
      };
      const clipPath =
        time === 500
          ? testInfo.outputPath(
              `first-place-${viewport.width}x${viewport.height}-500ms-lines-clip.png`,
            )
          : undefined;
      const screenshot = await page.screenshot({
        clip: pixelClip,
        ...(clipPath ? { path: clipPath } : {}),
        animations: "allow",
      });
      const hiddenLineStyle = await page.addStyleTag({
        content: `
          section[data-rank="first"] [class*="winnerReveal"]::before,
          section[data-rank="first"] [class*="winnerReveal"]::after {
            animation: none !important;
            opacity: 0 !important;
          }
        `,
      });
      const noLineScreenshot = await page.screenshot({ clip: pixelClip, animations: "allow" });
      await hiddenLineStyle.evaluate((style) => style.parentNode?.removeChild(style));
      const lineBands = await compareScreenshotLineBands(screenshot, noLineScreenshot, pixelClip);
      if ([120, 350, 500].includes(time)) {
        expect(
          lineBands.lines.every(({ changedPixels }) => changedPixels >= 4),
          `both pseudo-element lines change rendered pixels at ${time}ms in ${viewport.width}x${viewport.height} (reveal ${frame!.stageRect.width}x${frame!.stageRect.height}; clip ${lineBands.width}x${lineBands.height}; band ${lineBands.bandHeight}px; changed pixels: ${lineBands.lines.map(({ changedPixels }) => changedPixels).join(", ")})`,
        ).toBe(true);
        expect(
          lineBands.lines.every(({ warmPixels }) => warmPixels > 0),
          `both announcement lines have visible warm pixels at ${viewport.width}x${viewport.height} (warm pixels: ${lineBands.lines.map(({ warmPixels }) => warmPixels).join(", ")})`,
        ).toBe(true);
      } else if (time === 0 || time >= 760) {
        expect(
          lineBands.lines.map(({ changedPixels }) => changedPixels),
          `no line pixels remain at ${time}ms`,
        ).toEqual([0, 0]);
      }
      if (time === 0) {
        zeroMillisecondFrame = frame!;
      } else if (time === 120) {
        expect(zeroMillisecondFrame, "captured first-place frame at 0ms").not.toBeNull();
        assertTimelineFrame(zeroMillisecondFrame!, 0);
        assertTimelineFrame(frame!, 120);
      } else {
        assertTimelineFrame(frame!, time);
      }
    }
  }

  const playback = await region.evaluate(async (rankRegion) => {
    const regionElement = rankRegion as HTMLElement;
    const host = regionElement.matches("[class*='winnerReveal']")
      ? regionElement
      : regionElement.querySelector<HTMLElement>("[class*='winnerReveal']");
    if (!host) throw new Error("First-place winner reveal stage is missing");
    const animations = host
      .getAnimations({ subtree: true })
      .filter((animation) =>
        /rankWinnerReveal|rankRevealAnticipation/.test((animation as CSSAnimation).animationName),
      );
    const content = host.querySelector<HTMLElement>("[class*='winnerContent']");
    const frames: {
      currentTime: number;
      contentOpacity: number | null;
      lineOpacities: number[];
    }[] = [];
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
      animation.play();
    }
    while (animations.some((animation) => animation.playState !== "finished")) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push({
        currentTime: Math.max(...animations.map((animation) => Number(animation.currentTime ?? 0))),
        contentOpacity: content ? Number(getComputedStyle(content).opacity) : null,
        lineOpacities: [
          Number(getComputedStyle(host, "::before").opacity),
          Number(getComputedStyle(host, "::after").opacity),
        ],
      });
    }
    await Promise.all(animations.map((animation) => animation.finished));
    return {
      stageOpacity: getComputedStyle(host).opacity,
      contentOpacity: content ? getComputedStyle(content).opacity : null,
      lineOpacities: [
        getComputedStyle(host, "::before").opacity,
        getComputedStyle(host, "::after").opacity,
      ],
      frames,
    };
  });
  expect(
    playback.frames.some(
      ({ currentTime, contentOpacity, lineOpacities }) =>
        currentTime > 0 &&
        currentTime < 760 &&
        contentOpacity === 0 &&
        lineOpacities.every((opacity) => opacity > 0),
    ),
    "normal playback paints anticipation lines before winner content",
  ).toBe(true);
  expect(
    playback.frames.some(
      ({ currentTime, contentOpacity, lineOpacities }) =>
        currentTime >= 760 &&
        currentTime < 1300 &&
        contentOpacity !== null &&
        contentOpacity > 0 &&
        lineOpacities.every((opacity) => opacity === 0),
    ),
    "normal playback reveals winner content after the anticipation lines",
  ).toBe(true);
  expect(playback.stageOpacity).toBe("1");
  expect(playback.contentOpacity).toBe("1");
  expect(playback.lineOpacities).toEqual(["0", "0"]);
}

test("@chromium first-place anticipation visibility timeline", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  mock.setWinnerEntries([
    { displayName: "花子", score: 1, rank: 1 },
    { displayName: "太郎", score: 1, rank: 1 },
  ]);
  await signIn(page);
  await startPresentation(page);
  mock.setPresentationPosition("first");
  await openPresenter(page);

  const region = rankRegionFor(page, "first");
  await expect(region).toHaveCount(1);
  await expect(region.getByText("花子", { exact: false })).toBeVisible();
  const headerMotion = await region.locator("[class*='rankHeader']").evaluate(async (header) => {
    const animation = header
      .getAnimations()
      .find((candidate) =>
        (candidate as CSSAnimation).animationName.includes("rankHeaderEntrance"),
      );
    if (!animation) return null;
    animation.pause();
    await animation.ready;
    const duration = Number(animation.effect?.getComputedTiming().duration);
    const sample = async (currentTime: number) => {
      animation.currentTime = currentTime;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const transform = new DOMMatrixReadOnly(getComputedStyle(header).transform);
      return { translateY: transform.f, scale: Math.hypot(transform.a, transform.b) };
    };
    const start = await sample(0);
    const overshoot = await sample(duration * 0.76);
    const end = await sample(duration);
    animation.play();
    return { duration, start, overshoot, end };
  });
  expect(headerMotion, "the shared rank heading has an entrance animation").not.toBeNull();
  expect(headerMotion!.duration).toBe(640);
  expect(headerMotion!.start.translateY).toBeGreaterThan(20);
  expect(headerMotion!.start.scale).toBeLessThan(0.95);
  expect(headerMotion!.overshoot.scale).toBeGreaterThan(1.02);
  expect(headerMotion!.end.translateY).toBeCloseTo(0, 0);
  expect(headerMotion!.end.scale).toBeCloseTo(1, 2);
  const stampMotion = await region
    .locator("[data-testid='presentation-exam-stamp']")
    .evaluate(async (stamp) => {
      const animation = stamp
        .getAnimations()
        .find((candidate) =>
          (candidate as CSSAnimation).animationName.includes("rankStampEntrance"),
        );
      if (!animation) return null;
      animation.pause();
      await animation.ready;
      const duration = Number(animation.effect?.getComputedTiming().duration);
      const sample = async (currentTime: number) => {
        animation.currentTime = currentTime;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const transform = new DOMMatrixReadOnly(getComputedStyle(stamp).transform);
        return {
          angle: (Math.atan2(transform.b, transform.a) * 180) / Math.PI,
          scale: Math.hypot(transform.a, transform.b),
        };
      };
      const start = await sample(0);
      const overshoot = await sample(duration * 0.68);
      const end = await sample(duration);
      animation.play();
      return { duration, start, overshoot, end };
    });
  expect(stampMotion, "the exam stamp has its own entrance animation").not.toBeNull();
  expect(stampMotion!.duration).toBe(720);
  expect(stampMotion!.start.angle).toBeCloseTo(-28, 0);
  expect(stampMotion!.start.scale).toBeCloseTo(0.5, 1);
  expect(stampMotion!.overshoot.angle).toBeGreaterThan(10);
  expect(stampMotion!.overshoot.scale).toBeGreaterThan(1.1);
  expect(stampMotion!.end.angle).toBeCloseTo(8, 0);
  expect(stampMotion!.end.scale).toBeCloseTo(1, 2);
  const shimmer = await region.locator("[class*='rankHeading']").evaluate(async (heading) => {
    const animation = heading
      .getAnimations({ subtree: true })
      .find((candidate) => (candidate as CSSAnimation).animationName.includes("rankLineShimmer"));
    if (!animation) return null;
    animation.pause();
    await animation.ready;
    const timing = animation.effect?.getComputedTiming();
    const duration = Number(timing?.duration);
    const delay = Number(timing?.delay);
    animation.currentTime = delay;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const startOpacity = Number.parseFloat(getComputedStyle(heading, "::after").opacity);
    animation.currentTime = delay + duration / 2;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const middleOpacity = Number.parseFloat(getComputedStyle(heading, "::after").opacity);
    animation.currentTime = delay + duration;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const finalOpacity = Number.parseFloat(getComputedStyle(heading, "::after").opacity);
    const rank = heading.querySelector<HTMLElement>("h1");
    return {
      duration,
      delay,
      startOpacity,
      middleOpacity,
      finalOpacity,
      rankOpacity: rank ? getComputedStyle(rank).opacity : null,
    };
  });
  expect(shimmer, "rank plate shimmer is attached to the shared heading").not.toBeNull();
  expect(shimmer!.duration).toBe(360);
  expect(shimmer!.delay).toBe(300);
  expect(shimmer!.startOpacity).toBe(0);
  expect(shimmer!.middleOpacity).toBeGreaterThan(0);
  expect(shimmer!.finalOpacity).toBe(0);
  expect(shimmer!.rankOpacity).toBe("1");
  await expectRankAnticipation(region, "first-place visibility timeline", true);
  const reveal = region.locator("[class*='winnerReveal']");
  await expect
    .poll(
      () =>
        reveal.evaluate((stage) => {
          const names = stage
            .getAnimations({ subtree: true })
            .map((animation) => (animation as CSSAnimation).animationName);
          return {
            winnerReveal: names.filter((name) => name.includes("rankWinnerReveal")).length,
            anticipation: names.filter((name) => name.includes("rankRevealAnticipation")).length,
          };
        }),
      { message: "first-place stage CSS animations are attached before timeline seeking" },
    )
    .toEqual({ winnerReveal: 1, anticipation: 2 });
  await captureFirstPlaceRevealTimeline(page, testInfo, region);
});

test("@chromium public and presenter routes are read-only unless an authenticated presenter progresses", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/presentation");
  await expect(page.getByTestId("presentation-canvas")).toBeVisible();

  await page.goto("/presentation?presenter=1");
  await expect(page).toHaveURL(/\/admin\/presentation$/);
  await expect(page.getByLabel("管理者 PIN")).toBeVisible();
  expect(mock.actionLog).toEqual([]);

  await signIn(page);
  await expect(page).toHaveURL(/\/admin\/presentation$/);
  await expect(page.getByRole("button", { name: "発表を開始" })).toBeVisible();
  await startPresentation(page);
  await openPresenter(page);
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  expect(mock.actionLog).toEqual(["aggregate", "start", "position"]);
});

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

test("@chromium opening cover geometry matches before and after presentation start", async ({
  page,
}) => {
  await installAdminApiMock(page);
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 1080 },
    { width: 480, height: 900 },
  ];
  const inspectOpening = async (targetPage: import("@playwright/test").Page) => {
    await targetPage.evaluate(() => document.fonts.ready);
    await waitForRenderFrames(targetPage);
    const heading = targetPage.getByRole("heading", { name: /^しゅんたま\s*検定$/ });
    return heading.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const headingStyle = getComputedStyle(element);
      const fontSize = Number.parseFloat(headingStyle.fontSize);
      const section = element.closest("section");
      const titleColumn = section?.querySelector<HTMLElement>("[class*='openingTitle']");
      const lockup = section?.querySelector<HTMLElement>("[class*='openingLockup']");
      const subtitle = section?.querySelector<HTMLElement>("[class*='openingSubtitle']");
      const waitSlot = section?.querySelector<HTMLElement>("[class*='openingWaitSlot']");
      const waitingCopy = waitSlot?.querySelector<HTMLElement>("[class*='openingWait']");
      const fitLayer = document.querySelector<HTMLElement>(
        "[data-testid='presentation-fit-layer']",
      );
      const measuredFitScale = Number.parseFloat(
        fitLayer?.style.getPropertyValue("--presentation-fit-scale") ?? "1",
      );
      const fitScale =
        Number.isFinite(measuredFitScale) && measuredFitScale > 0 ? measuredFitScale : 1;
      const fitLayerRect = fitLayer?.getBoundingClientRect();
      const fitViewport = document.querySelector<HTMLElement>(
        "[data-testid='presentation-fit-viewport']",
      );
      const fitViewportRect = fitViewport?.getBoundingClientRect();
      const isTextClippedByOverflow = (
        element: HTMLElement,
        textBounds: { x: number; y: number; width: number; height: number },
      ) => {
        for (
          let ancestor: HTMLElement | null = element;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          const rect = ancestor.getBoundingClientRect();
          const scaleX = ancestor.offsetWidth > 0 ? rect.width / ancestor.offsetWidth : 1;
          const scaleY = ancestor.offsetHeight > 0 ? rect.height / ancestor.offsetHeight : 1;
          const clipLeft = rect.left + ancestor.clientLeft * scaleX;
          const clipTop = rect.top + ancestor.clientTop * scaleY;
          const clipRight = clipLeft + ancestor.clientWidth * scaleX;
          const clipBottom = clipTop + ancestor.clientHeight * scaleY;
          const clipsX = ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
          const clipsY = ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
          if (
            (clipsX &&
              (textBounds.x < clipLeft - 1 || textBounds.x + textBounds.width > clipRight + 1)) ||
            (clipsY &&
              (textBounds.y < clipTop - 1 || textBounds.y + textBounds.height > clipBottom + 1))
          ) {
            return true;
          }
        }
        return false;
      };
      const titleSpans = Array.from(
        titleColumn?.querySelectorAll<HTMLElement>("h1 > span") ?? [],
        (span) => {
          const spanRect = span.getBoundingClientRect();
          const spanRange = document.createRange();
          spanRange.selectNodeContents(span);
          const textRects = Array.from(spanRange.getClientRects());
          const lineTops = textRects
            .map((textRect) => textRect.top)
            .sort((left, right) => left - right)
            .filter((top, index, tops) => index === 0 || Math.abs(top - tops[index - 1]!) > 2);
          const textRect = spanRange.getBoundingClientRect();
          const spanBounds = {
            x: spanRect.x,
            y: spanRect.y,
            width: spanRect.width,
            height: spanRect.height,
          };
          const textBounds = {
            x: textRect.x,
            y: textRect.y,
            width: textRect.width,
            height: textRect.height,
          };
          const scrollOverflowWidth = Math.max(0, span.scrollWidth - span.clientWidth) * fitScale;
          const scrollOverflowHeight =
            Math.max(0, span.scrollHeight - span.clientHeight) * fitScale;
          return {
            content: span.textContent?.trim() ?? "",
            fontSize: Number.parseFloat(getComputedStyle(span).fontSize),
            color: getComputedStyle(span).color,
            span: spanBounds,
            textBounds,
            scrollWidth: span.scrollWidth,
            clientWidth: span.clientWidth,
            scrollHeight: span.scrollHeight,
            clientHeight: span.clientHeight,
            scrollOverflowWidth,
            scrollOverflowHeight,
            lineCount: lineTops.length,
            textInsideFitLayer: Boolean(
              fitLayerRect &&
              textBounds.x >= fitLayerRect.left &&
              textBounds.x + textBounds.width <= fitLayerRect.right &&
              textBounds.y >= fitLayerRect.top &&
              textBounds.y + textBounds.height <= fitLayerRect.bottom,
            ),
            textInsideViewport: Boolean(
              fitViewportRect &&
              textBounds.x >= fitViewportRect.left &&
              textBounds.x + textBounds.width <= fitViewportRect.right &&
              textBounds.y >= fitViewportRect.top &&
              textBounds.y + textBounds.height <= fitViewportRect.bottom,
            ),
            clipped: isTextClippedByOverflow(span, textBounds),
          };
        },
      );
      const canvas = document.querySelector<HTMLElement>("[data-testid='presentation-canvas']");
      if (
        !section ||
        !titleColumn ||
        !lockup ||
        !subtitle ||
        !waitSlot ||
        !fitLayer ||
        !canvas ||
        !fitViewport
      ) {
        throw new Error("Presentation opening geometry is missing");
      }
      const canvasRect = canvas.getBoundingClientRect();
      const viewportRect = fitViewport.getBoundingClientRect();
      const relativeLuminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
        const [red, green, blue] = channels;
        if (red === undefined || green === undefined || blue === undefined) return 0;
        const linearize = (channel: number) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
      };
      const resolvedBackground = (element: HTMLElement) => {
        for (
          let ancestor: HTMLElement | null = element;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const color = getComputedStyle(ancestor).backgroundColor;
          const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
          if ((channels[3] ?? 1) > 0) return color;
        }
        throw new Error("Opening text has no opaque background ancestor");
      };
      const textContrasts = [
        ...Array.from(titleColumn.querySelectorAll<HTMLElement>("h1 > span")),
        subtitle,
      ].map((textElement) => {
        const style = getComputedStyle(textElement);
        const effectiveFontSize = Number.parseFloat(style.fontSize) * fitScale;
        const background = resolvedBackground(textElement);
        const foregroundLuminance = relativeLuminance(style.color);
        const backgroundLuminance = relativeLuminance(background);
        const minimumRatio =
          effectiveFontSize >= 24 ||
          (Number.parseInt(style.fontWeight, 10) >= 700 && effectiveFontSize >= 18.66)
            ? 3
            : 4.5;
        return {
          text: textElement.textContent?.trim() ?? "",
          color: style.color,
          fontSize: effectiveFontSize,
          background,
          ratio:
            (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
            (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
          minimumRatio,
        };
      });
      const bounds = (node: Element) => {
        const nodeRect = node.getBoundingClientRect();
        return {
          x: nodeRect.x,
          y: nodeRect.y,
          width: nodeRect.width,
          height: nodeRect.height,
        };
      };
      const outOfBounds = Array.from(fitViewport.querySelectorAll("*"))
        .filter((node) => getComputedStyle(node).visibility === "visible")
        .map((node) => node.getBoundingClientRect())
        .filter((bounds) => bounds.width > 0 && bounds.height > 0)
        .filter(
          (bounds) =>
            bounds.left < viewportRect.left - 1 ||
            bounds.right > viewportRect.right + 1 ||
            bounds.top < viewportRect.top - 1 ||
            bounds.bottom > viewportRect.bottom + 1,
        ).length;
      return {
        heading: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          fontSize,
          lineCount: Math.max(0, ...titleSpans.map((span) => span.lineCount)),
        },
        titleSpans,
        titleDividerColor: headingStyle.borderBottomColor,
        openingStampCount: section.querySelectorAll("[data-testid='presentation-exam-stamp']")
          .length,
        textContrasts,
        fitScale,
        titleColumn: bounds(titleColumn),
        lockup: bounds(lockup),
        fitLayer: bounds(fitLayer!),
        lockupContainsTitle: lockup.contains(titleColumn),
        waitSlot: bounds(waitSlot),
        waitSlotAriaHidden: waitSlot.getAttribute("aria-hidden"),
        waitingCopy: waitingCopy?.textContent?.trim() ?? null,
        waitSlotVisibility: getComputedStyle(waitSlot).visibility,
        waitingCopyVisibility: waitingCopy ? getComputedStyle(waitingCopy).visibility : null,
        canvas: {
          width: canvasRect.width,
          height: canvasRect.height,
          aspectRatio: canvasRect.width / canvasRect.height,
          insideViewport:
            canvasRect.left >= 0 &&
            canvasRect.top >= 0 &&
            canvasRect.right <= innerWidth &&
            canvasRect.bottom <= innerHeight,
        },
        outOfBounds,
        pageCanScroll:
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      };
    });
  };

  const renderedPlatformFonts = async (
    targetPage: import("@playwright/test").Page,
    selector: string,
  ) => {
    const session = await targetPage.context().newCDPSession(targetPage);
    try {
      await session.send("DOM.enable");
      await session.send("CSS.enable");
      const { root } = await session.send("DOM.getDocument");
      const { nodeId } = await session.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });
      if (!nodeId) throw new Error(`Rendered font target is missing: ${selector}`);
      const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      return fonts;
    } finally {
      await session.detach();
    }
  };

  const expectJapaneseGlyphsRendered = async (targetPage: import("@playwright/test").Page) => {
    const observed: {
      selector: string;
      text: string;
      fonts: Awaited<ReturnType<typeof renderedPlatformFonts>>;
      hasRenderedGlyphs: boolean;
    }[] = [];
    for (const [selector, expectedText] of [
      ["#presentation-title span:first-child, #opening-title span:first-child", "しゅんたま"],
      ["#presentation-title span:nth-child(2), #opening-title span:nth-child(2)", "検定"],
    ] as const) {
      const fonts = await renderedPlatformFonts(targetPage, selector);
      observed.push({
        selector,
        text: expectedText,
        fonts,
        hasRenderedGlyphs: fonts.some((font) => font.glyphCount > 0),
      });
    }
    for (const result of observed) {
      expect(
        result.hasRenderedGlyphs,
        `${result.text} Japanese glyphs must be rendered; observed platform fonts: ${JSON.stringify(result.fonts)}`,
      ).toBe(true);
    }
  };

  await page.setViewportSize(viewports[0]!);
  await page.goto("/presentation");
  await expect(page.locator("#presentation-title")).toBeVisible();
  const notStarted: Awaited<ReturnType<typeof inspectOpening>>[] = [];
  const expectSameBounds = (
    actual: Awaited<ReturnType<typeof inspectOpening>>["titleColumn"],
    expected: Awaited<ReturnType<typeof inspectOpening>>["titleColumn"],
  ) => {
    expect(actual.x).toBeCloseTo(expected.x, 1);
    expect(actual.y).toBeCloseTo(expected.y, 1);
    expect(actual.width).toBeCloseTo(expected.width, 1);
    expect(actual.height).toBeCloseTo(expected.height, 1);
  };
  const expectOpeningTextContrast = (
    geometry: Awaited<ReturnType<typeof inspectOpening>>,
    state: "not_started" | "opening",
  ) => {
    expect(geometry.textContrasts.map((entry) => entry.text)).toEqual([
      "しゅんたま",
      "検定",
      "解答解説・表彰",
    ]);
    expect(geometry.textContrasts.map((entry) => entry.color)).toEqual([
      "rgb(23, 62, 39)",
      "rgb(23, 62, 39)",
      "rgb(55, 66, 76)",
    ]);
    for (const entry of geometry.textContrasts) {
      expect(
        entry.ratio,
        `${state} text ${entry.text} needs ${entry.minimumRatio}:1 contrast against its rendered ${entry.background} background at ${entry.fontSize}px`,
      ).toBeGreaterThanOrEqual(entry.minimumRatio);
    }
  };
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready);
    await waitForRenderFrames(page);
    const geometry = await inspectOpening(page);
    expect(geometry.heading.lineCount).toBe(1);
    expect(geometry.titleSpans).toHaveLength(2);
    expect(geometry.titleSpans.map((span) => span.color)).toEqual([
      "rgb(23, 62, 39)",
      "rgb(23, 62, 39)",
    ]);
    expect(geometry.titleDividerColor).toBe("rgb(23, 62, 39)");
    expect(geometry.openingStampCount).toBe(0);
    expectOpeningTextContrast(geometry, "not_started");
    expect(
      geometry.titleSpans.every(
        (span) =>
          span.textBounds.width > 0 &&
          span.textBounds.height > 0 &&
          span.lineCount === 1 &&
          !span.clipped &&
          span.textInsideFitLayer &&
          span.textInsideViewport &&
          geometry.lockupContainsTitle,
      ),
      `Opening title span text must fit without clipping; geometry: ${JSON.stringify(
        {
          titleSpans: geometry.titleSpans,
          lockup: geometry.lockup,
          fitLayer: geometry.fitLayer,
          fitScale: geometry.fitScale,
        },
        null,
        2,
      )}`,
    ).toBe(true);
    expect(geometry.waitingCopy).toBe("発表が始まるまで、少々お待ちください");
    expect(geometry.waitSlotVisibility).toBe("visible");
    expect(geometry.waitingCopyVisibility).toBe("visible");
    expect(geometry.waitSlotAriaHidden).toBeNull();
    expect(geometry.canvas.aspectRatio).toBeCloseTo(16 / 9, 2);
    expect(geometry.canvas.insideViewport).toBe(true);
    expect(geometry.outOfBounds).toBe(0);
    expect(geometry.pageCanScroll).toBe(false);
    await expect(page.locator("#presentation-title")).toBeVisible();
    notStarted.push(geometry);
  }
  await expectJapaneseGlyphsRendered(page);

  const adminPage = await page.context().newPage();
  await signIn(adminPage);
  await adminPage.evaluate(async () => {
    for (const action of ["aggregate", "start"] as const) {
      const response = await fetch("/api/admin/presentation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID(), action }),
      });
      if (!response.ok) throw new Error(`Presentation ${action} failed: ${response.status}`);
    }
  });
  await expect
    .poll(() =>
      adminPage.evaluate(async () => {
        const response = await fetch("/api/admin/presentation?view=controls");
        return ((await response.json()) as { state: PresentationState }).state;
      }),
    )
    .toBe("opening");
  await expect(page.locator("#opening-title")).toBeVisible();
  await waitForCurrentPresentationEntryAnimations(page);
  await page.evaluate(() => document.fonts.ready);
  await waitForRenderFrames(page);

  for (let index = 0; index < viewports.length; index += 1) {
    await page.setViewportSize(viewports[index]!);
    await page.evaluate(() => document.fonts.ready);
    await waitForRenderFrames(page);
    const geometry = await inspectOpening(page);
    const beforeStart = notStarted[index]!;
    expect(geometry.heading.lineCount).toBe(1);
    expectOpeningTextContrast(geometry, "opening");
    expect(geometry.heading.x).toBeCloseTo(beforeStart.heading.x, 1);
    expect(geometry.heading.y).toBeCloseTo(beforeStart.heading.y, 1);
    expect(geometry.heading.width).toBeCloseTo(beforeStart.heading.width, 1);
    expect(geometry.heading.height).toBeCloseTo(beforeStart.heading.height, 1);
    expect(geometry.heading.fontSize).toBeCloseTo(beforeStart.heading.fontSize, 1);
    expect(geometry.titleSpans.map((span) => span.content)).toEqual(
      beforeStart.titleSpans.map((span) => span.content),
    );
    expect(geometry.titleSpans.map((span) => span.color)).toEqual([
      "rgb(23, 62, 39)",
      "rgb(23, 62, 39)",
    ]);
    expect(geometry.titleDividerColor).toBe("rgb(23, 62, 39)");
    expect(geometry.openingStampCount).toBe(0);
    for (const span of geometry.titleSpans) {
      const beforeSpan = beforeStart.titleSpans.find(
        (candidate) => candidate.content === span.content,
      )!;
      expect(span.fontSize).toBeCloseTo(beforeSpan.fontSize, 1);
      expectSameBounds(span.span, beforeSpan.span);
      expectSameBounds(span.textBounds, beforeSpan.textBounds);
      expect(span.textBounds.width).toBeGreaterThan(0);
      expect(span.textBounds.height).toBeGreaterThan(0);
      expect(span.lineCount).toBe(1);
      expect(
        !span.clipped &&
          geometry.lockupContainsTitle &&
          span.textInsideFitLayer &&
          span.textInsideViewport,
        `Opening title text must fit after start; geometry: ${JSON.stringify(
          {
            span,
            lockup: geometry.lockup,
            fitLayer: geometry.fitLayer,
            fitScale: geometry.fitScale,
          },
          null,
          2,
        )}`,
      ).toBe(true);
    }
    expectSameBounds(geometry.titleColumn, beforeStart.titleColumn);
    expectSameBounds(geometry.lockup, beforeStart.lockup);
    expectSameBounds(geometry.waitSlot, beforeStart.waitSlot);
    expect(geometry.lockupContainsTitle).toBe(true);
    expect(geometry.waitingCopy).toBe("発表が始まるまで、少々お待ちください");
    expect(geometry.waitSlotVisibility).toBe("visible");
    expect(geometry.waitingCopyVisibility).toBe("hidden");
    expect(geometry.waitSlotAriaHidden).toBe("true");
    expect(geometry.canvas.aspectRatio).toBeCloseTo(16 / 9, 2);
    expect(geometry.canvas.insideViewport).toBe(true);
    expect(geometry.outOfBounds).toBe(0);
    expect(geometry.pageCanScroll).toBe(false);
    await expect(page.locator("#opening-title")).toBeVisible();
  }
  await adminPage.close();
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

test("@chromium all rank entries fit on the slide without vertical scrolling under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await installAdminApiMock(page);
  const selectedCorrectResult: E2EWinnerQuestionResult = {
    position: 0,
    question: null,
    answer: { kind: "selected", value: null },
    correctness: "correct",
  };
  const thirdPlaceWinners: E2EWinnerEntry[] = Array.from({ length: 24 }, (_, index) => ({
    displayName: `受賞者${index + 1}`,
    score: 1,
    rank: 3,
    questionResults: [selectedCorrectResult],
  }));
  mock.setWinnerEntries([
    ...thirdPlaceWinners,
    {
      displayName: "第二位の受賞者",
      score: 2,
      rank: 2,
      questionResults: [selectedCorrectResult],
    },
    {
      displayName: "第一位の受賞者",
      score: 3,
      rank: 1,
      questionResults: [selectedCorrectResult],
    },
  ]);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");
  const winners = page.getByRole("region", { name: "第三位の勝者一覧" });
  await expect(winners).toBeVisible();
  await expect(winners).not.toHaveClass(/announce/);
  const reveal = winners.locator("[class*='winnerReveal']");
  const content = reveal.locator("[class*='winnerContent']");
  await expectRankRevealGeometry(winners);
  await expect(content).toHaveCSS("animation-name", "none");
  await expect(reveal).toHaveCSS("opacity", "1");
  await expect(content).toHaveCSS("opacity", "1");
  await expect(content).toHaveCSS("transform", "none");
  await expect
    .poll(() => content.evaluate((node) => getComputedStyle(node).animationDelay))
    .toBe("0s");
  const conciseAnnouncement = await page.getByRole("status").textContent();
  expect(conciseAnnouncement?.trim()).toBe("第三位を発表します");
  expect(conciseAnnouncement).not.toContain("受賞者");
  const rankTitle = winners.locator("[class*='rankHeader'] h1[class*='rank']");
  await expect(rankTitle).toHaveCount(1);
  await expect(rankTitle).toHaveText("第三位");
  const stamp = winners.locator("[data-testid='presentation-exam-stamp']");
  await expect(stamp).toHaveCount(1);
  await expect(stamp).toHaveAttribute("aria-hidden", "true");
  await expect(stamp).toHaveAttribute("src", /cert_stamp\.png/);
  await expect(winners.locator("[class*='rankOrnament']")).toHaveCSS("animation-name", "none");
  await expect(stamp).toHaveCSS("animation-name", "none");
  await expectRankAnticipation(winners, "reduced-motion third-place entry", false);
  const canvas = page.getByTestId("presentation-canvas");
  const frame = canvas.locator("img[class*='presentationFrame']");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("src", "/certificate_reference_style_16x9.svg");
  await expect
    .poll(() =>
      Promise.all([
        winners.evaluate((region) => {
          const outer = getComputedStyle(region);
          const after = getComputedStyle(region, "::after");
          return {
            borderWidths: [
              outer.borderTopWidth,
              outer.borderRightWidth,
              outer.borderBottomWidth,
              outer.borderLeftWidth,
            ],
            afterGenerated: !["none", "normal"].includes(after.content),
          };
        }),
        frame.evaluate((element) => {
          const canvas = element.parentElement;
          const fitViewport = canvas?.querySelector<HTMLElement>(
            "[data-testid='presentation-fit-viewport']",
          );
          const frameStyle = getComputedStyle(element);
          const fitStyle = fitViewport ? getComputedStyle(fitViewport) : null;
          const frameRect = element.getBoundingClientRect();
          const canvasRect = canvas?.getBoundingClientRect();
          const image = element instanceof HTMLImageElement ? element : null;
          return {
            directCanvasChild: canvas?.matches("[data-testid='presentation-canvas']") ?? false,
            outsideFitLayer: element.closest("[data-testid='presentation-fit-layer']") === null,
            imageLoaded: Boolean(image?.complete && image.naturalWidth > 0),
            intrinsicRatioPreserved: Boolean(
              image && Math.abs(image.naturalWidth / image.naturalHeight - 16 / 9) < 0.001,
            ),
            frameZIndex: frameStyle.zIndex,
            fitZIndex: fitStyle?.zIndex,
            objectFit: frameStyle.objectFit,
            pointerEvents: frameStyle.pointerEvents,
            coversCanvas: Boolean(
              canvasRect &&
              Math.abs(frameRect.left - canvasRect.left) <= 1 &&
              Math.abs(frameRect.top - canvasRect.top) <= 1 &&
              Math.abs(frameRect.right - canvasRect.right) <= 1 &&
              Math.abs(frameRect.bottom - canvasRect.bottom) <= 1,
            ),
          };
        }),
      ]),
    )
    .toEqual([
      { borderWidths: ["0px", "0px", "0px", "0px"], afterGenerated: false },
      {
        directCanvasChild: true,
        outsideFitLayer: true,
        imageLoaded: true,
        intrinsicRatioPreserved: true,
        frameZIndex: "0",
        fitZIndex: "1",
        objectFit: "contain",
        pointerEvents: "none",
        coversCanvas: true,
      },
    ]);
  await expect
    .poll(() =>
      winners.evaluate((region) => {
        const header = region.querySelector<HTMLElement>("[class*='rankHeader']");
        const rankTitle = header?.querySelector<HTMLElement>("h1[class*='rank']");
        const rankHeading = header?.querySelector<HTMLElement>("[class*='rankHeading']");
        const stamp = region.querySelector<HTMLElement>("[data-testid='presentation-exam-stamp']");
        return Boolean(
          header &&
          stamp &&
          rankTitle &&
          rankHeading &&
          header.contains(rankTitle) &&
          rankHeading.contains(rankTitle),
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page
        .getByTestId("presentation-fit-layer")
        .evaluate((node) => Number(node.style.getPropertyValue("--presentation-fit-scale"))),
    )
    .toBeLessThanOrEqual(1);
  const bounds = await page.getByTestId("presentation-canvas").evaluate((canvas) => {
    const fitViewport = canvas.querySelector<HTMLElement>(
      "[data-testid='presentation-fit-viewport']",
    );
    if (!fitViewport) throw new Error("Presentation fit viewport is missing");
    const fitRect = fitViewport.getBoundingClientRect();
    const toBounds = (rect: DOMRect) => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    });
    const winnerRects = Array.from(fitViewport.querySelectorAll("article"), (node) =>
      toBounds(node.getBoundingClientRect()),
    );
    const contentRects = Array.from(fitViewport.querySelectorAll("*"))
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map(toBounds);
    return {
      fitViewport: toBounds(fitRect),
      winners: winnerRects,
      content: contentRects,
      pageCanScroll: document.documentElement.scrollHeight > innerHeight,
      regionCanScroll: winnersCanScroll(canvas),
    };
    function winnersCanScroll(root: Element) {
      const region = root.querySelector("[aria-label='第三位の勝者一覧']");
      return region instanceof HTMLElement && region.scrollHeight > region.clientHeight;
    }
  });
  expect(bounds.pageCanScroll).toBe(false);
  expect(bounds.regionCanScroll).toBe(false);
  expect(bounds.winners).toHaveLength(2);
  const winnerCards = winners.locator("article");
  await expect(winnerCards).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expect(winnerCards.nth(index).locator("h1")).toContainText(`受賞者${index + 1}`);
    await expect(winnerCards.nth(index).locator("[class*='winnerScore']")).toHaveText(
      "1.00 ポイント",
    );
  }
  await expect(winners.locator("[class*='additionalWinners']")).toHaveText("ほか 22 名");
  const stampClearsRemainingCount = await winners.evaluate((region) => {
    const stamp = region.querySelector<HTMLElement>("[data-testid='presentation-exam-stamp']");
    const count = region.querySelector<HTMLElement>("[class*='additionalWinners']");
    if (!stamp || !count) return false;
    const stampRect = stamp.getBoundingClientRect();
    const countRect = count.getBoundingClientRect();
    return (
      stampRect.right <= countRect.left ||
      countRect.right <= stampRect.left ||
      stampRect.bottom <= countRect.top ||
      countRect.bottom <= stampRect.top
    );
  });
  expect(stampClearsRemainingCount).toBe(true);
  expect(
    [...bounds.winners, ...bounds.content].every(
      (rect) =>
        rect.left >= bounds.fitViewport.left - 1 &&
        rect.right <= bounds.fitViewport.right + 1 &&
        rect.top >= bounds.fitViewport.top - 1 &&
        rect.bottom <= bounds.fitViewport.bottom + 1,
    ),
  ).toBe(true);
  expect(mock.getPresentationState().state).toBe("third");

  for (const state of ["second", "first"] as const) {
    const entry = nextAdminMutation(page);
    await page.locator("main").press("ArrowRight");
    await expect(slideFor(page, state)).toBeVisible();
    await entry;
    await expectRankRevealGeometry(
      page.getByRole("region", {
        name: state === "second" ? "第二位の勝者一覧" : "第一位の勝者一覧",
      }),
    );
  }
});

test("@chromium rank winner reveal plays once per stage entry and not on same-stage refresh", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    window.__rankAnimationTimeline = [];
    const identities = new WeakMap<Animation, number>();
    let nextIdentity = 1;
    window.__rankAnimationIdentity = (animation) => {
      let identity = identities.get(animation);
      if (identity === undefined) {
        identity = nextIdentity++;
        identities.set(animation, identity);
      }
      return identity;
    };
    for (const kind of ["animationstart", "animationend"] as const) {
      document.addEventListener(
        kind,
        (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const name = (event as AnimationEvent).animationName;
          if (
            !/rankHeaderEntrance|rankPlateEntrance|rankWinnerReveal|rankOrnamentEntrance|rankStampEntrance|rankRevealAnticipation|rankLineShimmer/.test(
              name,
            )
          )
            return;
          const animation = target
            .getAnimations()
            .find((candidate) => (candidate as CSSAnimation).animationName === name);
          if (!animation) return;
          const rank = target.closest("[data-rank]")?.getAttribute("data-rank") ?? null;
          const identity = window.__rankAnimationIdentity(animation);
          window.__rankAnimationTimeline.push({
            kind: kind === "animationstart" ? "start" : "end",
            rank,
            name,
            timestamp: event.timeStamp,
            identity,
            startTime: animation.startTime === null ? null : Number(animation.startTime),
            currentTime: animation.currentTime === null ? null : Number(animation.currentTime),
          });
        },
        true,
      );
    }
  });
  type RankRevealSnapshot = {
    rank: string;
    name: string;
    identity: number;
    currentTime: number | null;
    playState: AnimationPlayState;
  };
  const captureRankReveal = (rank: string) =>
    page.evaluate((entryRank): RankRevealSnapshot | null => {
      const regions = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="presentation-canvas"] section[class*="winners"][data-rank="${entryRank}"]`,
        ),
      ].filter(
        (candidate) =>
          candidate.getClientRects().length > 0 &&
          getComputedStyle(candidate).visibility !== "hidden",
      );
      const region = regions.length === 1 ? regions[0] : null;
      const reveal = region?.querySelector<HTMLElement>("[class*='winnerReveal']");
      const animation = reveal
        ?.querySelector<HTMLElement>("[class*='winnerContent']")
        ?.getAnimations()
        .find((candidate) =>
          (candidate as CSSAnimation).animationName.includes("rankWinnerReveal"),
        );
      if (!animation) return null;
      return {
        rank: entryRank,
        name: (animation as CSSAnimation).animationName,
        identity: window.__rankAnimationIdentity(animation),
        currentTime: animation.currentTime === null ? null : Number(animation.currentTime),
        playState: animation.playState,
      };
    }, rank);
  const waitForRankReveal = async (rank: string) => {
    await expect.poll(async () => (await captureRankReveal(rank)) !== null).toBe(true);
    const snapshot = await captureRankReveal(rank);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.name).toContain("rankWinnerReveal");
    expect(snapshot!.rank).toBe(rank);
    return snapshot!;
  };
  type RankEffectSnapshot = {
    reveal: RankRevealSnapshot;
    header: RankRevealSnapshot;
    plate: RankRevealSnapshot;
    ornament: RankRevealSnapshot;
    medal: RankRevealSnapshot;
    shimmer: RankRevealSnapshot;
  };
  const captureRankEffects = async (rank: string): Promise<RankEffectSnapshot | null> =>
    page.evaluate((entryRank): RankEffectSnapshot | null => {
      const regions = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="presentation-canvas"] section[class*="winners"][data-rank="${entryRank}"]`,
        ),
      ].filter(
        (candidate) =>
          candidate.getClientRects().length > 0 &&
          getComputedStyle(candidate).visibility !== "hidden",
      );
      if (regions.length !== 1) return null;
      const region = regions[0];
      const find = (selector: string, fragment: string): RankRevealSnapshot | null => {
        const element = region.querySelector<HTMLElement>(selector);
        const animation = element
          ?.getAnimations({ subtree: true })
          .find((candidate) => (candidate as CSSAnimation).animationName.includes(fragment));
        return animation
          ? {
              rank: entryRank,
              name: (animation as CSSAnimation).animationName,
              identity: window.__rankAnimationIdentity(animation),
              currentTime: animation.currentTime === null ? null : Number(animation.currentTime),
              playState: animation.playState,
            }
          : null;
      };
      const reveal = find("[class*='winnerContent']", "rankWinnerReveal");
      const header = find("[class*='rankHeader']", "rankHeaderEntrance");
      const plate = find("[class*='rankHeader'] h1[class*='rank']", "rankPlateEntrance");
      const ornament = find("[class*='rankOrnament']", "rankOrnamentEntrance");
      const medal = find("[data-testid='presentation-exam-stamp']", "rankStampEntrance");
      const shimmer = find("[class*='rankHeading']", "rankLineShimmer");
      return reveal && header && plate && ornament && medal && shimmer
        ? { reveal, header, plate, ornament, medal, shimmer }
        : null;
    }, rank);
  const waitForRankEffects = async (rank: string) => {
    await expect.poll(async () => (await captureRankEffects(rank)) !== null).toBe(true);
    return (await captureRankEffects(rank))!;
  };
  type DecorationIdentityPair = Record<
    "header" | "plate" | "ornament" | "medal" | "shimmer",
    number
  >;
  const latestDecorationEntry = async (rank: string): Promise<DecorationIdentityPair> => {
    const effects = await waitForRankEffects(rank);
    return {
      header: effects.header.identity,
      plate: effects.plate.identity,
      ornament: effects.ornament.identity,
      medal: effects.medal.identity,
      shimmer: effects.shimmer.identity,
    };
  };
  const expectFreshDecorationEntry = (
    actual: DecorationIdentityPair,
    previous: DecorationIdentityPair,
  ) => {
    expect(actual.header).not.toBe(previous.header);
    expect(actual.plate).not.toBe(previous.plate);
    expect(actual.ornament).not.toBe(previous.ornament);
    expect(actual.medal).not.toBe(previous.medal);
    expect(actual.shimmer).not.toBe(previous.shimmer);
  };
  const mock = await installAdminApiMock(page);
  mock.setWinnerEntries([
    { displayName: "第三位の受賞者", score: 0.5, rank: 3 },
    { displayName: "太郎", score: 0, rank: 2 },
    { displayName: "花子", score: 1, rank: 1 },
  ]);
  await signIn(page);
  await startPresentation(page);
  mock.setPresentationPosition("third");
  const initialPauseStyle = await pauseRankRevealOnNextDocument(page);
  await openPresenter(page);
  const thirdRegion = rankRegionFor(page, "third");
  await expect(thirdRegion).toHaveCount(1);
  await expectRankAnticipation(thirdRegion, "third-place entry", false);
  await expect(thirdRegion.getByRole("heading", { name: "第三位", exact: true })).toBeVisible();
  const thirdReveal = thirdRegion.locator("[class*='winnerReveal']");
  const thirdContent = thirdReveal.locator("[class*='winnerContent']");
  await expect(thirdReveal).toHaveCount(1);
  await expect(thirdReveal.locator("article").first()).toBeAttached();
  expect(await thirdReveal.getAttribute("aria-hidden")).toBeNull();
  await expect(thirdContent).toHaveCSS("animation-delay", "0.76s");
  await expect(thirdContent).toHaveCSS("animation-duration", "0.54s");
  await expectRankRevealGeometry(thirdRegion, "during-delay", initialPauseStyle);
  const thirdRevealSnapshot = await waitForRankReveal("third");
  await latestDecorationEntry("third");
  await expect(thirdReveal).toHaveCSS("opacity", "1");
  await expect(thirdContent).toHaveCSS("opacity", "1");
  await expectRankRevealGeometry(thirdRegion);

  const secondPauseStyle = await pauseRankRevealBeforeEntry(page);
  const secondEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "second")).toBeVisible();
  await expectRankRevealGeometry(rankRegionFor(page, "second"), "during-delay", secondPauseStyle);
  await secondEntry;
  const secondRevealSnapshot = await waitForRankReveal("second");
  expect(secondRevealSnapshot.identity).not.toBe(thirdRevealSnapshot.identity);
  await expectRankAnticipation(rankRegionFor(page, "second"), "second-place entry", false);
  const secondDecorationEntry = await latestDecorationEntry("second");

  const firstPauseStyle = await pauseRankRevealBeforeEntry(page);
  const firstEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "first")).toBeVisible();
  await expectRankRevealGeometry(rankRegionFor(page, "first"), "during-delay", firstPauseStyle);
  await firstEntry;
  const firstRevealSnapshot = await waitForRankReveal("first");
  expect(firstRevealSnapshot.identity).not.toBe(secondRevealSnapshot.identity);
  await latestDecorationEntry("first");
  expect(
    new Set([
      thirdRevealSnapshot.identity,
      secondRevealSnapshot.identity,
      firstRevealSnapshot.identity,
    ]).size,
  ).toBe(3);
  const firstRegion = rankRegionFor(page, "first");
  await expect(firstRegion).toHaveCount(1);
  const firstOrnament = firstRegion.locator("[class*='rankOrnament']");
  const firstStamp = firstRegion.locator("[data-testid='presentation-exam-stamp']");
  await expectRankAnticipation(firstRegion, "first-place rank entry reveal", true);
  await expect(firstOrnament).toHaveCSS("animation-duration", "0.65s");
  await expect(firstOrnament).toHaveCSS("animation-delay", "0.08s");
  await expect(firstStamp).toHaveCSS("animation-duration", "0.72s");
  await expect(firstRegion.locator("[class*='rankHeader']")).toHaveCSS(
    "animation-duration",
    "0.64s",
  );
  await expect(firstOrnament).toHaveAttribute("aria-hidden", "true");
  await expect(firstStamp).toHaveAttribute("aria-hidden", "true");
  const anticipationGeometry = await firstRegion
    .locator("[class*='winnerReveal']")
    .evaluate((node) =>
      ["::before", "::after"].map((pseudo) => {
        const style = getComputedStyle(node, pseudo);
        return {
          animationNameIncludes: style.animationName.includes("rankRevealAnticipation"),
          animationDuration: style.animationDuration,
          animationDelay: style.animationDelay,
          pointerEvents: style.pointerEvents,
        };
      }),
    );
  expect(anticipationGeometry).toEqual([
    {
      animationNameIncludes: true,
      animationDuration: "0.76s",
      animationDelay: "0s",
      pointerEvents: "none",
    },
    {
      animationNameIncludes: true,
      animationDuration: "0.76s",
      animationDelay: "0s",
      pointerEvents: "none",
    },
  ]);
  await expect(firstOrnament).toHaveCSS("pointer-events", "none");
  await expect(firstStamp).toHaveCSS("pointer-events", "none");

  const backPauseStyle = await pauseRankRevealBeforeEntry(page);
  const backEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "second")).toBeVisible();
  await expectRankRevealGeometry(rankRegionFor(page, "second"), "during-delay", backPauseStyle);
  await backEntry;
  const secondBackRevealSnapshot = await waitForRankReveal("second");
  expect(secondBackRevealSnapshot.identity).not.toBe(secondRevealSnapshot.identity);
  const secondBackDecorationEntry = await latestDecorationEntry("second");
  expectFreshDecorationEntry(secondBackDecorationEntry, secondDecorationEntry);
  const controlsReadsBeforeRefresh = mock
    .getPresentationRouteEvents()
    .filter((event) => event === "controls:get").length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect
    .poll(
      () => mock.getPresentationRouteEvents().filter((event) => event === "controls:get").length,
    )
    .toBeGreaterThan(controlsReadsBeforeRefresh);
  const secondAfterPollSnapshot = await waitForRankReveal("second");
  expect(secondAfterPollSnapshot.identity).toBe(secondBackRevealSnapshot.identity);
  expect(secondAfterPollSnapshot.currentTime).toBeGreaterThanOrEqual(
    secondBackRevealSnapshot.currentTime!,
  );

  // Reloading a presenter already positioned on a rank stage is a direct stage entry.
  await page.reload();
  await expect(slideFor(page, "second")).toBeVisible();
  const reloadedSecondRevealSnapshot = await waitForRankReveal("second");
  const reloadedSecondDecorationEntry = await latestDecorationEntry("second");
  const previousRank = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "third")).toBeVisible();
  await previousRank;
  const reloadedThirdRevealSnapshot = await waitForRankReveal("third");
  expect(reloadedThirdRevealSnapshot.identity).not.toBe(reloadedSecondRevealSnapshot.identity);
  const reloadedThirdDecorationEntry = await latestDecorationEntry("third");
  const previousPodium = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "podium_preview")).toBeVisible();
  await previousPodium;

  // Canvas tap enters third place; a horizontal swipe enters second place.
  const tapEntry = nextAdminMutation(page);
  await page.getByTestId("presentation-canvas").click();
  await expect(slideFor(page, "third")).toBeVisible();
  await tapEntry;
  const thirdReentryRevealSnapshot = await waitForRankReveal("third");
  expect(thirdReentryRevealSnapshot.identity).not.toBe(reloadedThirdRevealSnapshot.identity);
  const thirdReentryDecorationEntry = await latestDecorationEntry("third");
  expectFreshDecorationEntry(thirdReentryDecorationEntry, reloadedThirdDecorationEntry);

  const canvasBounds = await page.getByTestId("presentation-canvas").boundingBox();
  expect(canvasBounds).not.toBeNull();
  const swipeEntry = nextAdminMutation(page);
  const swipeY = canvasBounds!.y + canvasBounds!.height / 2;
  await page.mouse.move(canvasBounds!.x + canvasBounds!.width * 0.75, swipeY);
  await page.mouse.down();
  await page.mouse.move(canvasBounds!.x + canvasBounds!.width * 0.25, swipeY, { steps: 4 });
  await page.mouse.up();
  await expect(slideFor(page, "second")).toBeVisible();
  await swipeEntry;
  const secondSwipeRevealSnapshot = await waitForRankReveal("second");
  expect(secondSwipeRevealSnapshot.identity).not.toBe(reloadedSecondRevealSnapshot.identity);
  const secondSwipeDecorationEntry = await latestDecorationEntry("second");
  expectFreshDecorationEntry(secondSwipeDecorationEntry, reloadedSecondDecorationEntry);

  // Reasserting the same rank by absolute position does not replay the reveal.
  const sameRankPosition = await page.evaluate(async () => {
    const controlsResponse = await fetch("/api/admin/presentation?view=controls");
    if (!controlsResponse.ok) return { ok: false, status: controlsResponse.status };
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
    return { ok: response.ok, status: response.status };
  });
  expect(sameRankPosition.ok, `Same-rank position failed: ${sameRankPosition.status}`).toBe(true);
  const controlsReadsBeforeSameRankRefresh = mock
    .getPresentationRouteEvents()
    .filter((event) => event === "controls:get").length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect
    .poll(
      () => mock.getPresentationRouteEvents().filter((event) => event === "controls:get").length,
    )
    .toBeGreaterThan(controlsReadsBeforeSameRankRefresh);
  const secondAfterSamePositionSnapshot = await waitForRankReveal("second");
  expect(secondAfterSamePositionSnapshot.identity).toBe(secondSwipeRevealSnapshot.identity);
  expect(secondAfterSamePositionSnapshot.currentTime).toBeGreaterThanOrEqual(
    secondSwipeRevealSnapshot.currentTime!,
  );
  expect(await latestDecorationEntry("second")).toEqual(secondSwipeDecorationEntry);

  // A direct position to a different rank is a new stage entry and replays the reveal.
  const directPosition = await page.evaluate(async () => {
    const controlsResponse = await fetch("/api/admin/presentation?view=controls");
    if (!controlsResponse.ok) return { ok: false, status: controlsResponse.status };
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
        state: "first",
        questionIndex: 0,
        expectedSnapshotRevision: controls.snapshotRevision,
        expectedSessionVersion: controls.version,
      }),
    });
    return { ok: response.ok, status: response.status };
  });
  expect(directPosition.ok, `Direct position failed: ${directPosition.status}`).toBe(true);
  await expect(slideFor(page, "first")).toBeVisible();
  const firstDirectRevealSnapshot = await waitForRankReveal("first");
  expect(firstDirectRevealSnapshot.identity).not.toBe(secondAfterSamePositionSnapshot.identity);
  const firstReentryDecorationEntry = await latestDecorationEntry("first");

  const secondAfterFirst = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "second")).toBeVisible();
  await secondAfterFirst;
  const secondAfterFirstSnapshot = await waitForRankReveal("second");
  expect(secondAfterFirstSnapshot.identity).not.toBe(secondAfterSamePositionSnapshot.identity);
  const secondThirdDecorationEntry = await latestDecorationEntry("second");
  expectFreshDecorationEntry(secondThirdDecorationEntry, secondSwipeDecorationEntry);

  const firstReentry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "first")).toBeVisible();
  await firstReentry;
  const firstSecondRevealSnapshot = await waitForRankReveal("first");
  expect(firstSecondRevealSnapshot.identity).not.toBe(firstDirectRevealSnapshot.identity);
  const firstSecondDecorationEntry = await latestDecorationEntry("first");
  expectFreshDecorationEntry(firstSecondDecorationEntry, firstReentryDecorationEntry);

  mock.setPresentationPosition("second");
  const spectator = await page.context().newPage();
  await spectator.addInitScript(() => {
    window.__rankRevealAnimations = [];
    document.addEventListener(
      "animationstart",
      (event) => {
        const target = event.target;
        if (
          !(target instanceof HTMLElement) ||
          !target.matches("[class*='winnerReveal'], [class*='winnerContent']")
        )
          return;
        window.__rankRevealAnimations.push({
          rank: target.closest("[data-rank]")?.getAttribute("data-rank") ?? null,
          name: (event as AnimationEvent).animationName,
        });
      },
      true,
    );
  });
  await spectator.goto("/presentation");
  await expect(spectator.getByRole("region", { name: "第二位の勝者一覧" })).toBeVisible();
  await expect.poll(() => spectator.evaluate(() => window.__rankRevealAnimations.length)).toBe(1);
  expect(await spectator.evaluate(() => window.__rankRevealAnimations[0]?.rank)).toBe("second");
  await spectator.close();

  mock.setPresentationPosition("first");
  await expect(slideFor(page, "first")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedFirst = rankRegionFor(page, "first");
  await expect(reducedFirst).toHaveCount(1);
  const reducedContent = reducedFirst.locator("[class*='winnerContent']");
  await expect(reducedContent).toHaveCSS("animation-name", "none");
  await expect(reducedContent).toHaveCSS("transform", "none");
  await expect(reducedFirst.locator("[class*='rankHeader']")).toHaveCSS("animation-name", "none");
  expect(
    await reducedFirst
      .locator("[class*='rankHeader'] h1[class*='rank']")
      .evaluate((rank) => getComputedStyle(rank, "::before").animationName),
  ).toBe("none");
  await expect(reducedFirst.locator("[class*='rankOrnament']")).toHaveCSS("animation-name", "none");
  await expect(reducedFirst.locator("[class*='rankOrnament']")).toHaveCSS("opacity", "0.55");
  await expect(reducedFirst.locator("[data-testid='presentation-exam-stamp']")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(reducedFirst.locator("[data-testid='presentation-exam-stamp']")).toHaveCSS(
    "opacity",
    "1",
  );
  expect(
    await reducedFirst
      .locator("[class*='rankHeading']")
      .evaluate((heading) => getComputedStyle(heading, "::after").animationName),
  ).toBe("none");
  expect(
    await reducedFirst
      .locator("[class*='rankHeading']")
      .evaluate((heading) => getComputedStyle(heading, "::after").opacity),
  ).toBe("0");
  await expectRankAnticipation(reducedFirst, "reduced-motion first-place reveal", true, "reduced");
  const reducedReveal = reducedFirst.locator("[class*='winnerReveal']");
  await expect(reducedReveal).toHaveCSS("opacity", "1");
  const reducedPseudoOpacity = await reducedReveal.evaluate((element) =>
    ["::before", "::after"].map((pseudo) => getComputedStyle(element, pseudo).opacity),
  );
  expect(reducedPseudoOpacity).toEqual(["0", "0"]);
});

test("@chromium generic slide entrances honor their stage and dynamic reduced motion", async ({
  page,
}) => {
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
    await expectPresentationEntryAnimation(entryFor(page, state));
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
        await advancePresenterTo(page, "finished");
      }
    }
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectReducedEntry(entryFor(page, "finished"));

  const reducedMotionStages: PresentationState[] = [
    "first",
    "second",
    "third",
    "podium_preview",
    "answer",
    "question",
    "opening",
  ];
  for (const state of reducedMotionStages) {
    await returnPresenterTo(page, state);
    if (state === "opening" || state === "question" || state === "podium_preview") {
      await expectReducedEntry(entryFor(page, state));
    }
    if (state === "question") {
      const choices = page.locator("#question-heading + ol li");
      await expect(choices).toHaveCount(questions[0].choices.length);
      const choiceStyles = await choices.evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            animationName: style.animationName,
            animationDelay: style.animationDelay,
            opacity: style.opacity,
            transform: style.transform,
          };
        }),
      );
      for (const style of choiceStyles) {
        expect(style).toEqual({
          animationName: "none",
          animationDelay: "0s",
          opacity: "1",
          transform: "none",
        });
      }
    }
  }
});

test("@chromium fit readiness hides an unmeasured slide and reveals it after layout recovers", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class NoopResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: NoopResizeObserver,
    });
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const fitReadyForTest = (window as Window & { __presentationFitReadyForTest?: boolean })
        .__presentationFitReadyForTest;
      if (
        fitReadyForTest !== true &&
        this.getAttribute("data-testid") === "presentation-fit-viewport"
      ) {
        return new DOMRect(0, 0, 0, 0);
      }
      return originalGetBoundingClientRect.call(this);
    };
  });
  const mock = await installAdminApiMock(page);
  await signIn(page);
  mock.setPresentationPosition("opening");
  await openPresenter(page);

  const naturalLayer = page.getByTestId("presentation-natural-layer");
  await expect(naturalLayer).toHaveAttribute("data-fit-ready", "false");
  await expect(naturalLayer).toHaveCSS("visibility", "hidden");
  await page.evaluate(() => {
    (window as Window & { __presentationFitReadyForTest?: boolean }).__presentationFitReadyForTest =
      true;
    window.dispatchEvent(new Event("resize"));
  });
  await expect(naturalLayer).toHaveAttribute("data-fit-ready", "true");
  await expect(naturalLayer).toHaveCSS("visibility", "visible");
  await expect(slideFor(page, "opening")).toBeVisible();
});

test("@chromium stale slide mask releases after the matching deck is fetched", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  mock.setPresentationPosition("question");
  await openPresenter(page);
  const naturalLayer = page.getByTestId("presentation-natural-layer");
  await expect(slideFor(page, "question")).toBeVisible();

  mock.advanceSnapshotRevision();
  mock.failNextDeckRead();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(naturalLayer).toHaveAttribute("data-stale-hidden", "true");
  const staleContent = naturalLayer.locator("[data-stale-hidden='true']");
  await expect(staleContent).toHaveAttribute("aria-hidden", "true");
  await expect(staleContent).toHaveAttribute("inert", "");

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(naturalLayer).not.toHaveAttribute("data-stale-hidden", "true");
  await expect(slideFor(page, "question")).toBeVisible();
  await expect(naturalLayer.locator("[aria-hidden='true'][inert]")).toHaveCount(0);
  expect(mock.getPresentationRouteEvents()).toContain("deck:get:1:question");
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

test("@chromium reduced motion removes the outgoing presentation slide immediately", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await installAdminApiMock(page);
  await signIn(page);
  mock.setPresentationPosition("opening");
  await openPresenter(page);
  await expect(slideFor(page, "opening")).toBeVisible();

  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await mutation;

  await expect(slideFor(page, "question")).toBeVisible({ timeout: 100 });
  await expect(
    page.getByTestId("presentation-natural-layer").locator('[aria-hidden="true"][inert]'),
  ).toHaveCount(0);
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

test("@chromium rank effects respond immediately to a dynamic reduced-motion change", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  mock.setWinnerEntries([
    { displayName: "花子", score: 1, rank: 1 },
    { displayName: "太郎", score: 0, rank: 2 },
  ]);
  await signIn(page);
  await startPresentation(page);
  mock.setPresentationPosition("second");
  await openPresenter(page);
  await expect(slideFor(page, "second")).toBeVisible();
  await page.addStyleTag({
    content: `
      html body [class*="rankOrnament"],
      html body [data-testid="presentation-exam-stamp"],
      html body [class*="winnerContent"],
      html body [class*="winnerReveal"],
      html body [class*="winnerReveal"]::before,
      html body [class*="winnerReveal"]::after {
        animation-duration: 5000ms !important;
      }
    `,
  });
  const region = rankRegionFor(page, "second");
  await expect(region).toHaveCount(1);
  const reveal = region.locator("[class*='winnerReveal']");
  const content = reveal.locator("[class*='winnerContent']");
  const ornament = region.locator("[class*='rankOrnament']");
  const medal = region.locator("[data-testid='presentation-exam-stamp']");
  await expect(region.getByText("太郎", { exact: false })).toBeVisible();
  await expectRankAnticipation(region, "second-place entry", false);
  await expect(ornament).toHaveCSS("animation-duration", "5s");
  await expect(medal).toHaveCSS("animation-duration", "5s");
  await expect(content).toHaveCSS("animation-duration", "5s");
  const activeRankAnimations = await page.evaluate(() => {
    const regions = document.querySelectorAll<HTMLElement>(
      '[data-testid="presentation-canvas"] section[class*="winners"][data-rank="second"]',
    );
    const region = regions.length === 1 ? regions[0] : null;
    const describe = (element: Element | null, fragment: string) => {
      if (!element) return null;
      const animation = element
        .getAnimations()
        .find((candidate) => (candidate as CSSAnimation).animationName.includes(fragment));
      return animation
        ? {
            playState: animation.playState,
            currentTime: animation.currentTime === null ? null : Number(animation.currentTime),
          }
        : null;
    };
    return {
      ornament: describe(
        region?.querySelector("[class*='rankOrnament']") ?? null,
        "rankOrnamentEntrance",
      ),
      medal: describe(
        region?.querySelector("[data-testid='presentation-exam-stamp']") ?? null,
        "rankStampEntrance",
      ),
      winner: describe(
        region?.querySelector("[class*='winnerContent']") ?? null,
        "rankWinnerReveal",
      ),
    };
  });
  expect(activeRankAnimations.ornament?.playState).toBe("running");
  expect(activeRankAnimations.medal?.playState).toBe("running");
  expect(activeRankAnimations.winner?.playState).toBe("running");
  expect(activeRankAnimations.ornament?.currentTime).toBeLessThan(5000);
  expect(activeRankAnimations.medal?.currentTime).toBeLessThan(5000);
  expect(activeRankAnimations.winner?.currentTime).toBeLessThan(5000);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(content).toHaveCSS("animation-name", "none");
  await expect(reveal).toHaveCSS("opacity", "1");
  await expect(content).toHaveCSS("opacity", "1");
  await expect(content).toHaveCSS("transform", "none");
  await expect(ornament).toHaveCSS("animation-name", "none");
  await expect(ornament).toHaveCSS("opacity", "0.55");
  await expect(medal).toHaveCSS("animation-name", "none");
  await expect(medal).toHaveCSS("opacity", "1");
  expect(
    await region
      .locator("[class*='rankHeading']")
      .evaluate((heading) => getComputedStyle(heading, "::after").animationName),
  ).toBe("none");
  expect(
    await region
      .locator("[class*='rankHeading']")
      .evaluate((heading) => getComputedStyle(heading, "::after").opacity),
  ).toBe("0");
  await expect(region.getByText("太郎", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        [
          ...document.querySelectorAll(
            "[class*='rankHeader'], [class*='rankOrnament'], [class*='rankStamp'], " +
              "[class*='rankHeading'], [class*='winnerReveal'], [class*='winnerContent']",
          ),
        ]
          .flatMap((element) => element.getAnimations())
          .filter((animation) =>
            /rankHeaderEntrance|rankPlateEntrance|rankWinnerReveal|rankOrnamentEntrance|rankStampEntrance|rankRevealAnticipation|rankLineShimmer/.test(
              (animation as CSSAnimation).animationName,
            ),
          ).length,
    ),
  ).toBe(0);

  const firstRankEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "first")).toBeVisible();
  await firstRankEntry;
  const firstRegion = rankRegionFor(page, "first");
  await expect(firstRegion).toHaveCount(1);
  await expect(firstRegion.getByText("花子", { exact: false })).toBeVisible();
  await expect(firstRegion.locator("[class*='winnerContent']")).toHaveCSS("animation-name", "none");
  await expect(firstRegion.locator("[class*='rankHeader']")).toHaveCSS("animation-name", "none");
  expect(
    await firstRegion
      .locator("[class*='rankHeader'] h1[class*='rank']")
      .evaluate((rank) => getComputedStyle(rank, "::before").animationName),
  ).toBe("none");
  await expectRankAnticipation(
    firstRegion,
    "dynamic reduced-motion first-place entry",
    true,
    "reduced",
  );
  await expect
    .poll(() =>
      firstRegion
        .locator("[class*='rankHeading']")
        .evaluate((heading) => getComputedStyle(heading, "::after").animationName),
    )
    .toBe("none");
  expect(
    await firstRegion
      .locator("[class*='rankHeading']")
      .evaluate((heading) => getComputedStyle(heading, "::after").opacity),
  ).toBe("0");
  const firstReveal = firstRegion.locator("[class*='winnerReveal']");
  await expect(firstReveal).toHaveCSS("opacity", "1");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expectRankAnticipation(firstRegion, "dynamic normal-motion first-place entry", true);
  await expect
    .poll(() =>
      firstReveal.evaluate((element) => getComputedStyle(element, "::before").animationName),
    )
    .toContain("rankRevealAnticipation");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectRankAnticipation(
    firstRegion,
    "dynamic reduced-motion first-place entry",
    true,
    "reduced",
  );
  expect(
    await firstRegion
      .locator("[class*='winnerContent']")
      .evaluate((element) =>
        element
          .getAnimations()
          .some((animation) =>
            (animation as CSSAnimation).animationName.includes("rankRevealAnticipation"),
          ),
      ),
  ).toBe(false);
});

test("@chromium first-place anticipation eligibility stays fixed for the rank entry", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  mock.setWinnerEntries([
    { displayName: "花子", score: 1, rank: 1 },
    { displayName: "太郎", score: 1, rank: 1 },
  ]);
  await signIn(page);
  await startPresentation(page);
  mock.setPresentationPosition("first");
  await openPresenter(page);

  const region = rankRegionFor(page, "first");
  await expect(region).toHaveCount(1);
  const reveal = await expectRankAnticipation(region, "first-place tied winners", true);
  await expect(reveal.locator("article")).toHaveCount(2);
  await expect(reveal.getByText("花子", { exact: false })).toBeVisible();
  await expect(reveal.getByText("太郎", { exact: false })).toBeVisible();
  const initialAnimation = await reveal.evaluate((element) => {
    const before = getComputedStyle(element, "::before");
    const after = getComputedStyle(element, "::after");
    return {
      beforeDuration: before.animationDuration,
      afterDuration: after.animationDuration,
      beforeDelay: before.animationDelay,
      afterDelay: after.animationDelay,
    };
  });
  expect(initialAnimation).toEqual({
    beforeDuration: "0.76s",
    afterDuration: "0.76s",
    beforeDelay: "0s",
    afterDelay: "0s",
  });

  const refreshSnapshot = async () => {
    const priorDeckRefreshes = mock
      .getPresentationRouteEvents()
      .filter((event) => event.startsWith("deck:get:")).length;
    const responseOk = await page.evaluate(async () => {
      const response = await fetch("/api/admin/presentation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: crypto.randomUUID(), action: "aggregate" }),
      });
      return response.ok;
    });
    expect(responseOk).toBe(true);
    await expect
      .poll(
        () =>
          mock.getPresentationRouteEvents().filter((event) => event.startsWith("deck:get:")).length,
      )
      .toBeGreaterThan(priorDeckRefreshes);
  };

  mock.setWinnerEntries([]);
  await refreshSnapshot();
  await expect(region.getByText("該当する受賞者はいません")).toBeVisible();
  await expect(reveal).toHaveAttribute("data-reveal-eligible", "false");
  await expectRankAnticipation(region, "first-place winner disappearance", false);

  mock.setWinnerEntries([{ displayName: "花子", score: 1, rank: 1 }]);
  await refreshSnapshot();
  await expect(reveal.getByText("花子", { exact: false })).toBeVisible();
  await expectRankAnticipation(region, "winner restoration in the same first-place entry", false);
});

test("@chromium selected-answer and supplement groups reveal in order and replay only on entry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installAnswerRevealAnimationProbe(page, questions[0].id);
  const mock = await installAdminApiMock(page);
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
  const captureRecoverySnapshot = async (label: string) => {
    const browser = await page.evaluate((expectedQuestionId) => {
      const section = document.querySelector<HTMLElement>("[class*='answerReview']");
      const questionPrompt = document.querySelector<HTMLElement>(
        "[class*='question']:not([class*='answerReview'])",
      );
      const elementSnapshot = (element: HTMLElement | null) => {
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          identity: window.__answerRevealNodeIdentity(element),
          isConnected: element.isConnected,
          className: element.className,
          data: { ...element.dataset },
          inlineStyle: element.getAttribute("style"),
          computedStyle: {
            animationName: style.animationName,
            animationDelay: style.animationDelay,
            animationDuration: style.animationDuration,
            animationPlayState: style.animationPlayState,
            opacity: style.opacity,
          },
        };
      };
      const questionText =
        section?.querySelector("h1")?.textContent?.trim() ??
        questionPrompt?.querySelector("h1")?.textContent?.trim() ??
        "";
      return {
        stage: section ? "answer" : questionPrompt ? "question" : "other",
        questionId: section?.getAttribute("data-question-id") ?? String(expectedQuestionId),
        questionText,
        answerSection: elementSnapshot(section),
        answerReveal: elementSnapshot(
          section?.querySelector<HTMLElement>("[class*='answerReveal']") ?? null,
        ),
        supplement: elementSnapshot(
          section?.querySelector<HTMLElement>("[class*='answerSupplement']") ?? null,
        ),
        animationStarts: window.__answerRevealAnimations.map((entry) => ({ ...entry })),
        animationEnds: window.__answerRevealAnimationEnds.map((entry) => ({ ...entry })),
      };
    }, questions[0].id);
    return {
      label,
      browser,
      controlGetStatuses: mock
        .getPresentationRouteEvents()
        .filter((event) => event.startsWith("controls:get:")),
    };
  };

  const startsBeforeControlsRefresh = await page.evaluate(() =>
    window.__answerRevealAnimations.map((entry) => ({ ...entry })),
  );
  const controlsReadsBeforeRefresh = mock
    .getPresentationRouteEvents()
    .filter((event) => event === "controls:get").length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect
    .poll(
      () => mock.getPresentationRouteEvents().filter((event) => event === "controls:get").length,
    )
    .toBeGreaterThan(controlsReadsBeforeRefresh);
  const startsAfterControlsRefresh = await page.evaluate(() =>
    window.__answerRevealAnimations.map((entry) => ({ ...entry })),
  );
  const newStartsAfterControlsRefresh = startsAfterControlsRefresh.slice(
    startsBeforeControlsRefresh.length,
  );
  if (newStartsAfterControlsRefresh.length > 0) {
    throw new Error(
      `Same-question controls refresh restarted answer animations; no-replay expected. ` +
        `Before: ${JSON.stringify(startsBeforeControlsRefresh, null, 2)}\n` +
        `New events: ${JSON.stringify(newStartsAfterControlsRefresh, null, 2)}\n` +
        `After: ${JSON.stringify(startsAfterControlsRefresh, null, 2)}`,
    );
  }
  expect(startsAfterControlsRefresh).toHaveLength(startsBeforeControlsRefresh.length);

  const before503 = await captureRecoverySnapshot("before-503");
  const controlsBeforeFailure = before503.controlGetStatuses.filter(
    (event) => event === "controls:get:503",
  ).length;
  const successfulControlsBeforeFailure = before503.controlGetStatuses.filter(
    (event) => event === "controls:get:200",
  ).length;
  mock.failNextAdminRead();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("スライドの状態を確認できません。自動で再試行します")).toBeVisible();
  await expect
    .poll(
      () =>
        mock.getPresentationRouteEvents().filter((event) => event === "controls:get:503").length,
    )
    .toBeGreaterThan(controlsBeforeFailure);
  const after503 = await captureRecoverySnapshot("after-503-before-retry-success");
  await expect
    .poll(
      () =>
        mock.getPresentationRouteEvents().filter((event) => event === "controls:get:200").length,
    )
    .toBeGreaterThan(successfulControlsBeforeFailure);
  const afterRetry = await captureRecoverySnapshot("after-retry-success");
  const replayEventsAfterFailure = afterRetry.browser.animationStarts.slice(
    before503.browser.animationStarts.length,
  );
  if (replayEventsAfterFailure.length > 0) {
    throw new Error(
      `Same-question 503/retry recovery restarted answer animations; no-replay expected. ` +
        `Snapshots: ${JSON.stringify([before503, after503, afterRetry], null, 2)}`,
    );
  }
  expect(replayEventsAfterFailure).toHaveLength(0);
  await expect(answerList).toBeAttached();

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

  const secondLeave = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "question")).toBeVisible();
  await secondLeave;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedReentry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "answer")).toBeVisible();
  await reducedReentry;
  const reducedAnswer = page.locator("[class*='answerReview'] ol[class*='answerReveal']");
  await expect(reducedAnswer).toHaveCSS("animation-name", "none");
  await expect(reducedAnswer).toHaveCSS("animation-delay", "0s");
  await expect(reducedAnswer).toHaveCSS("opacity", "1");
  await expect(supplement).toHaveCSS("animation-name", "none");
  await expect(supplement).toHaveCSS("animation-delay", "0s");
  await expect(supplement).toHaveCSS("opacity", "1");
  await expect.poll(() => page.evaluate(() => window.__answerRevealAnimations.length)).toBe(4);
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
    { state: "finished", text: ["ご参加", "ありがとうございました"] },
  ];

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    await expect(slideFor(page, stage.state)).toBeVisible();
    if (stage.state === "question") await waitForCurrentPresentationEntryAnimations(page);
    const inspection = await inspectSlide();
    for (const text of stage.text) expect(inspection.text).toContain(text);
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

test("@chromium reference-size long presentation content stays readable after fitting", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installAnswerRevealAnimationProbe(page, 11);
  const longQuestion =
    "ふたりが初めて出会った場所で、どのような会話をして、その後どんな思い出につながったのでしょうか？";
  const longChoices = [
    "共通の友人が開いた集まりで、初めてゆっくり話をしたカフェ",
    "ふたりが学生時代に何度も待ち合わせをしていた大学の正門前",
    "帰り道に偶然会い、長い時間話し込んだ駅前の広場",
  ];
  const longExplanation =
    "共通の友人が開いた集まりで出会い、好きな音楽や旅行の話をしながら、気づけば長い時間を一緒に過ごしていました。";
  const mock = await installAdminApiMock(page, {
    question: {
      id: 11,
      question: longQuestion,
      choices: longChoices,
      correctAnswer: longChoices[1],
      explanation: longExplanation,
    },
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  const longQ5Answer =
    "忘れられない思い出の場所で過ごした時間を、今でもよく思い出します。みんなで話したことや景色も大切な記憶です。あの日の帰り道に見た夕焼けも、ずっと心に残っています。".repeat(
      12,
    );
  const questionResults: E2EWinnerQuestionResult[] = Array.from({ length: 5 }, (_, position) => ({
    position,
    question: null,
    answer:
      position === 4
        ? {
            kind: "freeText",
            value: longQ5Answer,
          }
        : { kind: "selected", value: null },
    ...(position < 4 ? { correctness: "correct" as const } : { normalizedScore: 0.75 }),
  }));
  const shortQuestionResults = questionResults.map((result) =>
    result.position === 4
      ? { ...result, answer: { kind: "freeText" as const, value: "短い回答です" } }
      : result,
  );
  mock.setWinnerEntries([
    { displayName: "とても思い出深い時間を過ごした受賞者", score: 4.75, rank: 3, questionResults },
    { displayName: "もう一人の受賞者", score: 4.75, rank: 3, questionResults },
    {
      displayName: "長い回答を最後まで確認できる受賞者",
      score: 4.5,
      rank: 2,
      questionResults: shortQuestionResults,
    },
    {
      displayName: "長文設問と得点を表示する受賞者",
      score: 4.25,
      rank: 1,
      questionResults: shortQuestionResults,
    },
  ]);
  await signIn(page);
  await page.getByRole("button", { name: "集計" }).click();
  await expect(page.getByText(/集計済み/)).toBeVisible();
  await page.getByRole("button", { name: "発表を開始" }).click();
  await expect(page.getByText("現在の状態：進行中：オープニング")).toBeVisible();
  await openPresenter(page);
  const effectiveMainTextMeasurements = async (stage: PresentationState) => {
    await waitForRenderFrames(page);
    return page.getByTestId("presentation-fit-viewport").evaluate((viewport, stage) => {
      const fitLayer = document.querySelector<HTMLElement>(
        "[data-testid='presentation-fit-layer']",
      );
      const scale = Number(fitLayer?.style.getPropertyValue("--presentation-fit-scale"));
      const selectors: Partial<Record<PresentationState, string>> = {
        opening: "[class*='openingTitle'] h1 > span",
        question:
          "[class*='question']:not([class*='answerReview']) h1, [class*='question']:not([class*='answerReview']) [class*='choiceText']",
        answer:
          "[class*='answerReview'] h1, [class*='answerReview'] [class*='choiceText'], [class*='answerReview'] [class*='explanation'] p",
        podium_preview: "[class*='podiumPreview'] h1, [class*='podiumPreview'] [class*='subtitle']",
        third:
          "[class*='winners'] [class*='rankHeader'] h1[class*='rank'], [class*='winners'] [class*='winnerName__'], [class*='winners'] [class*='__winnerName']:not([class*='__winnerNames']), [class*='winners'] [class*='winnerScore'], [class*='winners'] [class*='winnerQuestionAnswer']",
        second:
          "[class*='winners'] [class*='rankHeader'] h1[class*='rank'], [class*='winners'] [class*='winnerName__'], [class*='winners'] [class*='__winnerName']:not([class*='__winnerNames']), [class*='winners'] [class*='winnerScore'], [class*='winners'] [class*='winnerQuestionAnswer']",
        first:
          "[class*='winners'] [class*='rankHeader'] h1[class*='rank'], [class*='winners'] [class*='winnerName__'], [class*='winners'] [class*='__winnerName']:not([class*='__winnerNames']), [class*='winners'] [class*='winnerScore'], [class*='winners'] [class*='winnerQuestionAnswer']",
        finished: "[class*='finished'] h1, [class*='finished'] [class*='subtitle']",
      };
      const selector = selectors[stage] ?? "";
      const selectorParts = selector.split(",").map((part) => part.trim());
      return Array.from(viewport.querySelectorAll<HTMLElement>(selector))
        .filter((element) => getComputedStyle(element).visibility === "visible")
        .map((element) => {
          const fontSizePx = Number.parseFloat(getComputedStyle(element).fontSize);
          const rect = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const textRect = range.getBoundingClientRect();
          return {
            selector: selectorParts.filter((part) => element.matches(part)).join(", "),
            className: element.className,
            text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
            fontSizePx,
            fitScale: scale,
            naturalWidth: rect.width / scale,
            naturalHeight: rect.height / scale,
            textWidth: textRect.width,
            textHeight: textRect.height,
            effectivePt: fontSizePx * scale * 0.75,
          };
        })
        .filter((measurement) => Number.isFinite(measurement.effectivePt));
    }, stage);
  };
  const expectMainContentAt20pt = async (stage: PresentationState) => {
    const measurements = await effectiveMainTextMeasurements(stage);
    expect(measurements.length, `${stage} must expose measurable main content`).toBeGreaterThan(0);
    const insufficient = measurements.filter((measurement) => measurement.effectivePt < 20);
    const unmeasurable = measurements.filter(
      (measurement) =>
        measurement.naturalWidth <= 0 ||
        measurement.naturalHeight <= 0 ||
        (measurement.text.trim().length > 0 &&
          (measurement.textWidth <= 0 || measurement.textHeight <= 0)),
    );
    expect(
      insufficient.length === 0 && unmeasurable.length === 0,
      `${stage} visible main content must remain at least 20pt and have measurable natural geometry; insufficient: ${JSON.stringify(insufficient, null, 2)}, unmeasurable: ${JSON.stringify(unmeasurable, null, 2)}`,
    ).toBe(true);
  };
  const expectTwoWinnerLongContentFitException = async () => {
    const measurements = await effectiveMainTextMeasurements("third");
    expect(measurements.length, "third must expose measurable main content").toBeGreaterThan(0);
    expect(
      measurements.some((measurement) => measurement.effectivePt < 20),
      `the two-winner long-content fit must reduce effective text below 20pt: ${JSON.stringify(measurements, null, 2)}`,
    ).toBe(true);
    expect(measurements.every((measurement) => measurement.fitScale < 1)).toBe(true);
  };
  await expect(slideFor(page, "opening")).toBeVisible();
  await expect(page.getByRole("heading", { name: longQuestion })).toBeHidden();
  const opening = page
    .getByRole("heading", { name: /^しゅんたま\s*検定$/ })
    .locator("xpath=ancestor::section");
  const openingColumns = await opening.evaluate((section) => {
    const lockup = section.querySelector("[class*='openingLockup']")!;
    return {
      lockupContainsTitle: lockup.contains(section.querySelector("[class*='openingTitle']")),
      stampCount: section.querySelectorAll("[data-testid='presentation-exam-stamp']").length,
    };
  });
  expect(openingColumns.lockupContainsTitle).toBe(true);
  expect(openingColumns.stampCount, "opening includes the shared presentation exam stamp").toBe(1);
  await expect(page.locator("#opening-title span:last-child")).toBeVisible();
  await expect(page.getByText("PRESENTATION", { exact: true })).toHaveCount(0);
  await expect(page.getByText("これまでの思い出を振り返りましょう", { exact: true })).toHaveCount(
    0,
  );
  await expectMainContentAt20pt("opening");

  const next = async (state: PresentationState) => {
    const pauseStyle = state === "third" ? await pauseRankRevealBeforeEntry(page) : undefined;
    const refresh = nextAdminMutation(page);
    await page.locator("main").press("ArrowRight");
    const rankRegion =
      state === "third" ? page.getByRole("region", { name: "第三位の勝者一覧" }) : null;
    if (state === "question") {
      await expect(page.getByRole("heading", { name: longQuestion })).toBeVisible();
    } else {
      await expect(slideFor(page, state)).toBeVisible();
    }
    if (rankRegion) {
      await expectRankRevealGeometry(rankRegion, "during-delay", pauseStyle);
    }
    await refresh;
    if (state === "third") {
      await expectTwoWinnerLongContentFitException();
      await expectRankRevealGeometry(rankRegion!);
    } else if (state === "answer") {
      await expectAnswerRevealFitDuringAndAfter(page, 0);
      await expectMainContentAt20pt(state);
    } else {
      await expectMainContentAt20pt(state);
    }
  };
  await next("question");
  await expect(page.getByRole("heading", { name: longQuestion })).toBeVisible();
  await expect(page.locator("[class*='ordinal']")).toHaveText("問 1");
  await expect(page.getByText(/QUESTION|LET’S LOOK BACK/)).toHaveCount(0);
  for (const choice of longChoices)
    await expect(page.getByText(choice, { exact: true })).toBeVisible();
  await next("answer");
  await expect(page.getByText(longExplanation, { exact: true })).toBeVisible();
  await expect(page.locator("[class*='ordinal']")).toHaveText("問 1");
  await expect(page.getByText("THE STORY BEHIND IT", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/QUESTION/)).toHaveCount(0);
  const answerRowContrast = await page
    .getByTestId("presentation-fit-viewport")
    .evaluate((viewport) => {
      const row = viewport.querySelector<HTMLElement>("[class*='answered'] [class*='correct']");
      const label = row?.querySelector<HTMLElement>("[class*='correctLabel']");
      const luminance = (color: string) => {
        const rgb =
          color
            .match(/[\d.]+/g)
            ?.slice(0, 3)
            .map(Number) ?? [];
        const linear = rgb.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
      };
      const contrast = (foreground: string, background: string) => {
        const first = luminance(foreground);
        const second = luminance(background);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      if (!row || !label) return null;
      const rowStyle = getComputedStyle(row);
      const labelStyle = getComputedStyle(label);
      return {
        rowContrast: contrast(rowStyle.color, rowStyle.backgroundColor),
        labelContrast: contrast(labelStyle.color, rowStyle.backgroundColor),
        labelFontSize: Number.parseFloat(labelStyle.fontSize),
      };
    });
  expect(answerRowContrast).not.toBeNull();
  expect(answerRowContrast!.rowContrast).toBeGreaterThanOrEqual(4.5);
  expect(answerRowContrast!.labelContrast).toBeGreaterThanOrEqual(4.5);
  expect(answerRowContrast!.labelFontSize).toBeGreaterThanOrEqual(16);

  const returnToQuestion = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(page.getByRole("heading", { name: longQuestion })).toBeVisible();
  await returnToQuestion;
  await page.setViewportSize({ width: 480, height: 900 });
  await waitForRenderFrames(page);
  await page.evaluate(() => {
    window.__pauseAnswerRevealAtStart = true;
  });
  const narrowAnswerEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "answer")).toBeVisible();
  await narrowAnswerEntry;
  const narrowRevealGeometry = await expectAnswerRevealFitDuringAndAfter(page, 2);
  expect(narrowRevealGeometry.during.scale).toBeLessThan(1);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await waitForRenderFrames(page);
  await next("podium_preview");
  await next("third");

  const region = page.getByRole("region", { name: "第三位の勝者一覧" });
  await expectRankRevealGeometry(region);
  await expect(region.locator("article")).toHaveCount(2);
  await expectTwoWinnerLongContentFitException();
  const cardGeometry = await region.evaluate((region) => {
    const articles = Array.from(region.querySelectorAll<HTMLElement>("article"));
    const cards = articles.map((article) => {
      const identity = article.querySelector("[class*='winnerIdentity']")!.getBoundingClientRect();
      const resultList = article.querySelector<HTMLElement>("[aria-label='設問別の回答']")!;
      const results = resultList.getBoundingClientRect();
      const rows = Array.from(article.querySelectorAll("[aria-label='設問別の回答'] li"), (item) =>
        item.getBoundingClientRect(),
      );
      const name = article.querySelector<HTMLElement>(
        "[class*='winnerName']:not([class*='winnerNames'])",
      )!;
      const q5Answer = article.querySelector<HTMLElement>(
        "[class*='fifthWinnerQuestion'] [class*='winnerQuestionAnswer']",
      )!;
      const q5AnswerNode = Array.from(q5Answer.childNodes).find(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
      const answerRange = document.createRange();
      if (q5AnswerNode) answerRange.selectNode(q5AnswerNode);
      const answerRects = Array.from(answerRange.getClientRects());
      const viewport = document
        .querySelector<HTMLElement>("[data-testid='presentation-fit-viewport']")!
        .getBoundingClientRect();
      const frame = article.closest("[aria-label='第三位の勝者一覧']")!.getBoundingClientRect();
      const card = article.getBoundingClientRect();
      return {
        q5AnswerText: q5AnswerNode?.textContent?.trim() ?? "",
        identityBottom: identity.bottom,
        resultsTop: results.top,
        firstFourTop: rows.slice(0, 4).map((rect) => rect.top),
        q5Top: rows[4]?.top,
        nameFits: name.scrollWidth <= name.clientWidth + 1,
        cardInsideViewport:
          card.left >= viewport.left &&
          card.right <= viewport.right &&
          card.top >= viewport.top &&
          card.bottom <= viewport.bottom,
        cardInsideFrame:
          card.left >= frame.left &&
          card.right <= frame.right &&
          card.top >= frame.top &&
          card.bottom <= frame.bottom,
        q5FitsResults: answerRects.every(
          (rect) => rect.left >= results.left && rect.right <= results.right,
        ),
        allRowsFitResults: rows.every(
          (rect) => rect.left >= results.left && rect.right <= results.right,
        ),
        allFiveAnswersPresent: rows.length === 5,
        noCardContentOverflow:
          article.scrollHeight <= article.clientHeight + 1 &&
          resultList.scrollHeight <= resultList.clientHeight + 1,
      };
    });
    const cardRects = articles.map((article) => article.getBoundingClientRect());
    return {
      cards,
      cardsDoNotOverlap:
        cardRects.length === 2 &&
        (cardRects[0]!.right <= cardRects[1]!.left ||
          cardRects[1]!.right <= cardRects[0]!.left ||
          cardRects[0]!.bottom <= cardRects[1]!.top ||
          cardRects[1]!.bottom <= cardRects[0]!.top),
    };
  });
  expect(cardGeometry.cardsDoNotOverlap).toBe(true);
  for (const card of cardGeometry.cards) {
    expect(card.q5AnswerText).toBe(longQ5Answer);
    expect(card.identityBottom).toBeLessThanOrEqual(card.resultsTop + 1);
    expect(new Set(card.firstFourTop).size).toBe(1);
    expect(card.q5Top).toBeGreaterThan(card.firstFourTop[0]!);
    expect(card.nameFits).toBe(true);
    expect(card.cardInsideViewport).toBe(true);
    expect(card.cardInsideFrame).toBe(true);
    expect(card.q5FitsResults).toBe(true);
    expect(card.allRowsFitResults).toBe(true);
    expect(card.allFiveAnswersPresent).toBe(true);
    expect(card.noCardContentOverflow).toBe(true);
  }
  await expect(region.locator("article")).toHaveCount(2);
  await next("second");
  const secondPlaceRegion = page.getByRole("region", { name: "第二位の勝者一覧" });
  await expectRankRevealGeometry(secondPlaceRegion);
  const secondPlaceHeading = secondPlaceRegion.locator("[class*='rankHeader'] h1[class*='rank']");
  await expect(secondPlaceHeading).toBeVisible();
  await expect(secondPlaceHeading).toHaveText("第二位");
  await next("first");
  const firstPlaceRegion = page.getByRole("region", { name: "第一位の勝者一覧" });
  await expectRankRevealGeometry(firstPlaceRegion);
  const firstPlaceHeading = firstPlaceRegion.locator("[class*='rankHeader'] h1[class*='rank']");
  await expect(firstPlaceHeading).toBeVisible();
  await expect(firstPlaceHeading).toHaveText("第一位");
  await next("finished");
});

test("@mobile tied first-place winners share eligible anticipation and fit at 480x900", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  const firstWinner = "長い表示名の同率一位受賞者・花子";
  const secondWinner = "長い表示名の同率一位受賞者・太郎";
  mock.setWinnerEntries([
    { displayName: firstWinner, score: 0.93, rank: 1 },
    { displayName: secondWinner, score: 0.87, rank: 1 },
  ]);
  await signIn(page);
  await startPresentation(page);
  mock.setPresentationPosition("second");
  await openPresenter(page);

  const firstEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  const region = page.getByRole("region", { name: "第一位の勝者一覧" });
  await expect(region).toBeVisible();
  await firstEntry;

  const winners = region.locator("article");
  await expect(winners).toHaveCount(2);
  const firstName = winners.nth(0).locator("[class*='winnerName']");
  await expect(firstName).toBeVisible();
  await expect(firstName).toHaveText(`${firstWinner} 殿`);
  await expect(winners.nth(0).locator("[class*='winnerScore']")).toHaveText("0.93 ポイント");
  const secondName = winners.nth(1).locator("[class*='winnerName']");
  await expect(secondName).toBeVisible();
  await expect(secondName).toHaveText(`${secondWinner} 殿`);
  await expect(winners.nth(1).locator("[class*='winnerScore']")).toHaveText("0.87 ポイント");

  const reveal = await expectRankAnticipation(region, "tied first-place winners", true);
  await expect(reveal.locator("article")).toHaveCount(2);
  const pseudoContent = await reveal.evaluate((element) =>
    ["::before", "::after"].map((pseudo) => getComputedStyle(element, pseudo).content),
  );
  expect(pseudoContent).toEqual(['""', '""']);
  await expectRankRevealGeometry(region);

  const geometry = await page.getByTestId("presentation-fit-viewport").evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect();
    const winnersRegion = viewport.querySelector<HTMLElement>(
      "section[class*='winners'][data-rank='first']",
    );
    const regionBounds = winnersRegion?.getBoundingClientRect();
    return {
      regionInsideViewport: Boolean(
        regionBounds &&
        regionBounds.left >= bounds.left - 1 &&
        regionBounds.right <= bounds.right + 1 &&
        regionBounds.top >= bounds.top - 1 &&
        regionBounds.bottom <= bounds.bottom + 1,
      ),
      pageCanScroll:
        document.documentElement.scrollWidth > document.documentElement.clientWidth ||
        document.documentElement.scrollHeight > document.documentElement.clientHeight,
      regionCanScroll: Boolean(
        winnersRegion &&
        (winnersRegion.scrollWidth > winnersRegion.clientWidth ||
          winnersRegion.scrollHeight > winnersRegion.clientHeight),
      ),
    };
  });
  expect(geometry.regionInsideViewport).toBe(true);
  expect(geometry.pageCanScroll).toBe(false);
  expect(geometry.regionCanScroll).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("tied-first-place-480x900.png"),
    animations: "disabled",
  });
});

test("@mobile 24 first-place winners fit with eligible anticipation at 480x900", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  const winnerEntries = Array.from({ length: 24 }, (_, index) => ({
    displayName: `一位受賞者${index + 1}`,
    score: 1 - index * 0.01,
    rank: 1,
  }));
  mock.setWinnerEntries(winnerEntries);
  await signIn(page);
  await startPresentation(page);
  mock.setPresentationPosition("second");
  await openPresenter(page);

  const firstEntry = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  const region = page.getByRole("region", { name: "第一位の勝者一覧" });
  await expect(region).toBeVisible();
  await firstEntry;

  const winners = region.locator("article");
  await expect(winners).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expect(winners.nth(index).locator("[class*='winnerName']")).toHaveText(
      `一位受賞者${index + 1} 殿`,
    );
  }
  await expect(region.locator("[class*='additionalWinners']")).toHaveText("ほか 22 名");

  const reveal = await expectRankAnticipation(region, "24 first-place winners", true);
  await expect(reveal.locator("article")).toHaveCount(2);
  await expect(reveal.locator("[class*='additionalWinners']")).toHaveText("ほか 22 名");
  await expectRankRevealGeometry(region);

  const geometry = await page.getByTestId("presentation-canvas").evaluate((canvas) => {
    const canvasBounds = canvas.getBoundingClientRect();
    const fitViewport = canvas.querySelector<HTMLElement>(
      "[data-testid='presentation-fit-viewport']",
    );
    const viewportBounds = fitViewport?.getBoundingClientRect();
    const winnersRegion = fitViewport?.querySelector<HTMLElement>(
      "section[class*='winners'][data-rank='first']",
    );
    const regionBounds = winnersRegion?.getBoundingClientRect();
    const visibleContent = Array.from(fitViewport?.querySelectorAll<HTMLElement>("*") ?? [])
      .filter((element) => getComputedStyle(element).visibility === "visible")
      .map((element) => element.getBoundingClientRect())
      .filter((bounds) => bounds.width > 0 && bounds.height > 0);
    const inside = (bounds: DOMRect, container: DOMRect) =>
      bounds.left >= container.left - 1 &&
      bounds.right <= container.right + 1 &&
      bounds.top >= container.top - 1 &&
      bounds.bottom <= container.bottom + 1;
    return {
      fitViewportInsideCanvas: Boolean(viewportBounds && inside(viewportBounds, canvasBounds)),
      winnersInsideViewport: Boolean(
        viewportBounds && regionBounds && inside(regionBounds, viewportBounds),
      ),
      allVisibleContentInsideViewport: Boolean(
        viewportBounds && visibleContent.every((bounds) => inside(bounds, viewportBounds)),
      ),
      canvasCanScroll:
        canvas.scrollWidth > canvas.clientWidth || canvas.scrollHeight > canvas.clientHeight,
      pageCanScroll:
        document.documentElement.scrollWidth > innerWidth ||
        document.documentElement.scrollHeight > innerHeight,
      regionCanScroll: Boolean(
        winnersRegion &&
        (winnersRegion.scrollWidth > winnersRegion.clientWidth ||
          winnersRegion.scrollHeight > winnersRegion.clientHeight),
      ),
    };
  });
  expect(geometry.fitViewportInsideCanvas).toBe(true);
  expect(geometry.winnersInsideViewport).toBe(true);
  expect(geometry.allVisibleContentInsideViewport).toBe(true);
  expect(geometry.canvasCanScroll).toBe(false);
  expect(geometry.pageCanScroll).toBe(false);
  expect(geometry.regionCanScroll).toBe(false);
});

test("@mobile a single long winner name wraps fully inside the slide", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await installAdminApiMock(page);
  const longName = "とても長い氏名を折り返して最後まで表示する受賞者の名前".repeat(3);
  mock.setWinnerEntries([
    { displayName: longName, score: 0.75, rank: 3 },
    { displayName: longName, score: 0.8, rank: 2 },
    { displayName: longName, score: 0.9, rank: 1 },
  ]);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");
  const spectator = await page.context().newPage();
  await spectator.setViewportSize({ width: 1920, height: 1080 });
  await spectator.goto("/presentation");
  await Promise.all([
    page.evaluate(() => document.fonts.ready),
    spectator.evaluate(() => document.fonts.ready),
  ]);

  const region = page.getByRole("region", { name: "第三位の勝者一覧" });
  const name = region.locator("article h1");
  await expect(region.locator("article")).toHaveCount(1);
  await expect(region.locator("[class*='rankHeader'] h1[class*='rank']")).toHaveCount(1);
  await expect(name).toContainText(longName);
  await expect(name).toContainText("殿");
  await expect(region.locator("[class*='winnerScore']")).toHaveText("0.75 ポイント");

  const ranks = [
    { state: "third" as const, label: "第三位", score: "0.75 ポイント" },
    { state: "second" as const, label: "第二位", score: "0.80 ポイント" },
    { state: "first" as const, label: "第一位", score: "0.90 ポイント" },
  ];
  for (const [viewportIndex, viewport] of [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 480, height: 900 },
  ].entries()) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready);
    await waitForRenderFrames(page);
    if (viewportIndex > 0) {
      for (const state of ["second", "third"] as const) {
        const pauseStyle = await pauseRankRevealBeforeEntry(page);
        const previousRefresh = nextAdminMutation(page);
        await page.locator("main").press("ArrowLeft");
        await expect(slideFor(page, state)).toBeVisible();
        const label = state === "second" ? "第二位" : "第三位";
        const region = page.getByRole("region", { name: `${label}の勝者一覧` });
        await expectRankRevealGeometry(region, "during-delay", pauseStyle);
        await previousRefresh;
        await expectRankRevealGeometry(region);
      }
    }

    for (const [rankIndex, rankStage] of ranks.entries()) {
      const region = page.getByRole("region", { name: `${rankStage.label}の勝者一覧` });
      await expectRankRevealGeometry(region);
      const name = region.locator("article h1");
      await expect(region.locator("article")).toHaveCount(1);
      await expect(region.locator("[class*='rankHeader'] h1[class*='rank']")).toHaveCount(1);
      await expect(region.locator("[class*='rankHeader']")).toHaveText(`認定証${rankStage.label}`);
      await expect(region.locator("[class*='rankHeader'] h1[class*='rank']")).toHaveText(
        rankStage.label,
      );
      await expect(name).toContainText(longName);
      await expect(name).toContainText("殿");
      await expect(region.locator("[class*='winnerScore']")).toHaveText(rankStage.score);

      const geometry = await page
        .getByTestId("presentation-fit-viewport")
        .evaluate((fitViewport, rankLabel) => {
          const bounds = fitViewport.getBoundingClientRect();
          const canvas = document.querySelector('[data-testid="presentation-canvas"]');
          const region = fitViewport.querySelector(`section[aria-label="${rankLabel}の勝者一覧"]`);
          const rank = region?.querySelector("[class*='rankHeader'] h1[class*='rank']");
          const certificate = region?.querySelector("[class*='certificateLabel']");
          const stamp = region?.querySelector("[data-testid='presentation-exam-stamp']");
          const identity = region?.querySelector<HTMLElement>("[class*='winnerIdentity']");
          const heading = identity?.querySelector("h1");
          const score = identity?.querySelector<HTMLElement>("[class*='winnerScore']");
          const winnerName = heading?.querySelector(
            "[class*='winnerName']:not([class*='winnerNames'])",
          );
          const rankRect = rank?.getBoundingClientRect();
          const certificateRect = certificate?.getBoundingClientRect();
          const stampRect = stamp?.getBoundingClientRect();
          const identityRect = identity?.getBoundingClientRect();
          const headingRect = heading?.getBoundingClientRect();
          const scoreRect = score?.getBoundingClientRect();
          const elements = [rank, heading, score];
          const rects = elements.map((element) => {
            const rect = element?.getBoundingClientRect();
            return rect
              ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
              : null;
          });
          const nameRange = document.createRange();
          if (winnerName) nameRange.selectNodeContents(winnerName);
          const textRects = Array.from(nameRange.getClientRects()).map((rect) => ({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          }));
          const lineTops = new Set(textRects.map((rect) => Math.round(rect.top)));
          const fontSizes = elements.map((element) =>
            element ? Number.parseFloat(getComputedStyle(element).fontSize) : 0,
          );
          const fitLayer = document.querySelector<HTMLElement>(
            "[data-testid='presentation-fit-layer']",
          );
          const fitScale = Number(
            fitLayer?.style.getPropertyValue("--presentation-fit-scale") ?? "1",
          );
          const effectiveFontSizesPt = fontSizes.map((fontSize) => fontSize * fitScale * 0.75);
          const identityGap = identity ? getComputedStyle(identity) : null;
          const columnGap = Number.parseFloat(identityGap?.columnGap ?? "0") || 0;
          const rowGap = Number.parseFloat(identityGap?.rowGap ?? "0") || 0;
          const overlaps = (left: DOMRect | undefined, right: DOMRect | undefined) =>
            Boolean(
              left &&
              right &&
              left.left < right.right &&
              left.right > right.left &&
              left.top < right.bottom &&
              left.bottom > right.top,
            );
          const certificateRankStampDoNotOverlap = Boolean(
            certificateRect &&
            rankRect &&
            stampRect &&
            !overlaps(certificateRect, rankRect) &&
            !overlaps(certificateRect, stampRect) &&
            !overlaps(rankRect, stampRect),
          );
          const nameAndScoreDoNotOverlap = Boolean(
            scoreRect &&
            textRects.every(
              (line) =>
                line.right <= scoreRect.left ||
                scoreRect.right <= line.left ||
                line.bottom <= scoreRect.top ||
                scoreRect.bottom <= line.top,
            ),
          );
          const nameAndScoreAdjacent = Boolean(
            headingRect &&
            scoreRect &&
            (headingRect.top < scoreRect.bottom && scoreRect.top < headingRect.bottom
              ? scoreRect.left >= headingRect.right &&
                scoreRect.left - headingRect.right <= columnGap + 2
              : headingRect.left < scoreRect.right &&
                scoreRect.left < headingRect.right &&
                scoreRect.top >= headingRect.bottom - 1 &&
                scoreRect.top - headingRect.bottom <= rowGap + 2),
          );
          const contrastRatio = (
            element: Element | null | undefined,
            background: Element | null,
          ) => {
            const channels = (color: string) => color.match(/[\d.]+/g)?.map(Number) ?? [];
            const luminance = (color: string) => {
              const rgb = channels(color)
                .slice(0, 3)
                .map((channel) => {
                  const value = channel / 255;
                  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                });
              return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
            };
            if (!element || !background) return 0;
            const foreground = luminance(getComputedStyle(element).color);
            const backdrop = luminance(getComputedStyle(background).backgroundColor);
            return (
              (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05)
            );
          };
          return {
            rankText: rank?.textContent?.trim() ?? "",
            certificateText: certificate?.textContent?.trim() ?? "",
            certificateAboveRank: Boolean(
              certificateRect && rankRect && certificateRect.bottom <= rankRect.top + 1,
            ),
            certificateRankStampDoNotOverlap,
            text: heading?.textContent?.replace(/\s+/g, " ").trim() ?? "",
            rankAboveIdentity: Boolean(
              rankRect && identityRect && rankRect.bottom <= identityRect.top + 1,
            ),
            headingAndScoreShareIdentity: Boolean(
              identity && heading?.parentElement === identity && score?.parentElement === identity,
            ),
            namePrecedesScore: Boolean(
              heading &&
              score &&
              heading.compareDocumentPosition(score) === Node.DOCUMENT_POSITION_FOLLOWING,
            ),
            nameAndScoreDoNotOverlap,
            nameAndScoreAdjacent,
            lineCount: lineTops.size,
            bounds: {
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
              bottom: bounds.bottom,
            },
            rects,
            textRects,
            fontSizes,
            fitScale,
            effectiveFontSizesPt,
            outerHorizontalWidths: {
              document: document.documentElement.scrollWidth,
              body: document.body.scrollWidth,
              viewport: document.documentElement.clientWidth,
            },
            contrasts: elements.map((element) => contrastRatio(element, canvas)),
            nameFits: Boolean(
              winnerName instanceof HTMLElement &&
              winnerName.scrollWidth <= winnerName.clientWidth + 1,
            ),
            pageCanScroll:
              document.documentElement.scrollWidth > innerWidth ||
              document.documentElement.scrollHeight > innerHeight,
            regionCanScroll:
              region instanceof HTMLElement && region.scrollHeight > region.clientHeight,
          };
        }, rankStage.label);

      expect(geometry.rankText).toBe(rankStage.label);
      expect(geometry.certificateText).toBe("認定証");
      expect(geometry.certificateAboveRank).toBe(true);
      expect(geometry.certificateRankStampDoNotOverlap).toBe(true);
      expect(geometry.text).toContain(longName);
      expect(geometry.text).toContain("殿");
      expect(geometry.rankAboveIdentity).toBe(true);
      expect(geometry.headingAndScoreShareIdentity).toBe(true);
      expect(geometry.namePrecedesScore).toBe(true);
      expect(geometry.nameAndScoreDoNotOverlap).toBe(true);
      expect(geometry.nameAndScoreAdjacent).toBe(true);
      expect(geometry.lineCount).toBeGreaterThan(1);
      expect(geometry.fontSizes[1]).toBeGreaterThan(geometry.fontSizes[0]!);
      expect(geometry.fontSizes[1]).toBeGreaterThan(geometry.fontSizes[2]!);
      if (viewport.width === 1920) {
        expect(
          geometry.effectiveFontSizesPt[1],
          `Single long winner name must remain at least 20pt at ${viewport.width}x${viewport.height} (${rankStage.label}); measurements: ${JSON.stringify(
            {
              fontSizesPx: geometry.fontSizes,
              fitScale: geometry.fitScale,
              effectiveFontSizesPt: geometry.effectiveFontSizesPt,
            },
            null,
            2,
          )}`,
        ).toBeGreaterThanOrEqual(20);
      }
      expect(geometry.contrasts.every((ratio) => ratio >= 4.5)).toBe(true);
      expect(geometry.nameFits).toBe(true);
      if (viewport.width === 480 && rankStage.state === "first") {
        await page.screenshot({
          path: testInfo.outputPath("long-first-place-name-480x900.png"),
          animations: "disabled",
        });
      }
      expect(
        Math.max(geometry.outerHorizontalWidths.document, geometry.outerHorizontalWidths.body),
      ).toBeLessThanOrEqual(geometry.outerHorizontalWidths.viewport + 1);
      expect(geometry.pageCanScroll).toBe(false);
      expect(geometry.regionCanScroll).toBe(false);
      expect(geometry.rects.every((rect) => rect !== null)).toBe(true);
      for (const rect of geometry.rects) {
        expect(rect!.left).toBeGreaterThanOrEqual(geometry.bounds.left - 1);
        expect(rect!.right).toBeLessThanOrEqual(geometry.bounds.right + 1);
        expect(rect!.top).toBeGreaterThanOrEqual(geometry.bounds.top - 1);
        expect(rect!.bottom).toBeLessThanOrEqual(geometry.bounds.bottom + 1);
      }
      expect(
        geometry.textRects.every(
          (rect) =>
            rect.left >= geometry.bounds.left - 1 &&
            rect.right <= geometry.bounds.right + 1 &&
            rect.top >= geometry.bounds.top - 1 &&
            rect.bottom <= geometry.bounds.bottom + 1,
        ),
      ).toBe(true);
      const stampGeometry = await region
        .locator("[data-testid='presentation-exam-stamp']")
        .evaluate((stamp) => {
          const stampRect = stamp.getBoundingClientRect();
          const regionRect = stamp.parentElement!.getBoundingClientRect();
          const headingRect = stamp
            .parentElement!.querySelector("[class*='rankHeader']")!
            .getBoundingClientRect();
          const cardRects = Array.from(stamp.parentElement!.querySelectorAll("article"), (card) =>
            card.getBoundingClientRect(),
          );
          const overlaps = (left: DOMRect, right: DOMRect) =>
            left.left < right.right &&
            left.right > right.left &&
            left.top < right.bottom &&
            left.bottom > right.top;
          return {
            insideRegion:
              stampRect.left >= regionRect.left &&
              stampRect.right <= regionRect.right &&
              stampRect.top >= regionRect.top &&
              stampRect.bottom <= regionRect.bottom,
            inUpperRight: stampRect.left > regionRect.left + regionRect.width / 2,
            overlapsHeading: overlaps(stampRect, headingRect),
            overlapsCards: cardRects.some((cardRect) => overlaps(stampRect, cardRect)),
            pointerEvents: getComputedStyle(stamp).pointerEvents,
          };
        });
      expect(stampGeometry.insideRegion).toBe(true);
      expect(stampGeometry.inUpperRight).toBe(true);
      expect(stampGeometry.overlapsHeading).toBe(false);
      expect(stampGeometry.overlapsCards).toBe(false);
      expect(stampGeometry.pointerEvents).toBe("none");
      const nextRank = ranks[rankIndex + 1];
      if (nextRank) {
        const nextRefresh = nextAdminMutation(page);
        await page.locator("main").press("ArrowRight");
        await expect(slideFor(page, nextRank.state)).toBeVisible();
        await nextRefresh;
      }
    }
  }

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 1080 },
    { width: 480, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await waitForRenderFrames(page);
    const firstRegion = page.getByRole("region", { name: "第一位の勝者一覧" });
    await expect(firstRegion).toBeVisible();
    await expect(firstRegion.locator("[class*='rankHeader'] h1[class*='rank']")).toHaveText(
      "第一位",
    );
    const fit = await page.getByTestId("presentation-fit-viewport").evaluate((fitViewport) => {
      const viewportRect = fitViewport.getBoundingClientRect();
      const region = fitViewport.querySelector<HTMLElement>("[aria-label='第一位の勝者一覧']");
      const identity = region?.querySelector<HTMLElement>("[class*='winnerIdentity']");
      const name = identity?.querySelector<HTMLElement>(
        "[class*='winnerName']:not([class*='winnerNames'])",
      );
      const score = identity?.querySelector<HTMLElement>("[class*='winnerScore']");
      const regionRect = region?.getBoundingClientRect();
      const identityRect = identity?.getBoundingClientRect();
      const scoreRect = score?.getBoundingClientRect();
      const nameRange = document.createRange();
      if (name) nameRange.selectNodeContents(name);
      const nameRects = Array.from(nameRange.getClientRects()).map((rect) => ({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      }));
      const rank = region?.querySelector<HTMLElement>("[class*='rankHeader'] h1[class*='rank']");
      const rankRect = rank?.getBoundingClientRect();
      const stamp = region?.querySelector<HTMLElement>("[data-testid='presentation-exam-stamp']");
      const stampRect = stamp?.getBoundingClientRect();
      const articleRects = Array.from(region?.querySelectorAll("article") ?? [], (article) =>
        article.getBoundingClientRect(),
      );
      const overlaps = (left: DOMRect, right: DOMRect) =>
        left.left < right.right &&
        left.right > right.left &&
        left.top < right.bottom &&
        left.bottom > right.top;
      const fitLayer = document.querySelector<HTMLElement>(
        "[data-testid='presentation-fit-layer']",
      );
      const scale = Number(fitLayer?.style.getPropertyValue("--presentation-fit-scale"));
      const nameFontSizePx = name ? Number.parseFloat(getComputedStyle(name).fontSize) : 0;
      const visibleContentRects = Array.from(fitViewport.querySelectorAll<HTMLElement>("*"))
        .filter((element) => getComputedStyle(element).visibility === "visible")
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      return {
        scale,
        nameFontSizePx,
        effectiveNamePt: nameFontSizePx * scale * 0.75,
        regionInsideViewport: Boolean(
          regionRect &&
          regionRect.left >= viewportRect.left - 1 &&
          regionRect.right <= viewportRect.right + 1 &&
          regionRect.top >= viewportRect.top - 1 &&
          regionRect.bottom <= viewportRect.bottom + 1,
        ),
        rankAboveIdentity: Boolean(
          rankRect && identityRect && rankRect.bottom <= identityRect.top + 1,
        ),
        stampInsideRegion: Boolean(
          stampRect &&
          regionRect &&
          stampRect.left >= regionRect.left &&
          stampRect.right <= regionRect.right &&
          stampRect.top >= regionRect.top &&
          stampRect.bottom <= regionRect.bottom,
        ),
        stampClearOfRankAndWinners: Boolean(
          stampRect &&
          rankRect &&
          !overlaps(stampRect, rankRect) &&
          articleRects.every((articleRect) => !overlaps(stampRect, articleRect)),
        ),
        nameFits: Boolean(name && name.scrollWidth <= name.clientWidth + 1),
        nameAndScoreDoNotOverlap: Boolean(
          nameRects.length > 0 &&
          scoreRect &&
          nameRects.every(
            (rect) =>
              rect.right <= scoreRect.left ||
              scoreRect.right <= rect.left ||
              rect.bottom <= scoreRect.top ||
              scoreRect.bottom <= rect.top,
          ),
        ),
        allVisibleContentInsideViewport: visibleContentRects.every(
          (rect) =>
            rect.left >= viewportRect.left - 1 &&
            rect.right <= viewportRect.right + 1 &&
            rect.top >= viewportRect.top - 1 &&
            rect.bottom <= viewportRect.bottom + 1,
        ),
        pageCanScroll:
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
        regionCanScroll: Boolean(region && region.scrollHeight > region.clientHeight),
      };
    });
    expect(fit.scale).toBeGreaterThan(0);
    expect(fit.scale).toBeLessThanOrEqual(1);
    if (viewport.width >= 1440) {
      expect(
        fit.effectiveNamePt,
        `Single long first-place name must remain at least 20pt at ${viewport.width}x${viewport.height}; measurements: ${JSON.stringify(
          {
            nameFontSizePx: fit.nameFontSizePx,
            fitScale: fit.scale,
            effectiveNamePt: fit.effectiveNamePt,
          },
          null,
          2,
        )}`,
      ).toBeGreaterThanOrEqual(20);
    }
    expect(fit.regionInsideViewport).toBe(true);
    expect(fit.rankAboveIdentity).toBe(true);
    expect(fit.stampInsideRegion).toBe(true);
    expect(fit.stampClearOfRankAndWinners).toBe(true);
    expect(fit.nameFits).toBe(true);
    expect(fit.nameAndScoreDoNotOverlap).toBe(true);
    expect(fit.allVisibleContentInsideViewport).toBe(true);
    expect(fit.pageCanScroll).toBe(false);
    expect(fit.regionCanScroll).toBe(false);

    await spectator.setViewportSize(viewport);
    for (const previousState of ["second", "third"] as const) {
      const previousRefresh = nextAdminMutation(page);
      await page.locator("main").press("ArrowLeft");
      await expect(slideFor(page, previousState)).toBeVisible();
      await previousRefresh;
    }
    for (const [rankIndex, rankStage] of ranks.entries()) {
      await expect(slideFor(spectator, rankStage.state)).toBeVisible();
      const spectatorRegion = spectator.getByRole("region", {
        name: `${rankStage.label}の勝者一覧`,
      });
      await expect(spectatorRegion).toBeVisible();
      await expect(spectatorRegion.locator("[class*='rankHeader'] h1[class*='rank']")).toHaveText(
        rankStage.label,
      );
      const nextRank = ranks[rankIndex + 1];
      if (nextRank) {
        const nextRefresh = nextAdminMutation(page);
        await page.locator("main").press("ArrowRight");
        await expect(slideFor(page, nextRank.state)).toBeVisible();
        await nextRefresh;
        await expect(
          spectator.getByRole("region", { name: `${nextRank.label}の勝者一覧` }),
        ).toBeVisible();
      }
    }
  }
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
  mock.failNextResultsMutation();
  await page.getByRole("button", { name: "参加者結果を公開" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("再試行してください");
  expect(mock.getPresentationState()).toEqual(finishedState);
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
  const mock = await installAdminApiMock(page, { fullscreenSupported: true });
  await signIn(page);
  await page.getByRole("button", { name: "集計" }).click();
  await expect(page.getByText(/集計済み/)).toBeVisible();
  await page.getByRole("button", { name: "発表を開始" }).click();
  await expect(page.getByText("現在の状態：進行中：オープニング")).toBeVisible();
  await openPresenter(page);

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 1080 },
    { width: 480, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready);
    await waitForRenderFrames(page);
    await expect(slideFor(page, "opening")).toBeVisible();
    await expect(page).toHaveURL(/\/presentation\?presenter=1$/);
    expect(mock.getPresentationState().state).toBe("opening");
    expect(page.viewportSize()).toEqual(viewport);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    const fit = await page.getByTestId("presentation-fit-viewport").evaluate((fitViewport) => {
      const bounds = fitViewport.getBoundingClientRect();
      const fitLayer = document.querySelector<HTMLElement>(
        "[data-testid='presentation-fit-layer']",
      );
      const scale = Number(fitLayer?.style.getPropertyValue("--presentation-fit-scale"));
      const contentRects = Array.from(fitViewport.querySelectorAll<HTMLElement>("*"))
        .filter((element) => getComputedStyle(element).visibility === "visible")
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      return {
        scale,
        allContentInsideFitViewport: contentRects.every(
          (rect) =>
            rect.left >= bounds.left - 1 &&
            rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 &&
            rect.bottom <= bounds.bottom + 1,
        ),
        pageCanScroll:
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      };
    });
    expect(fit.scale).toBeGreaterThan(0);
    expect(fit.scale).toBeLessThanOrEqual(1);
    expect(fit.allContentInsideFitViewport).toBe(true);
    expect(fit.pageCanScroll).toBe(false);
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  await waitForRenderFrames(page);
  await expect(slideFor(page, "opening")).toBeVisible();
  await waitForRenderFrames(page);

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

test("@mobile fullscreen CTA reserves a mobile top rail without reducing slide fit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAdminApiMock(page, { fullscreenSupported: true });
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);

  const inspectLayout = async () => {
    const main = page.locator("main");
    await main.evaluate((element) => {
      element.style.setProperty("--presentation-safe-area-top", "32px");
      element.style.setProperty("--presentation-safe-area-right", "24px");
    });
    await waitForRenderFrames(page);
    const button = main.getByRole("button", { name: "全画面表示" });
    await expect(button).toBeVisible();
    const buttonBox = await button.boundingBox();
    const mainBox = await main.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    const slideBoxes = await page.getByTestId("presentation-canvas").evaluate((canvas) => {
      const toBox = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const slideRegion = canvas.parentElement;
      const fitViewport = canvas.querySelector("[data-testid='presentation-fit-viewport']");
      const contentBoxes = fitViewport
        ? Array.from(fitViewport.querySelectorAll("*"))
            .map(toBox)
            .filter((box) => box.width > 0 && box.height > 0)
        : [];
      return {
        slideRegion: slideRegion ? toBox(slideRegion) : null,
        canvas: toBox(canvas),
        fitViewport: fitViewport ? toBox(fitViewport) : null,
        contentBoxes,
        fitReady:
          canvas
            .querySelector("[data-testid='presentation-natural-layer']")
            ?.getAttribute("data-fit-ready") === "true",
      };
    });
    const viewportBox = await page.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(buttonBox!.width).toBeGreaterThanOrEqual(48);
    expect(buttonBox!.height).toBeGreaterThanOrEqual(48);
    expect(buttonBox!.y).toBeGreaterThanOrEqual(mainBox!.y + 32 + 8);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width - 32);
    expect(slideBoxes.slideRegion).not.toBeNull();
    expect(slideBoxes.fitViewport).not.toBeNull();
    expect(slideBoxes.fitReady).toBe(true);
    const contains = (
      outer: NonNullable<typeof slideBoxes.canvas>,
      inner: NonNullable<typeof slideBoxes.canvas>,
    ) =>
      inner.x >= outer.x - 1 &&
      inner.y >= outer.y - 1 &&
      inner.x + inner.width <= outer.x + outer.width + 1 &&
      inner.y + inner.height <= outer.y + outer.height + 1;
    expect(contains(slideBoxes.canvas, slideBoxes.fitViewport!)).toBe(true);
    expect(slideBoxes.fitViewport!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height);
    expect(contains(slideBoxes.slideRegion!, slideBoxes.fitViewport!)).toBe(true);
    expect(contains(mainBox!, slideBoxes.fitViewport!)).toBe(true);
    expect(contains(viewportBox, slideBoxes.fitViewport!)).toBe(true);
    const overlaps = (a: NonNullable<typeof buttonBox>, b: NonNullable<typeof slideBoxes.canvas>) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    expect(overlaps(buttonBox!, slideBoxes.fitViewport!)).toBe(false);
    expect(slideBoxes.contentBoxes.some((box) => overlaps(buttonBox!, box))).toBe(false);
    const fitViewport = page.getByTestId("presentation-fit-viewport");
    const outOfBounds = await fitViewport.evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect();
      return Array.from(viewport.querySelectorAll("*"))
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .filter(
          (rect) =>
            rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1 ||
            rect.top < bounds.top - 1 ||
            rect.bottom > bounds.bottom + 1,
        ).length;
    });
    expect(outOfBounds).toBe(0);
  };

  await inspectLayout();
  await page.setViewportSize({ width: 844, height: 390 });
  await inspectLayout();
});
