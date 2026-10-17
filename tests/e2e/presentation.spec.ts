import { test, expect } from "./fixtures/test";
import { e2eAdminPin } from "./fixtures/admin-auth";
import { expectNoAccessibilityViolations } from "./axe";

declare global {
  interface Window {
    __fullscreenRequests: number;
    __wakeRequests: number[];
    __releaseWakeLock: () => void;
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

const questions = [
  {
    id: 11,
    question: "ふたりが初めて出会った場所は？",
    choices: ["カフェ", "大学", "駅"],
    correctAnswer: "大学",
    explanation: "共通の友人が開いた集まりで出会いました。",
  },
];

type PresentationQuestionFixture = (typeof questions)[number];

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
        await route.fulfill({ json: deck() });
      }),
    )
    .then(() =>
      context.route(
        (url) => url.pathname === "/api/admin/presentation",
        async (route) => {
          if (route.request().method() === "GET") {
            if (failAdminRead) {
              await route.fulfill({ status: 503, json: { error: "Unavailable" } });
              return;
            }
            if (!authenticated) {
              await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
              return;
            }
            if (new URL(route.request().url()).searchParams.get("view") === "controls") {
              presentationRouteEvents.push("controls:get");
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
      return page.getByText("正解", { exact: true }).first();
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

  const expectRenderedJapaneseFont = async (targetPage: import("@playwright/test").Page) => {
    const observed: {
      selector: string;
      text: string;
      fonts: Awaited<ReturnType<typeof renderedPlatformFonts>>;
      hasJapaneseSerifFace: boolean;
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
        hasJapaneseSerifFace: fonts.some(
          (font) =>
            font.glyphCount > 0 && /serif|mincho|明朝|ming|song|batang/i.test(font.familyName),
        ),
      });
    }
    for (const result of observed) {
      expect(
        result.hasJapaneseSerifFace,
        `${result.text} must render from a Japanese Mincho/serif face; observed platform fonts: ${JSON.stringify(result.fonts)}`,
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
  await expectRenderedJapaneseFont(page);

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
  mock.setWinnerEntries(
    Array.from({ length: 24 }, (_, index) => ({
      displayName: `受賞者${index + 1}`,
      score: 1,
      rank: 3,
    })),
  );
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");
  const winners = page.getByRole("region", { name: "第三位の勝者一覧" });
  await expect(winners).toBeVisible();
  await expect(winners).not.toHaveClass(/announce/);
  const rankTitle = winners.locator("[class*='rankHeader'] > h1[class*='rank']");
  await expect(rankTitle).toHaveCount(1);
  await expect(rankTitle).toHaveText("第三位");
  const stamp = winners.locator("[data-testid='presentation-exam-stamp']");
  await expect(stamp).toHaveCount(1);
  await expect(stamp).toHaveAttribute("aria-hidden", "true");
  await expect(stamp).toHaveText("しゅんたま検定");
  const canvas = page.getByTestId("presentation-canvas");
  const frame = canvas.locator("img[class*='presentationFrame']");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("src", "/certificate_ornate_frame_16x9_gold.svg");
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
        const stamp = region.querySelector<HTMLElement>("[data-testid='presentation-exam-stamp']");
        return Boolean(header && stamp && rankTitle && rankTitle.parentElement === header);
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
});

test("@chromium every stage keeps its fixture text inside the canvas content bounds", async ({
  page,
}) => {
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
    const inspection = await inspectSlide();
    for (const text of stage.text) expect(inspection.text).toContain(text);
    if (stage.state === "question" || stage.state === "answer") {
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
          "[class*='winners'] [class*='rankHeader'] > h1[class*='rank'], [class*='winners'] [class*='winnerName__'], [class*='winners'] [class*='__winnerName']:not([class*='__winnerNames']), [class*='winners'] [class*='winnerScore'], [class*='winners'] [class*='winnerQuestionAnswer']",
        second:
          "[class*='winners'] [class*='rankHeader'] > h1[class*='rank'], [class*='winners'] [class*='winnerName__'], [class*='winners'] [class*='__winnerName']:not([class*='__winnerNames']), [class*='winners'] [class*='winnerScore'], [class*='winners'] [class*='winnerQuestionAnswer']",
        first:
          "[class*='winners'] [class*='rankHeader'] > h1[class*='rank'], [class*='winners'] [class*='winnerName__'], [class*='winners'] [class*='__winnerName']:not([class*='__winnerNames']), [class*='winners'] [class*='winnerScore'], [class*='winners'] [class*='winnerQuestionAnswer']",
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
  expect(openingColumns.stampCount).toBe(0);
  await expect(page.locator("#opening-title span:last-child")).toBeVisible();
  await expect(page.getByText("PRESENTATION", { exact: true })).toHaveCount(0);
  await expect(page.getByText("これまでの思い出を振り返りましょう", { exact: true })).toHaveCount(
    0,
  );
  await expectMainContentAt20pt("opening");

  const next = async (state: PresentationState) => {
    const refresh = nextAdminMutation(page);
    await page.locator("main").press("ArrowRight");
    if (state === "question") {
      await expect(page.getByRole("heading", { name: longQuestion })).toBeVisible();
    } else {
      await expect(slideFor(page, state)).toBeVisible();
    }
    await refresh;
    if (state === "third") await expectTwoWinnerLongContentFitException();
    else await expectMainContentAt20pt(state);
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
  await next("podium_preview");
  await next("third");

  const region = page.getByRole("region", { name: "第三位の勝者一覧" });
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
  const secondPlaceHeading = secondPlaceRegion.locator("[class*='rankHeader'] > h1[class*='rank']");
  await expect(secondPlaceHeading).toBeVisible();
  await expect(secondPlaceHeading).toHaveText("第二位");
  await next("first");
  const firstPlaceRegion = page.getByRole("region", { name: "第一位の勝者一覧" });
  const firstPlaceHeading = firstPlaceRegion.locator("[class*='rankHeader'] > h1[class*='rank']");
  await expect(firstPlaceHeading).toBeVisible();
  await expect(firstPlaceHeading).toHaveText("第一位");
  await next("finished");
});

test("@mobile a single long winner name wraps fully inside the slide", async ({ page }) => {
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
  await expect(region.locator("[class*='rankHeader'] > h1[class*='rank']")).toHaveCount(1);
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
        const previousRefresh = nextAdminMutation(page);
        await page.locator("main").press("ArrowLeft");
        await expect(slideFor(page, state)).toBeVisible();
        await previousRefresh;
      }
    }

    for (const [rankIndex, rankStage] of ranks.entries()) {
      const region = page.getByRole("region", { name: `${rankStage.label}の勝者一覧` });
      const name = region.locator("article h1");
      await expect(region.locator("article")).toHaveCount(1);
      await expect(region.locator("[class*='rankHeader'] > h1[class*='rank']")).toHaveCount(1);
      await expect(region.locator("[class*='rankHeader']")).toHaveText(`認定証${rankStage.label}`);
      await expect(region.locator("[class*='rankHeader'] > h1[class*='rank']")).toHaveText(
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
          const rank = region?.querySelector("[class*='rankHeader'] > h1[class*='rank']");
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
    await expect(firstRegion.locator("[class*='rankHeader'] > h1[class*='rank']")).toHaveText(
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
      const rank = region?.querySelector<HTMLElement>("[class*='rankHeader'] > h1[class*='rank']");
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
      await expect(spectatorRegion.locator("[class*='rankHeader'] > h1[class*='rank']")).toHaveText(
        rankStage.label,
      );
      const nextRank = ranks[rankIndex + 1];
      if (nextRank) {
        const nextRefresh = nextAdminMutation(page);
        await page.locator("main").press("ArrowRight");
        await expect(slideFor(page, nextRank.state)).toBeVisible();
        await nextRefresh;
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
    let fullscreenTarget: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenTarget,
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: function requestFullscreen() {
        window.__fullscreenRequests += 1;
        fullscreenTarget = this;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && fullscreenTarget) {
        fullscreenTarget = null;
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
