import { test, expect } from "@playwright/test";

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
  let questionIndex = 0;
  let version = 0;
  let projectionHidden = false;
  let snapshotExists = false;
  let presentationMode: "full" | "short" = "full";
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
    presentationMode,
    participantResultsVisible,
    participantResultsReady: snapshotExists,
  });

  return page
    .route("**/api/admin/session", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { authenticated } });
        return;
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { pin?: string };
        authenticated = body.pin === "2468";
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
      page.route("**/api/admin/presentation", async (route) => {
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
          mode?: "full" | "short";
        };
        if (failNextMutationUnauthorized) {
          failNextMutationUnauthorized = false;
          authenticated = false;
          await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
          return;
        }
        if (failNextMutationConflict) {
          failNextMutationConflict = false;
          if (body.action === "advance" && state === "question") state = "answer";
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
          state = "question";
        } else if (body.action === "advance") {
          const next = stages.indexOf(state) + 1;
          if (next > 0 && next < stages.length) state = stages[next];
        } else if (body.action === "previous") {
          const previous = stages.indexOf(state) - 1;
          if (previous >= 1) state = stages[previous];
        } else if (body.action === "setMode" && body.mode) presentationMode = body.mode;
        else if (body.action === "hide") projectionHidden = true;
        else if (body.action === "show") projectionHidden = false;
        version += 1;
        await route.fulfill({ json: payload() });
      }),
    )
    .then(() =>
      page.route("**/api/presentation", async (route) => {
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
      page.route("**/api/admin/participant-results", async (route) => {
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

test("presenter query stays read-only for visitors and PIN authentication enables the start CTA", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/presentation?presenter=1");
  await expect(page.getByRole("button", { name: "プレゼンを開始" })).toHaveCount(0);
  await page.getByTestId("presentation-canvas").click();
  await page.evaluate(() =>
    document
      .querySelector("main")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  expect(mock.actionLog).toEqual([]);

  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await expect(page).toHaveURL(/\/presentation\?presenter=1$/);
  await expect(page.getByRole("button", { name: "プレゼンを開始" })).toBeVisible();
  await expect(page.getByRole("button", { name: /参加者結果を公開/ })).toHaveCount(0);
  expect(mock.actionLog).toEqual([]);

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    // Rounded CSS layout viewport for 1366×768 at 125% browser zoom, not browser UI zoom automation.
    { width: 1093, height: 614 },
    { width: 900, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const screen = document.querySelector("main")?.getBoundingClientRect();
      const canvas = document
        .querySelector("[data-testid='presentation-canvas']")
        ?.getBoundingClientRect();
      return {
        screen: screen
          ? {
              top: screen.top,
              left: screen.left,
              width: screen.width,
              height: screen.height,
            }
          : null,
        canvas: canvas
          ? { top: canvas.top, left: canvas.left, right: canvas.right, bottom: canvas.bottom }
          : null,
        hasFooter: Boolean(document.querySelector("footer[aria-label='発表操作']")),
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    });
    expect(layout.screen).not.toBeNull();
    expect(layout.screen?.top).toBeCloseTo(0, 0);
    expect(layout.screen?.left).toBeCloseTo(0, 0);
    expect(layout.screen?.width).toBeCloseTo(layout.innerWidth, 0);
    expect(layout.screen?.height).toBeCloseTo(layout.innerHeight, 0);
    expect(layout.canvas).not.toBeNull();
    expect(layout.canvas?.top).toBeGreaterThanOrEqual(-1);
    expect(layout.canvas?.left).toBeGreaterThanOrEqual(-1);
    expect(layout.canvas?.right).toBeLessThanOrEqual(layout.innerWidth + 1);
    expect(layout.canvas?.bottom).toBeLessThanOrEqual(layout.innerHeight + 1);
    expect(layout.hasFooter).toBe(false);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
  }
  expect(mock.actionLog).toEqual([]);
});

test("presenter metadata request failure clears controls", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await expect(page.getByRole("button", { name: "プレゼンを開始" })).toBeVisible();

  mock.failAdminReads();
  await expect(page.getByRole("button", { name: "プレゼンを開始" })).toHaveCount(0, {
    timeout: 4_000,
  });
});

test("a 401 removes presenter actions and returns to spectator projection", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  mock.failNextMutationAsUnauthorized();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();

  await expect(page.getByRole("button", { name: "プレゼンを開始" })).toHaveCount(0);
  await expect(page.getByText("発表が始まるまで、少々お待ちください")).toBeVisible();
  expect(mock.actionLog).toEqual([]);
});

test("presenter recovers from a 409 by showing the latest public projection", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();

  const eventsBeforeConflict = mock.getPresentationRouteEvents().length;
  const olderProjectionStarted = mock.holdNextProjection();
  await olderProjectionStarted;
  mock.conflictNextMutation();
  await page.getByTestId("presentation-canvas").click({ position: { x: 24, y: 24 } });
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  expect(mock.getPresentationState().state).toBe("answer");
  const recoveryEvents = mock.getPresentationRouteEvents().slice(eventsBeforeConflict);
  const conflictIndex = recoveryEvents.indexOf("mutation:advance:409");
  const freshProjectionIndex = recoveryEvents.findIndex(
    (event, index) => index > conflictIndex && event === "projection:get:answer",
  );
  expect(conflictIndex).toBeGreaterThanOrEqual(0);
  expect(freshProjectionIndex).toBeGreaterThan(conflictIndex);
  mock.releaseHeldProjection();
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
});

test("presenter ignores an older projection poll that resolves after a mutation refresh", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();

  const oldPollStarted = mock.holdNextProjection();
  await oldPollStarted;
  await page.getByTestId("presentation-canvas").click({ position: { x: 24, y: 24 } });
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  mock.releaseHeldProjection();
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
});

