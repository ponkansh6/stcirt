import { test, expect } from "@playwright/test";
import { e2eAdminPin } from "./fixtures/admin-auth";

declare global {
  interface Window {
    __eventOrder: string[];
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
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "finished";

const questions = [
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
  options: { fullscreenSupported?: boolean } = {},
) {
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
  let winnerEntries = [
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
  const participantResultsMutations: boolean[] = [];
  const participantResultsStageSnapshots: PresentationState[] = [];
  const presentationRouteEvents: string[] = [];
  const stages: PresentationState[] = [
    "not_started",
    "question",
    "answer",
    "podium_preview",
    "third",
    "second",
    "first",
    "finished",
  ];

  const payload = () => ({
    state,
    version,
    questionIndex,
    questionCount: questions.length,
    questions,
    entries: winnerEntries,
    projectionHidden,
    participantResultsVisible,
    participantResultsReady: snapshotExists,
  });
  const controlsPayload = () => ({
    state,
    version,
    questionIndex,
    questionCount: questions.length,
    projectionHidden,
  });
  const deck = () => ({
    slides: (
      ["question", "answer", "podium_preview", "third", "second", "first", "finished"] as const
    ).map((slideState) => {
      let projection: Record<string, unknown>;
      if (slideState === "question" || slideState === "answer") {
        projection = {
          state: slideState,
          question: {
            id: 11,
            ordinal: 1,
            total: 1,
            question: questions[0].question,
            choices: questions[0].choices,
            ...(slideState === "answer"
              ? {
                  correctAnswer: questions[0].correctAnswer,
                  correctIndex: 1,
                  explanation: questions[0].explanation,
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
            .map(({ displayName, score, rank: winnerRank }) => ({
              displayName,
              score,
              rank: winnerRank,
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
          };
          if (failNextMutationUnauthorized) {
            failNextMutationUnauthorized = false;
            authenticated = false;
            await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
            return;
          }
          if (failNextMutationConflict) {
            failNextMutationConflict = false;
            if (body.action === "advance" && state === "question") {
              stageCursor = Math.min(stageCursor + 1, stages.length - 1);
              state = stages[stageCursor];
            }
            version += 1;
            presentationRouteEvents.push("mutation:advance:409");
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
          actions.push(body.action ?? "");
          if (pauseNextMutation) {
            pauseNextMutation = false;
            pausedMutationStarted?.();
            await new Promise<void>((resolve) => {
              releasePausedMutation = resolve;
            });
            releasePausedMutation = null;
          }
          if (body.action === "start" && state === "not_started") {
            snapshotExists = true;
            snapshotRevision += 1;
            stageCursor = 1;
            state = stages[stageCursor];
          } else if (body.action === "advance") {
            if (stageCursor + 1 < stages.length) {
              stageCursor += 1;
              state = stages[stageCursor];
            }
          } else if (body.action === "previous") {
            if (stageCursor > 1) {
              stageCursor -= 1;
              state = stages[stageCursor];
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
                  ? `${questions[0].question}（snapshot ${snapshotRevision}）`
                  : questions[0].question,
              choices: questions[0].choices,
              ...(state === "answer"
                ? { correctAnswer: questions[0].correctAnswer, correctIndex: 1 }
                : {}),
            },
          };
        } else if (state === "third" || state === "second" || state === "first") {
          const rank = state === "third" ? 3 : state === "second" ? 2 : 1;
          projection = {
            state,
            winners: payload()
              .entries.filter((entry) => entry.rank === rank)
              .map(({ displayName, score, rank: winnerRank }) => ({
                displayName,
                score,
                rank: winnerRank,
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
        if (body.visible && !participantResultsVisible) {
          snapshotExists = true;
          snapshotRevision += 1;
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
  await page.getByRole("button", { name: "発表を開始" }).click();
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
    case "question":
      return page.getByRole("heading", { name: questions[0].question });
    case "answer":
      return page.getByText("正解", { exact: true }).first();
    case "podium_preview":
      return page.getByRole("heading", { name: "いよいよ、結果発表です" });
    case "third":
      return page.getByRole("region", { name: "第3位の勝者一覧" });
    case "second":
      return page.getByRole("region", { name: "第2位の勝者一覧" });
    case "first":
      return page.getByRole("region", { name: "第1位の勝者一覧" });
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

test("public and presenter routes are read-only unless an authenticated presenter progresses", async ({
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
  expect(mock.actionLog).toEqual(["start"]);
});

test("admin opens or reuses a named presenter tab after start without fullscreen", async ({
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

test("existing projection hide and show operations stay on the admin page", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  const stateBeforeHide = mock.getPresentationState();
  await page.getByRole("button", { name: "投影を一時非表示" }).click();
  await expect(page.getByRole("button", { name: "投影を表示" })).toBeVisible();
  expect(mock.getPresentationState().state).toBe(stateBeforeHide.state);
  await openPresenter(page);
  await expect(page.getByText("ただいま休憩中です")).toBeVisible();
  await page.goto("/admin/presentation");
  await expect(page.getByRole("button", { name: "投影を表示" })).toBeVisible();
  await page.getByRole("button", { name: "投影を表示" }).click();
  await expect(page.getByRole("button", { name: "投影を一時非表示" })).toBeVisible();
  expect(mock.getPresentationState().state).toBe(stateBeforeHide.state);
});

test("keyboard and horizontal swipe progress once and honor stage boundaries", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("現在の状態：未開始")).toBeVisible();
  await startPresentation(page);
  await openPresenter(page);
  const main = page.locator("main");
  await main.press("ArrowLeft");
  expect(mock.getPresentationState().state).toBe("question");
  const answerRefresh = nextAdminMutation(page);
  await main.press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await answerRefresh;
  const podiumRefresh = nextAdminMutation(page);
  await main.press("Space");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
  await podiumRefresh;

  const box = await main.boundingBox();
  if (!box) throw new Error("Projection wrapper is missing");
  const thirdRefresh = nextAdminMutation(page);
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(slideFor(page, "third")).toBeVisible();
  await thirdRefresh;
  await waitForRenderFrames(page);
  expect(mock.actionLog.filter((action) => action === "advance")).toHaveLength(3);
  const secondRefresh = nextAdminMutation(page);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => mock.actionLog.filter((action) => action === "previous").length).toBe(1);
  await expect.poll(() => mock.getPresentationState().state).toBe("podium_preview");
  await expect(slideFor(page, "podium_preview")).toBeVisible();
  await secondRefresh;
  await waitForRenderFrames(page);
  expect(mock.actionLog.filter((action) => action === "previous")).toHaveLength(1);
});

test("successful presenter mutations return controls and do not trigger a controls refresh", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  const controlsReadsBefore = mock
    .getPresentationRouteEvents()
    .filter((event) => event === "controls:get").length;
  const mutation = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  const response = await mutation;
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await expect(response.json()).resolves.toEqual({
    state: "answer",
    version: 2,
    questionIndex: 0,
    questionCount: 1,
    projectionHidden: false,
  });
  const unexpectedControlsRead = await page
    .waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/admin/presentation" &&
        new URL(candidate.url()).searchParams.get("view") === "controls" &&
        candidate.request().method() === "GET",
      { timeout: 200 },
    )
    .then(
      () => true,
      () => false,
    );
  expect(unexpectedControlsRead).toBe(false);
  expect(
    mock.getPresentationRouteEvents().filter((event) => event === "controls:get"),
  ).toHaveLength(controlsReadsBefore);
});

test("Enter advances while repeat, modifiers, and interactive targets are ignored", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  const main = page.locator("main");
  await page.evaluate(() => {
    const root = document.querySelector("main");
    if (!root) throw new Error("Projection wrapper is missing");
    const button = document.createElement("button");
    root.append(button);
    const dispatch = (target: Element, init: KeyboardEventInit) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
    dispatch(root, { key: "ArrowRight", repeat: true });
    dispatch(root, { key: "ArrowRight", shiftKey: true });
    dispatch(root, { key: "ArrowRight", altKey: true });
    dispatch(root, { key: "ArrowRight", ctrlKey: true });
    dispatch(root, { key: "ArrowRight", metaKey: true });
    dispatch(button, { key: "ArrowRight" });
  });
  expect(mock.actionLog).toEqual(["start"]);
  await main.press("Enter");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  expect(mock.actionLog).toEqual(["start", "advance"]);
});

test("finished presenter can return to the last existing rank", async ({ page }) => {
  await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "finished");
  const previousRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "first")).toBeVisible();
  await previousRefresh;
});

test("all rank entries fit on the slide without vertical scrolling", async ({ page }) => {
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
  const winners = page.getByRole("region", { name: "第3位の勝者一覧" });
  await expect(winners).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("presentation-fit-layer")
        .evaluate((node) => Number(node.style.getPropertyValue("--presentation-fit-scale"))),
    )
    .toBeLessThan(1);
  const bounds = await page.getByTestId("presentation-canvas").evaluate((canvas) => {
    const canvasRect = canvas.getBoundingClientRect();
    const winnerRects = Array.from(canvas.querySelectorAll("article"), (node) =>
      node.getBoundingClientRect(),
    ).map((rect) => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    }));
    return {
      canvas: {
        left: canvasRect.left,
        right: canvasRect.right,
        top: canvasRect.top,
        bottom: canvasRect.bottom,
      },
      winners: winnerRects,
      pageCanScroll: document.documentElement.scrollHeight > innerHeight,
      regionCanScroll: winnersCanScroll(canvas),
    };
    function winnersCanScroll(root: Element) {
      const region = root.querySelector("[aria-label='第3位の勝者一覧']");
      return region instanceof HTMLElement && region.scrollHeight > region.clientHeight;
    }
  });
  expect(bounds.pageCanScroll).toBe(false);
  expect(bounds.regionCanScroll).toBe(false);
  expect(bounds.winners).toHaveLength(24);
  expect(
    bounds.winners.every(
      (rect) =>
        rect.left >= bounds.canvas.left - 1 &&
        rect.right <= bounds.canvas.right + 1 &&
        rect.top >= bounds.canvas.top - 1 &&
        rect.bottom <= bounds.canvas.bottom + 1,
    ),
  ).toBe(true);
  expect(mock.getPresentationState().state).toBe("third");
});

test("rank content is static on every entry and the slide fits the viewport", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");
  const winners = page.getByRole("region", { name: "第3位の勝者一覧" });
  await expect(winners).toBeVisible();
  await expect(winners).not.toHaveClass(/announce/);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 480, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const geometry = await page.getByTestId("presentation-canvas").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        hasTopline: Boolean(node.querySelector('[class*="topline"]')),
        hasBottomline: Boolean(node.querySelector('[class*="bottomline"]')),
        background: getComputedStyle(node).backgroundColor,
        aspectRatio: rect.width / rect.height,
      };
    });
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.height).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.aspectRatio).toBeCloseTo(16 / 9, 2);
    expect(geometry.hasTopline).toBe(false);
    expect(geometry.hasBottomline).toBe(false);
    expect(geometry.background).toBe("rgb(255, 255, 255)");
  }
  const previousRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "podium_preview")).toBeVisible();
  await previousRefresh;
  const replayRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "third")).toBeVisible();
  await replayRefresh;
  await expect(page.getByRole("region", { name: "第3位の勝者一覧" })).not.toHaveClass(/announce/);
  const secondRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "second")).toBeVisible();
  await secondRefresh;
  await expect(page.getByRole("region", { name: "第2位の勝者一覧" })).not.toHaveClass(/announce/);
});

