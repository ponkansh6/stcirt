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
        await route.fulfill({ status: authenticated ? 200 : 401, json: { authenticated } });
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
      context.route("**/api/admin/presentation", async (route) => {
        if (route.request().method() === "GET") {
          if (failAdminRead) {
            await route.fulfill({ status: 503, json: { error: "Unavailable" } });
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
        await route.fulfill({ json: payload() });
      }),
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
  const controlsResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/presentation") && response.request().method() === "GET",
  );
  await page.goto("/presentation?presenter=1");
  await controlsResponse;
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
      response.url().endsWith("/api/admin/presentation") && response.request().method() === "GET",
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
    const adminRefresh = nextAdminRefresh(page);
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
  await page.goto("/presentation?presenter=1");
  await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  await page.getByTestId("presentation-canvas").click();
  await page.locator("main").press("ArrowRight");
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
  await main.press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await main.press("Space");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();

  const box = await main.boundingBox();
  if (!box) throw new Error("Projection wrapper is missing");
  const thirdRefresh = nextAdminRefresh(page);
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(slideFor(page, "third")).toBeVisible();
  await thirdRefresh;
  await waitForRenderFrames(page);
  expect(mock.actionLog.filter((action) => action === "advance")).toHaveLength(3);
  const secondRefresh = nextAdminRefresh(page);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(slideFor(page, "second")).toBeVisible();
  await secondRefresh;
  await waitForRenderFrames(page);
  expect(mock.actionLog.filter((action) => action === "previous")).toHaveLength(1);
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
  const previousRefresh = nextAdminRefresh(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "first")).toBeVisible();
  await previousRefresh;
});

test("vertical rank scrolling is preserved and does not progress the stage", async ({ page }) => {
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
  await winners.evaluate((node) => {
    node.scrollTop = 0;
  });
  await winners.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => winners.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(mock.getPresentationState().state).toBe("third");
});

test("reduced motion keeps rank announcement static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "third");
  const winners = page.getByRole("region", { name: "第3位の勝者一覧" });
  await expect(winners).toBeVisible();
  await expect(winners).not.toHaveClass(/announce/);
});

test("rank animation runs only on forward entry, then can replay after previous", async ({
  page,
}) => {
  await installAdminApiMock(page);
  await signIn(page);
  await startPresentation(page);
  await openPresenter(page);
  await advanceTo(page, "second");
  const winners = page.getByRole("region", { name: "第2位の勝者一覧" });
  await expect(winners).toHaveClass(/announce/);
  await expect
    .poll(() => winners.evaluate((node) => node.className.includes("announce")), { timeout: 2_000 })
    .toBe(false);
  const previousRefresh = nextAdminRefresh(page);
  await page.locator("main").press("ArrowLeft");
  await expect(slideFor(page, "third")).toBeVisible();
  await previousRefresh;
  await expect(page.getByRole("region", { name: "第3位の勝者一覧" })).not.toHaveClass(/announce/);
  const replayRefresh = nextAdminRefresh(page);
  await page.locator("main").press("ArrowRight");
  await expect(slideFor(page, "second")).toBeVisible();
  await replayRefresh;
  await expect(winners).toHaveClass(/announce/);
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
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => window.__eventOrder.slice(-2))).toEqual([
    "fullscreen",
    "mutation",
  ]);
  await page.keyboard.press("Escape");
  await page.locator("main").press("ArrowRight");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
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
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  await page.locator("main").press("ArrowRight");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
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
  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
  await page.keyboard.press("Escape");
  await page.locator("main").press("ArrowRight");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
  expect(await page.evaluate(() => window.__fullscreenRequests)).toBe(1);
});