test("presenter single-flights rapid button and keyboard mutations", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  const mutationStarted = mock.pauseNextMutation();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();
  await mutationStarted;

  await page.evaluate(() => {
    const canvas = document.querySelector("[data-testid='presentation-canvas']");
    canvas?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector("main")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(mock.actionLog).toEqual(["start"]);
  mock.releasePausedMutation();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  expect(mock.actionLog).toEqual(["start"]);
});

test("presenter progresses by click and keyboard while ignoring interactive, modified, and repeated keys", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).press("Space");
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  expect(mock.actionLog).toEqual(["start"]);

  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) throw new Error("Presentation wrapper missing");
    const dispatch = (target: Element, init: KeyboardEventInit) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
    const input = document.createElement("input");
    const button = document.createElement("button");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    main.append(input, button, editable);
    dispatch(input, { key: "ArrowRight" });
    dispatch(input, { key: " " });
    dispatch(button, { key: "ArrowRight" });
    dispatch(button, { key: "Enter" });
    dispatch(editable, { key: "ArrowRight" });
    dispatch(main, { key: "ArrowRight", repeat: true });
    dispatch(main, { key: "ArrowRight", altKey: true });
    dispatch(main, { key: "ArrowRight", ctrlKey: true });
    dispatch(main, { key: "ArrowRight", metaKey: true });
    input.remove();
    button.remove();
    editable.remove();
  });
  expect(mock.actionLog).toEqual(["start"]);
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();

  await page.locator("main").press("ArrowRight");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await page.locator("main").press("ArrowLeft");
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  await page.locator("main").focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await page.locator("main").press("Enter");
  await expect(page.getByRole("heading", { name: "いよいよ、結果発表です" })).toBeVisible();
  await page.getByTestId("presentation-canvas").click({ position: { x: 24, y: 24 } });
  await expect.poll(() => mock.getPresentationState().state).toBe("third");
  expect(mock.actionLog).toEqual(["start", "advance", "previous", "advance", "advance", "advance"]);
});