test("every stage keeps its fixture text inside the canvas content bounds", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: /ふたりの思い出を/ })).toBeVisible();
  const notStartedInspection = await inspectSlide();
  expect(notStartedInspection.text).toContain("振り返る時間");
  expect(notStartedInspection.outOfBounds).toBe(0);
  expect(notStartedInspection.pageCanScroll).toBe(false);

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
    { state: "third", text: ["該当する受賞者はいません", "第3位"] },
    { state: "second", text: ["太郎", "0.00 ポイント", "第2位"] },
    { state: "first", text: ["花子", "1.00 ポイント", "第1位"] },
    { state: "finished", text: ["ご参加", "ありがとうございました"] },
  ];

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    await expect(slideFor(page, stage.state)).toBeVisible();
    const inspection = await inspectSlide();
    for (const text of stage.text) expect(inspection.text).toContain(text);
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

test("tied rank cards keep rank, points, and long participant names paired in the viewport", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  const longName = "長い名前でも順位とポイントの組み合わせが崩れない受賞者さん";
  mock.setWinnerEntries([
    { displayName: longName, score: 0.75, rank: 3 },
    { displayName: "もう一人", score: 0.75, rank: 3 },
  ]);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");
  const cards = page.getByRole("region", { name: "第3位の勝者一覧" }).locator("article");
  await expect(cards).toHaveCount(2);
  await expect
    .poll(() =>
      cards.evaluateAll((items) =>
        items.map((card) => {
          const [rank, score, name] = Array.from(card.children);
          return [
            rank?.textContent?.trim(),
            score?.textContent?.trim(),
            name?.textContent?.replace(/\s+/g, " ").trim(),
          ];
        }),
      ),
    )
    .toEqual([
      ["3位", "0.75 ポイント", `${longName} さん`],
      ["3位", "0.75 ポイント", "もう一人 さん"],
    ]);
  const geometry = await page.evaluate(() => {
    const bounds = Array.from(
      document.querySelectorAll("[aria-label='第3位の勝者一覧'] article"),
      (node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      },
    );
    return {
      bounds,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      innerWidth: innerWidth,
      innerHeight: innerHeight,
    };
  });
  expect(
    geometry.bounds.every(
      (rect) =>
        rect.left >= -1 &&
        rect.right <= geometry.innerWidth + 1 &&
        rect.top >= -1 &&
        rect.bottom <= geometry.innerHeight + 1,
    ),
  ).toBe(true);
  expect(geometry.width).toBeLessThanOrEqual(geometry.innerWidth);
  expect(geometry.height).toBeLessThanOrEqual(geometry.innerHeight);
});

