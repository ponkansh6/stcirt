import { test, expect } from "@playwright/test";

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

function installAdminApiMock(page: import("@playwright/test").Page) {
  let authenticated = false;
  let state: PresentationState = "not_started";
  let questionIndex = 0;
  let version = 0;
  let projectionHidden = false;
  let snapshotExists = false;
  let presentationMode: "full" | "short" = "full";
  let participantResultsVisible = false;
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
  let pauseNextParticipantResultsMutation = false;
  let releasePausedParticipantResultsMutation: (() => void) | null = null;
  let participantResultsMutationStarted: (() => void) | null = null;
  const actions: string[] = [];
  const participantResultsMutations: boolean[] = [];
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
    entries: [
      { displayName: "花子", score: 1, rank: 1 },
      { displayName: "太郎", score: 0, rank: 2 },
    ],
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
        } else {
          projection = { state };
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
      getPresentationState: () => ({ state, questionIndex, version, projectionHidden }),
      getSnapshotRevision: () => snapshotRevision,
      participantResultsMutations,
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

test("admin PIN opens same-tab presenter controls guarded by the session", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/presentation?presenter=1");
  await expect(page.getByRole("button", { name: "発表を始める" })).toHaveCount(0);

  await page.goto("/admin/presentation");

  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await expect(page).toHaveURL(/\/presentation\?presenter=1$/);
  await expect(page.locator("footer[aria-label='発表操作']")).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", repeat: true, bubbles: true }),
    );
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    input.remove();
  });
  await expect(page.getByRole("button", { name: "発表を始める" })).toBeVisible();
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
      const canvas = document
        .querySelector("[data-testid='presentation-canvas']")
        ?.getBoundingClientRect();
      const footer = document
        .querySelector("footer[aria-label='発表操作']")
        ?.getBoundingClientRect();
      return {
        canvasBottom: canvas?.bottom ?? Number.POSITIVE_INFINITY,
        footerTop: footer?.top ?? Number.NEGATIVE_INFINITY,
        footerBottom: footer?.bottom ?? Number.POSITIVE_INFINITY,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    });
    expect(layout.canvasBottom).toBeLessThanOrEqual(layout.footerTop + 1);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.innerHeight + 1);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "発表を始める" }).click();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  await page.getByRole("button", { name: "正解を発表する" }).click();
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "← 前へ" }).click();
  await expect(
    page.getByTestId("presentation-canvas").getByText("QUESTION 1", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "短縮", exact: true }).click();
  await expect(page.getByRole("button", { name: "短縮", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "投影を隠す" }).click();
  await expect(page.getByRole("heading", { name: "ただいま休憩中です" })).toBeVisible();
  await page.getByRole("button", { name: "投影を表示" }).click();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();

  mock.failNextMutationAsUnauthorized();
  await page.getByRole("button", { name: "投影を隠す" }).click();
  await expect(page.locator("footer[aria-label='発表操作']")).toHaveCount(0);
});

test("presenter metadata request failure clears controls", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await expect(page.locator("footer[aria-label='発表操作']")).toBeVisible();

  mock.failAdminReads();
  await page.getByRole("button", { name: "発表を始める" }).click();
  await expect(page.locator("footer[aria-label='発表操作']")).toHaveCount(0);
});

test("presenter recovers from a 409 by showing the latest public projection", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "発表を始める" }).click();
  await expect(page.getByRole("button", { name: "正解を発表する" })).toBeVisible();

  mock.conflictNextMutation();
  await page.getByRole("button", { name: "正解を発表する" }).click();
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "次へ進む" })).toBeVisible();
});

test("presenter ignores an older projection poll that resolves after a mutation refresh", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "発表を始める" }).click();
  await expect(page.getByRole("button", { name: "正解を発表する" })).toBeVisible();

  const oldPollStarted = mock.holdNextProjection();
  await oldPollStarted;
  await page.getByRole("button", { name: "正解を発表する" }).click();
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
  mock.releaseHeldProjection();
  await expect(page.getByRole("button", { name: "次へ進む" })).toBeVisible();
  await expect(page.getByText("正解", { exact: true }).first()).toBeVisible();
});

test("presenter single-flights rapid button and keyboard mutations", async ({ page }) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  const mutationStarted = mock.pauseNextMutation();
  await page.getByRole("button", { name: "発表を始める" }).click();
  await mutationStarted;

  await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>(".primaryControl")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(mock.actionLog).toEqual(["start"]);
  mock.releasePausedMutation();
  await expect(page.getByRole("button", { name: "正解を発表する" })).toBeVisible();
  expect(mock.actionLog).toEqual(["start"]);
});