test("rank entrance motion is limited to forward presenter entry and replays after returning", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();
  const canvas = page.getByTestId("presentation-canvas");
  for (const stage of ["answer", "podium_preview", "third", "second"] as const) {
    await canvas.click({ position: { x: 24, y: 24 } });
    await expect.poll(() => mock.getPresentationState().state).toBe(stage);
  }

  const winnerRegion = page.getByRole("region", { name: "第2位の勝者一覧" });
  const winnerCard = winnerRegion.locator("article").first();
  await expect
    .poll(() =>
      winnerCard.evaluate((card) => {
        const [rank, score, name] = Array.from(card.children);
        return {
          tags: Array.from(card.children, (child) => child.tagName),
          text: [rank?.textContent?.trim(), score?.textContent?.trim()],
          sizes: [
            rank ? Number.parseFloat(getComputedStyle(rank).fontSize) : 0,
            score ? Number.parseFloat(getComputedStyle(score).fontSize) : 0,
            name ? Number.parseFloat(getComputedStyle(name).fontSize) : 0,
          ],
        };
      }),
    )
    .toMatchObject({
      tags: ["P", "P", "H1"],
      text: ["2位", "0.00 ポイント"],
    });
  const winnerHierarchy = await winnerCard.evaluate((card) => {
    const sizes = Array.from(card.children, (child) =>
      Number.parseFloat(getComputedStyle(child).fontSize),
    );
    return sizes[0]! > sizes[2]! && sizes[1]! > sizes[2]!;
  });
  expect(winnerHierarchy).toBe(true);
  const animationName = () => winnerCard.evaluate((card) => getComputedStyle(card).animationName);
  await expect.poll(animationName).not.toBe("none");
  await page.waitForTimeout(1_400);
  await expect.poll(animationName).toBe("none");

  await page.reload();
  await expect(page.getByRole("region", { name: "第2位の勝者一覧" })).toBeVisible();
  await page.waitForTimeout(1_600);
  await expect.poll(animationName).toBe("none");

  await page.locator("main").press("ArrowLeft");
  await expect.poll(() => mock.getPresentationState().state).toBe("third");
  const thirdPlaceRegion = page.getByRole("region", { name: "第3位の勝者一覧" });
  await expect(thirdPlaceRegion).not.toHaveClass(/announce/);
  await page.locator("main").press("ArrowRight");
  await expect.poll(() => mock.getPresentationState().state).toBe("second");
  await expect.poll(animationName).not.toBe("none");
});

test("reduced motion renders rank announcements without entrance animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();
  const canvas = page.getByTestId("presentation-canvas");
  for (const stage of ["answer", "podium_preview", "third", "second"] as const) {
    await canvas.click({ position: { x: 24, y: 24 } });
    await expect.poll(() => mock.getPresentationState().state).toBe(stage);
  }

  const winnerRegion = page.getByRole("region", { name: "第2位の勝者一覧" });
  await expect(winnerRegion).toBeVisible();
  await expect
    .poll(() =>
      winnerRegion.locator("article").evaluate((card) => getComputedStyle(card).animationName),
    )
    .toBe("none");
  await expect(winnerRegion).not.toHaveClass(/announce/);
});