test("long answer content remains complete and fits without an internal scroll region", async ({
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

test("a long tied-winner list fits every rank card without internal scrolling", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  const winners = Array.from({ length: 14 }, (_, index) => ({
    displayName: `同順位の受賞者${String(index + 1).padStart(2, "0")}`,
    score: 0.75,
    rank: 3,
  }));
  mock.setWinnerEntries(winners);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");

  const winnerRegion = page.getByRole("region", { name: "第3位の勝者一覧" });
  const cards = winnerRegion.locator("article");
  await expect(cards).toHaveCount(winners.length);
  await expect(cards.last()).toContainText("同順位の受賞者14");
  await expect(cards.last()).toContainText("0.75 ポイント");
  await expect
    .poll(() =>
      page
        .getByTestId("presentation-fit-layer")
        .evaluate((node) => Number(node.style.getPropertyValue("--presentation-fit-scale"))),
    )
    .toBeLessThan(1);
  const geometry = await page.getByTestId("presentation-canvas").evaluate((canvas) => {
    const canvasRect = canvas.getBoundingClientRect();
    const region = canvas.querySelector("[aria-label='第3位の勝者一覧']");
    const cardRects = Array.from(canvas.querySelectorAll("article"), (node) =>
      node.getBoundingClientRect(),
    ).map((rect) => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    }));
    return {
      canvasRect: {
        left: canvasRect.left,
        right: canvasRect.right,
        top: canvasRect.top,
        bottom: canvasRect.bottom,
      },
      cardRects,
      regionCanScroll: region instanceof HTMLElement && region.scrollHeight > region.clientHeight,
      text: region?.textContent ?? "",
    };
  });
  for (const winner of winners) expect(geometry.text).toContain(winner.displayName);
  expect(geometry.regionCanScroll).toBe(false);
  expect(
    geometry.cardRects.every(
      (rect) =>
        rect.left >= geometry.canvasRect.left - 1 &&
        rect.right <= geometry.canvasRect.right + 1 &&
        rect.top >= geometry.canvasRect.top - 1 &&
        rect.bottom <= geometry.canvasRect.bottom + 1,
    ),
  ).toBe(true);
  await expect(cards.last()).toBeVisible();
});