test("republishing participant results refreshes their snapshot without changing presentation state", async ({
  page,
}) => {
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await page.getByRole("button", { name: "発表を始める" }).click();

  await expect(
    page.getByText(
      "公開するたびに、その時点の回答から結果を確定します。公開中の回答変更は次回の再公開で反映されます。",
    ),
  ).toBeVisible();
  const publishButton = page.getByRole("button", { name: "参加者結果を公開" });
  await expect(publishButton).toBeEnabled();
  const stateBeforePublication = mock.getPresentationState();
  await expect(page.getByRole("heading", { name: questions[0].question })).toBeVisible();
  mock.failNextResultsMutation();
  await publishButton.click();
  await expect(
    page.getByText("結果の準備または公開に失敗しました。結果は非公開のままです。"),
  ).toBeVisible();
  await expect(publishButton).toHaveAttribute("aria-pressed", "false");
  expect(mock.getPresentationState()).toEqual(stateBeforePublication);
  expect(mock.getSnapshotRevision()).toBe(1);

  const mutationStarted = mock.pauseNextResultsMutation();
  await publishButton.click();
  await mutationStarted;
  await expect(publishButton).toBeDisabled();
  await publishButton.evaluate((button) => {
    button.removeAttribute("disabled");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  mock.releasePausedResultsMutation();
  await expect(page.getByRole("button", { name: "参加者結果を非公開" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(mock.getPresentationState()).toEqual(stateBeforePublication);
  expect(mock.getSnapshotRevision()).toBe(2);
  await expect(
    page.getByRole("heading", { name: `${questions[0].question}（snapshot 2）` }),
  ).toBeVisible();
  expect(mock.participantResultsMutations).toEqual([true]);

  const publishedState = mock.getPresentationState();
  await page.getByRole("button", { name: "参加者結果を非公開" }).click();
  await expect(page.getByRole("button", { name: "参加者結果を公開" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(mock.getPresentationState()).toEqual(publishedState);
  expect(mock.getSnapshotRevision()).toBe(2);

  await page.getByRole("button", { name: "参加者結果を公開" }).click();
  await expect(page.getByRole("button", { name: "参加者結果を非公開" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(mock.getPresentationState()).toEqual(publishedState);
  expect(mock.getSnapshotRevision()).toBe(3);
  await expect(
    page.getByRole("heading", { name: `${questions[0].question}（snapshot 3）` }),
  ).toBeVisible();
  expect(mock.participantResultsMutations).toEqual([true, false, true]);
});

test("presenter fullscreen targets the whole wrapper and keeps controls inside", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Fullscreen behavior is verified in desktop Chromium only.",
  );
  const mock = await installAdminApiMock(page);
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "発表画面を始める" }).click();
  await expect(page.locator("footer[aria-label='発表操作']")).toBeVisible();

  await page.evaluate(() => {
    const wrapper = document.querySelector("main");
    if (!wrapper) throw new Error("Presenter wrapper was not rendered.");
    let fullscreenTarget: Element | null = null;
    const testWindow = window as Window & { __fullscreenRequestTarget?: Element | null };
    testWindow.__fullscreenRequestTarget = null;
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenTarget,
    });
    Object.defineProperty(wrapper, "requestFullscreen", {
      configurable: true,
      value: () => {
        fullscreenTarget = wrapper;
        testWindow.__fullscreenRequestTarget = wrapper;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: () => {
        fullscreenTarget = null;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      },
    });
  });

  await page.getByRole("button", { name: "全画面表示" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const target = (window as Window & { __fullscreenRequestTarget?: Element | null })
          .__fullscreenRequestTarget;
        return Boolean(
          target?.tagName === "MAIN" && target.querySelector("footer[aria-label='発表操作']"),
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const target = (window as Window & { __fullscreenRequestTarget?: Element | null })
          .__fullscreenRequestTarget;
        return document.fullscreenElement === target;
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "全画面表示を終了" }).click();
  await expect(page.locator("footer[aria-label='発表操作']")).toBeVisible();
  expect(mock.actionLog).toEqual([]);
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

test("projection requests and reacquires a screen wake lock when visibility returns", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const windowWithWakeMock = window as unknown as Window & {
      __wakeRequests: number[];
      __releaseWakeLock: () => void;
    };
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
  await expect(page.getByText("画面の自動消灯を防止中")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Window & { __wakeRequests: number[] }).__wakeRequests.length,
      ),
    )
    .toBeGreaterThanOrEqual(1);
  const initialRequestCount = await page.evaluate(
    () => (window as unknown as Window & { __wakeRequests: number[] }).__wakeRequests.length,
  );

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    (window as unknown as Window & { __releaseWakeLock: () => void }).__releaseWakeLock();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Window & { __wakeRequests: number[] }).__wakeRequests.length,
      ),
    )
    .toBeGreaterThan(initialRequestCount);
  await expect(page.getByText("画面の自動消灯を防止中")).toBeVisible();
});

test("projection shows the wake lock fallback when the API is unsupported", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: undefined });
  });
  await page.route("**/api/presentation", async (route) => {
    await route.fulfill({ json: { state: "standby" } });
  });
  await page.goto("/presentation");
  await expect(page.getByText("画面の自動消灯にご注意ください")).toBeVisible();
});