test("tied winners preserve rank, points, and long names within the presentation viewport", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  const longName = "とても長いお名前が画面からはみ出さないことを確認するための受賞者";
  mock.setWinnerEntries([
    { displayName: longName, score: 0.75, rank: 2 },
    { displayName: "もう一人の受賞者", score: 0.75, rank: 2 },
  ]);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();

  const canvas = page.getByTestId("presentation-canvas");
  for (const stage of ["answer", "podium_preview", "third", "second"] as const) {
    await canvas.click({ position: { x: 24, y: 24 } });
    await expect.poll(() => mock.getPresentationState().state).toBe(stage);
  }

  const winnerRegion = page.getByRole("region", { name: "第2位の勝者一覧" });
  await expect(winnerRegion).toBeVisible();
  const cards = winnerRegion.locator("article");
  await expect(cards).toHaveCount(2);
  await expect
    .poll(() =>
      cards.evaluateAll((elements) =>
        elements.map((card) => {
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
      ["2位", "0.75 ポイント", `${longName} さん`],
      ["2位", "0.75 ポイント", "もう一人の受賞者 さん"],
    ]);

  const geometry = await page.evaluate(() => {
    const bounds = Array.from(
      document.querySelectorAll("[aria-label='第2位の勝者一覧'] article"),
    ).map((card) => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      bounds,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.bounds).toHaveLength(2);
  for (const bounds of geometry.bounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(bounds.top).toBeGreaterThanOrEqual(-1);
    expect(bounds.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  }
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.height).toBeLessThanOrEqual(geometry.viewportHeight);
});

test("finished presenter publishes participant results with true and keeps the stage fixed", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await expect(page.getByRole("button", { name: "プレゼンを開始" })).toBeVisible();
  await expect(page.getByRole("button", { name: "参加者結果を公開" })).toHaveCount(0);

  await page.getByRole("button", { name: "プレゼンを開始" }).click();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  const target = page.getByTestId("presentation-canvas");
  for (const stage of [
    "answer",
    "podium_preview",
    "third",
    "second",
    "first",
    "finished",
  ] as const) {
    await target.click({ position: { x: 24, y: 24 } });
    await expect.poll(() => mock.getPresentationState().state).toBe(stage);
  }

  await expect(page.getByRole("button", { name: "参加者結果を公開" })).toBeVisible();
  const publishButton = page.getByRole("button", { name: "参加者結果を公開" });
  const stateBeforePublication = mock.getPresentationState();
  mock.failNextResultsMutation();
  await publishButton.click();
  await expect(
    page.getByText("結果の準備または公開に失敗しました。結果は非公開のままです。"),
  ).toBeVisible();
  expect(mock.getPresentationState()).toEqual(stateBeforePublication);
  await expect(publishButton).toBeEnabled();
  expect(mock.participantResultsMutations).toEqual([]);
  expect(mock.participantResultsStageSnapshots).toEqual(["finished"]);

  await publishButton.click();
  await expect(page.getByRole("status")).toContainText("参加者結果は公開済みです");
  expect(mock.getPresentationState()).toEqual(stateBeforePublication);
  expect(mock.participantResultsMutations).toEqual([true]);
  expect(mock.participantResultsStageSnapshots).toEqual(["finished", "finished"]);
  await expect(page.getByRole("button", { name: "参加者結果を公開" })).toHaveCount(0);
  await expect
    .poll(
      () =>
        mock
          .getPresentationRouteEvents()
          .filter((event) => event === "projection:get:after-results-publish:finished").length,
    )
    .toBeGreaterThan(0);
  await expect(page.locator("#finished-title")).toBeVisible();
});

test("start requests fullscreen in the trusted gesture before its mutation and survives rejection", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page, { fullscreenSupported: true });
  await page.addInitScript(() => {
    const targetWindow = window;
    targetWindow.__eventOrder = [];
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: function requestFullscreen() {
        targetWindow.__eventOrder.push("fullscreen");
        return Promise.reject(new Error("fullscreen denied"));
      },
    });
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button")?.textContent?.includes("プレゼンを開始"))
          targetWindow.__eventOrder.push(event.isTrusted ? "trusted-click" : "untrusted-click");
      },
      true,
    );
  });
  await page.route("**/api/admin/presentation", async (route) => {
    if (route.request().method() === "POST") {
      await page.evaluate(() => {
        window.__eventOrder.push("mutation-received");
      });
    }
    await route.fallback();
  });
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();

  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  expect(mock.actionLog).toEqual(["start"]);
  expect(await page.evaluate(() => window.__eventOrder)).toEqual([
    "trusted-click",
    "fullscreen",
    "mutation-received",
  ]);
});

test("start continues when fullscreen is unsupported", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();

  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  expect(mock.actionLog).toEqual(["start"]);
});

test("fullscreen is not retried after Escape until the presenter advances intentionally", async ({
  page,
}) => {
  await installAdminApiMock(page, { fullscreenSupported: true });
  await page.addInitScript(() => {
    const targetWindow = window;
    targetWindow.__fullscreenRequests = 0;
    let fullscreenTarget: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenTarget,
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: function requestFullscreen() {
        targetWindow.__fullscreenRequests += 1;
        fullscreenTarget = document.querySelector("main");
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "__exitTestFullscreen", {
      configurable: true,
      value: () => {
        fullscreenTarget = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      },
    });
  });
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "プレゼンを開始" }).click();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fullscreenRequests)).toBe(1);

  await page.evaluate(() => document.__exitTestFullscreen());
  await page.waitForTimeout(1_700);
  await expect.poll(() => page.evaluate(() => window.__fullscreenRequests)).toBe(1);

  await page.getByTestId("presentation-canvas").click({ position: { x: 24, y: 24 } });
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fullscreenRequests)).toBe(2);
});

