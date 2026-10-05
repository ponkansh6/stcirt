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
  let presentationMode: "full" | "short" = "full";
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
          await route.fulfill({ json: payload() });
          return;
        }
        const body = route.request().postDataJSON() as {
          operationId?: string;
          action?: string;
          mode?: "full" | "short";
        };
        if (!authenticated || !body.operationId) {
          await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
          return;
        }
        if (body.action === "start" && state === "not_started") state = "question";
        else if (body.action === "advance") {
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
    );
}

test("admin controls use mocked session and presentation APIs", async ({ page }) => {
  await installAdminApiMock(page);
  await page.goto("/admin/presentation");

  await page.getByLabel("管理者 PIN").fill("2468");
  await page.getByRole("button", { name: "管理画面に入る" }).click();
  await expect(page.getByRole("heading", { name: "披露宴 発表操作" })).toBeVisible();

  await page.getByRole("button", { name: "発表を始める" }).click();
  await expect(page.getByRole("heading", { name: "設問のおさらい" })).toBeVisible();
  await page.getByRole("button", { name: "正解を発表する" }).click();
  await expect(page.getByRole("heading", { name: "正解・解説" })).toBeVisible();
  await page.getByRole("button", { name: "← 前の画面へ" }).click();
  await expect(page.getByRole("heading", { name: "設問のおさらい" })).toBeVisible();

  await page.getByRole("button", { name: /短縮/ }).click();
  await expect(page.getByText(/短縮中：正解を強調し、解説を省きます。/)).toBeVisible();
  await page.getByRole("button", { name: "投影画面を隠す" }).click();
  await expect(page.getByText("投影画面は非表示")).toBeVisible();
  await page.getByRole("button", { name: "投影画面を表示する" }).click();
  await expect(page.getByText("投影画面を表示中")).toBeVisible();
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