test("fifth free-text answer projection keeps the model answer and hides response rows", async ({
  page,
}) => {
  await page.route("**/api/presentation", async (route) =>
    route.fulfill({
      json: {
        state: "answer",
        question: {
          id: 5,
          ordinal: 5,
          total: 5,
          question: "第五問の問題文",
          choices: [],
          answerType: "freeText",
          expectedAnswer: "家族で旅行したこと",
        },
      },
    }),
  );
  await page.goto("/presentation");
  await expect(page.getByText("家族で旅行したこと")).toBeVisible();
  await expect(page.getByText("第五問の問題文")).toBeVisible();
  await expect(page.getByText(/回答者|類似度|得点/)).toHaveCount(0);
});

test("unauthorized progression clears presenter controls and 409 refreshes the projection", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  mock.conflictNextMutation();
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  expect(mock.getPresentationState().state).toBe("answer");

  await page.goto("/admin/presentation");
  mock.failNextMutationAsUnauthorized();
  await page.getByRole("button", { name: "投影を一時非表示" }).click();
  await expect(page.getByLabel("管理者 PIN")).toBeVisible();
});

test("finished results are published only from admin and publication does not advance the stage", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "finished");
  await expect(page.locator("main").getByRole("button")).toHaveCount(0);
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

test("first presenter progression requests fullscreen before mutation and ignores Escape afterwards", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page, { fullscreenSupported: true });
  await page.addInitScript(() => {
    window.__eventOrder = [];
    window.__fullscreenRequests = 0;
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: function requestFullscreen() {
        window.__fullscreenRequests += 1;
        window.__eventOrder.push("fullscreen");
        return Promise.reject(new Error("denied"));
      },
    });
  });
  await page.route("**/api/admin/presentation", async (route) => {
    if (route.request().method() === "POST")
      await page.evaluate(() => window.__eventOrder.push("mutation"));
    await route.fallback();
  });
  await signIn(page);
  await startPresentation(page);
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(0);
  await openPresenter(page);
  let adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__eventOrder.slice(-2))).toEqual([
    "fullscreen",
    "mutation",
  ]);
  await page.keyboard.press("Escape");
  adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  expect(mock.actionLog).toEqual(["start", "advance", "advance"]);
});

test("unsupported fullscreen keeps presenter progression working and is not retried", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.addInitScript(() => {
    window.__fullscreenRequests = 0;
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      get() {
        window.__fullscreenRequests += 1;
        return undefined;
      },
    });
  });
  await signIn(page);
  await startPresentation(page);
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(0);
  await openPresenter(page);
  let adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  expect(mock.actionLog).toEqual(["start", "advance", "advance"]);
});

test("a successful fullscreen request can exit through Escape without automatic re-entry", async ({
  page,
}) => {
  await installAdminApiMock(page, { fullscreenSupported: true });
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
        fullscreenTarget = document.querySelector("main");
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
  await openPresenter(page);
  let adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  await page.keyboard.press("Escape");
  adminRefresh = nextAdminMutation(page);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
  await adminRefresh;
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
});