test("projection exposes only the current public payload and stays legible at 16:9 and 4:3", async ({
  page,
}) => {
  let projection: Record<string, unknown> = {
    state: "question",
    question: {
      id: 11,
      ordinal: 1,
      total: 1,
      question: questions[0].question,
      choices: questions[0].choices,
    },
  };
  await page.route("**/api/presentation", async (route) => {
    await route.fulfill({ json: projection });
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/presentation");
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  expect(Object.keys(projection.question as object)).not.toContain("correctAnswer");
  expect(Object.keys(projection.question as object)).not.toContain("explanation");
  await expect(page.getByText("共通の友人が開いた集まりで出会いました。")).toHaveCount(0);
  await expect(page.getByText("正解", { exact: true })).toHaveCount(0);

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }

  projection = {
    state: "answer",
    question: {
      id: 11,
      ordinal: 1,
      total: 1,
      question: questions[0].question,
      choices: questions[0].choices,
      correctAnswer: "大学",
      correctIndex: 1,
    },
  };
  await page.reload();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(questions[0].explanation)).toHaveCount(0);
  expect(Object.keys((projection.question as object) || {})).not.toContain("explanation");

  projection = { state: "standby" };
  await page.reload();
  await expect(page.getByRole("heading", { name: "ただいま休憩中です" })).toBeVisible();
  expect(Object.keys(projection)).toEqual(["state"]);
  await expect(page.getByRole("heading", { name: questions[0].question })).toHaveCount(0);
});

test("fifth free-text answer projection shows the model answer without a response list", async ({
  page,
}) => {
  let projection: Record<string, unknown> = {
    state: "answer",
    question: {
      id: 105,
      ordinal: 5,
      total: 5,
      question: "第5問の自由記述",
      choices: [],
      answerType: "freeText",
      expectedAnswer: "模範解答だけを表示",
    },
  };
  await page.route("**/api/presentation", async (route) => {
    await route.fulfill({ json: projection });
  });

  await page.goto("/presentation");
  await expect(page.getByRole("heading", { name: "第5問の自由記述" })).toBeVisible();
  await expect(page.getByText("模範解答だけを表示")).toBeVisible();
  await expect(page.getByRole("list")).toHaveCount(0);
  await expect(page.getByText("回答者A")).toHaveCount(0);
  await expect(page.getByText("個人回答")).toHaveCount(0);
  await expect(page.getByText(/類似度|得点/)).toHaveCount(0);

  projection = {
    state: "answer",
    question: {
      id: 106,
      ordinal: 2,
      total: 5,
      question: "別の自由記述",
      choices: [],
      answerType: "freeText",
      expectedAnswer: "別問題の模範解答",
      responses: [
        {
          displayName: "回答者A",
          answer: "個人回答",
          answerKind: "freeText",
          similarity: 0.9,
          score: 0.5,
        },
      ],
    },
  };
  await page.reload();
  await expect(page.getByRole("heading", { name: "別の自由記述" })).toBeVisible();
  await expect(page.getByText("別問題の模範解答")).toBeVisible();
  await expect(page.getByText("回答者A")).toBeVisible();
  await expect(page.getByText(/個人回答/)).toBeVisible();
});

test("projection requests and reacquires a screen wake lock when visibility returns", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const windowWithWakeMock = window;
    windowWithWakeMock.__wakeRequests = [];
    let currentLock: {
      released: boolean;
      release: () => Promise<void>;
      addEventListener: (_type: string, listener: () => void) => void;
    } | null = null;
    windowWithWakeMock.__releaseWakeLock = () => {
      if (currentLock) void currentLock.release();
    };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          windowWithWakeMock.__wakeRequests.push(1);
          const listeners: (() => void)[] = [];
          currentLock = {
            released: false,
            release: async () => {
              if (currentLock?.released) return;
              if (currentLock) currentLock.released = true;
              listeners.forEach((listener) => listener());
            },
            addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
          };
          return currentLock;
        },
      },
    });
  });
  await page.route("**/api/presentation", async (route) => {
    await route.fulfill({ json: { state: "standby" } });
  });
  await page.goto("/presentation");
  await expect
    .poll(() => page.evaluate(() => window.__wakeRequests.length))
    .toBeGreaterThanOrEqual(1);
  const initialRequestCount = await page.evaluate(() => window.__wakeRequests.length);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.__releaseWakeLock();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => page.evaluate(() => window.__wakeRequests.length))
    .toBeGreaterThan(initialRequestCount);
});

test("projection remains usable when the wake lock API is unsupported", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: undefined });
  });
  await page.route("**/api/presentation", async (route) => {
    await route.fulfill({ json: { state: "standby" } });
  });
  await page.goto("/presentation");
  await expect(page.getByRole("heading", { name: "ただいま休憩中です" })).toBeVisible();
});
