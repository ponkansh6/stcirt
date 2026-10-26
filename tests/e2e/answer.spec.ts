import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page, type Route } from "./fixtures/test";
import { makeQuestion } from "../fixtures/question";
import { expectNoAccessibilityViolations } from "./axe";
import { expectPrimaryTargetGeometry } from "./target-geometry";
import * as schema from "../../src/lib/db/schema";
import { e2eDatabaseUrl, e2eParticipantPin } from "./fixtures/admin-auth";

const questionFor = (id: number) =>
  makeQuestion({
    id,
    question: `Question ${id}?`,
    choices: id === 5 ? [] : [`Option ${id}A`, `Option ${id}B`, `Option ${id}C`, `Option ${id}D`],
    answerType: id === 5 ? "freeText" : "selected",
  });

const longJapaneseQuestion = "長文の設問です。".repeat(20);
const longJapaneseChoice = "長文の選択肢です。".repeat(20);
const noSpaceChoice = "BoundaryWithoutSpaces1234567890".repeat(8);
const emojiChoice = "🧪🌿🎓📚✨".repeat(24);

test("@mobile answer login controls meet the selected target geometry at 320px", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/answer");

  await expectPrimaryTargetGeometry(
    page.getByRole("textbox", { name: "受験者氏名" }),
    "answer participant name at 320px",
  );
  await expectPrimaryTargetGeometry(
    page.getByRole("textbox", { name: "受験コード" }),
    "answer PIN at 320px",
  );
  await expectPrimaryTargetGeometry(
    page.getByRole("button", { name: "はじめる" }),
    "answer login submit at 320px",
  );
});

test("@chromium answer login controls meet the selected target geometry at 1280px", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/answer");

  await expectPrimaryTargetGeometry(
    page.getByRole("textbox", { name: "受験者氏名" }),
    "answer participant name at 1280px",
  );
  await expectPrimaryTargetGeometry(
    page.getByRole("textbox", { name: "受験コード" }),
    "answer PIN at 1280px",
  );
  await expectPrimaryTargetGeometry(
    page.getByRole("button", { name: "はじめる" }),
    "answer login submit at 1280px",
  );
});

test("@chromium disables the answer glass header for stronger contrast and reduced transparency", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  await page.goto("/answer");

  const glassHeader = page.locator("header.glass-header");
  await expect(glassHeader).toHaveCount(1);
  await expect(glassHeader).toHaveCSS("backdrop-filter", /blur/);

  await page.emulateMedia({ contrast: "more" });
  await expect(glassHeader).toHaveCSS("backdrop-filter", "none");

  await page.emulateMedia({ contrast: "no-preference" });
  await expect(glassHeader).toHaveCSS("backdrop-filter", /blur/);

  const cdpSession = await page.context().newCDPSession(page);
  try {
    await cdpSession.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    expect(
      await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches),
    ).toBe(true);
    await expect(glassHeader).toHaveCSS("backdrop-filter", "none");
  } finally {
    await cdpSession.detach();
  }
});

type BatchAnswer =
  | { questionId: number; selectedIndex: number }
  | { questionId: number; freeText: string };
type SavedBatchAnswer =
  | { questionId: number; answerKind: "selected"; selectedIndex: number; freeText: null }
  | { questionId: number; answerKind: "freeText"; selectedIndex: null; freeText: string };
type BatchPayload = {
  submissionId: string;
  operationId: string;
  expectedRevision: number;
  answers: BatchAnswer[];
};

type ApiRequestTrace = { method: string; path: string };

function matchesRequestPath(requestPath: string, path: string) {
  return (
    requestPath === path || (path.includes("?") === false && requestPath.startsWith(`${path}?`))
  );
}

function captureApiRequests(page: Page) {
  const requests: ApiRequestTrace[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}` });
    }
  });
  return requests;
}

function requestIndex(requests: ApiRequestTrace[], method: string, path: string, fromIndex = 0) {
  return requests.findIndex(
    (request, index) =>
      index >= fromIndex && request.method === method && matchesRequestPath(request.path, path),
  );
}

async function mockParticipantSession(
  page: Page,
  initialName: string | null = null,
  latestSubmission: {
    submissionId: string;
    revision: number;
    answers: SavedBatchAnswer[];
  } | null = null,
) {
  let activeLatestSubmission = latestSubmission;
  let activeParticipant = initialName ? { id: 17, name: initialName } : null;
  let activeCredentials = initialName ? { name: initialName, pin: "0123" } : null;
  const loginRequests: unknown[] = [];
  let logoutRequests = 0;
  let nextParticipantId = 18;

  await page.route("**/api/answers/latest", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submission: activeLatestSubmission }),
    });
  });

  await page.route("**/api/participants/session", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ participant: activeParticipant }),
      });
      return;
    }
    if (method === "POST") {
      const body = route.request().postDataJSON();
      loginRequests.push(body);
      const sameCredentials =
        activeCredentials !== null &&
        activeCredentials.name === body.name &&
        activeCredentials.pin === body.pin;
      activeParticipant = sameCredentials
        ? activeParticipant
        : { id: nextParticipantId++, name: body.name };
      activeCredentials = { name: body.name, pin: body.pin };
      await page.context().addCookies([
        {
          name: "stcirt_participant_session",
          value: "mock-session",
          url: new URL(route.request().url()).origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "set-cookie": "stcirt_participant_session=mock-session; Path=/; HttpOnly; SameSite=Lax",
        },
        body: JSON.stringify({
          participant: activeParticipant,
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
      });
      return;
    }
    if (method === "DELETE") {
      logoutRequests += 1;
      activeParticipant = null;
      activeCredentials = null;
      await route.fulfill({
        status: 204,
        headers: {
          "set-cookie": "stcirt_participant_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/participants/results**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "waiting" }),
    });
  });

  // Completion views load this participant-only state; keep the shared mock
  // usable for ordinary answer tests. Tests with a dedicated assisted mock
  // register it later and retain Playwright's route precedence.
  await page.route("**/api/participants/assisted", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ participant: null, hasSubmission: false, eligible: true }),
    });
  });

  return {
    loginRequests,
    setLatestSubmission(submission: typeof latestSubmission) {
      activeLatestSubmission = submission;
    },
    get logoutRequests() {
      return logoutRequests;
    },
  };
}

async function mockQuestions(page: Page, requests: string[] = []) {
  await page.route("**/api/questions/batch", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ questions: [1, 2, 3, 4, 5].map(questionFor) }),
    });
  });
}

test("@chromium result navigation keeps completion visible with link pending until the RSC request continues", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "The signed participant session and isolated DB navigation flow runs in Chromium only.",
  );
  test.setTimeout(90_000);

  const client = createClient({ url: e2eDatabaseUrl, authToken: "" });
  const db = drizzle({ client, schema });
  const ownerName = `E2E result navigation ${randomUUID()}`;
  const baseUrl = "http://127.0.0.1:3001";
  const ownerContext = await browser.newContext();
  let ownerId: number | null = null;
  let migrationReady = false;
  let releaseHeldNavigationRequest: (() => void) | null = null;

  try {
    await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });
    migrationReady = true;
    // The active presentation and participant result settings use ID 1.
    // Clear this isolated E2E database's previous fixture state first.
    await db.delete(schema.presentationEntries);
    await db.delete(schema.presentationQuestions);
    await db.delete(schema.presentationSessions);
    await db.delete(schema.participantResultSettings);
    const [owner] = await db
      .insert(schema.examParticipants)
      .values({ normalizedName: ownerName.normalize("NFC"), displayName: ownerName })
      .returning({ id: schema.examParticipants.id });
    if (!owner) throw new Error("Failed to seed the result navigation participant");
    ownerId = owner.id;
    await db.insert(schema.presentationSessions).values({
      id: 1,
      state: "finished",
      version: 1,
      questionIndex: 0,
      questionCount: 5,
      snapshotRevision: 1,
      projectionHidden: false,
      presentationMode: "full",
    });
    const seededQuestions = [1, 2, 3, 4, 5].map((position) => ({
      sessionId: 1,
      position: position - 1,
      sourceQuestionId: 98000 + position,
      question: `Question ${position}?`,
      choices: position === 5 ? [] : [`Option ${position}A`, `Option ${position}B`],
      correctIndex: 0,
      explanation: null,
    }));
    await db.insert(schema.presentationQuestions).values(seededQuestions);
    await db.insert(schema.presentationEntries).values({
      sessionId: 1,
      participantId: owner.id,
      displayName: ownerName,
      score: 0,
      rank: 1,
      isAggregationTarget: true,
      answers: seededQuestions.map((question) => ({
        questionId: question.sourceQuestionId,
        answerKind: "unanswered" as const,
        selectedIndex: null,
        freeText: null,
        rawScore: null,
        normalizedScore: null,
      })),
    });
    await db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: true,
      everPublished: true,
    });

    const login = await ownerContext.request.post(`${baseUrl}/api/participants/session`, {
      data: { name: ownerName, pin: e2eParticipantPin },
      headers: { Origin: baseUrl },
    });
    expect(login.status()).toBe(200);
    const participantCookie = (await ownerContext.cookies(baseUrl)).find(
      ({ name }) => name === "stcirt_participant_session",
    );
    expect(participantCookie?.value).toBeTruthy();
    if (!participantCookie) throw new Error("Participant login did not issue a session cookie");
    await page.context().addCookies([participantCookie]);

    const submissionId = "00000000-0000-4000-8000-000000000098";
    const answers: SavedBatchAnswer[] = [
      ...[1, 2, 3, 4].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 0,
        freeText: null,
      })),
      {
        questionId: 5,
        answerKind: "freeText",
        selectedIndex: null,
        freeText: "保存済み回答",
      },
    ];
    await mockParticipantSession(page, ownerName, { submissionId, revision: 1, answers });
    await mockQuestions(page);
    // The UI needs a published result to expose its link. The results-page SSR
    // still uses the real signed cookie and isolated database seeded above.
    await page.route("**/api/participants/results**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "visible",
          rank: 1,
          participantCount: 1,
          isAggregationTarget: true,
          maxScore: 5,
          score: 0,
          questions: [1, 2, 3, 4, 5].map((position) => ({
            position: position - 1,
            question: `Question ${position}?`,
            answer: { kind: "unanswered" },
          })),
        }),
      });
    });
    await page.route("**/api/answers/batch**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ resultsVisible: false }),
      });
    });

    let announceNavigationRequest!: () => void;
    const navigationRequest = new Promise<void>((resolve) => {
      announceNavigationRequest = resolve;
    });
    let releaseNavigationRequest!: () => void;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigationRequest = resolve;
    });
    let navigationReleased = false;
    releaseHeldNavigationRequest = () => {
      if (navigationReleased) return;
      navigationReleased = true;
      releaseNavigationRequest();
    };
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname !== "/results" || request.method() !== "GET") {
        await route.fallback();
        return;
      }
      const headers = request.headers();
      if (headers["next-router-prefetch"]) {
        await route.abort();
        return;
      }
      if (headers.rsc !== "1") {
        await route.fallback();
        return;
      }
      expect(url.searchParams.has("_rsc")).toBe(true);
      expect(url.searchParams.get("scope")).toBeNull();
      announceNavigationRequest();
      await navigationGate;
      await route.continue();
    });

    await page.goto("/answer");
    await expect(page.getByRole("heading", { level: 1, name: "回答済み" })).toBeVisible();
    const resultsLink = page.getByRole("link", { name: "自分の結果を見る" });
    await expect(resultsLink).toHaveAttribute("href", "/results");
    await page.evaluate(() => {
      type ResultsObserverWindow = Window & {
        __resultsSpinnerSeen?: boolean;
        __resultsObserver?: MutationObserver;
      };
      const monitoredWindow = window as ResultsObserverWindow;
      monitoredWindow.__resultsSpinnerSeen = false;
      monitoredWindow.__resultsObserver = new MutationObserver(() => {
        if (document.body.textContent?.includes("結果を読み込んでいます。")) {
          monitoredWindow.__resultsSpinnerSeen = true;
        }
      });
      monitoredWindow.__resultsObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });

    const clickPromise = resultsLink.click();
    await navigationRequest;
    await expect(page.getByRole("heading", { level: 1, name: "回答済み" })).toBeVisible();
    await expect(resultsLink).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("結果ページへ移動しています。");

    releaseHeldNavigationRequest();
    await clickPromise;
    await expect(page).toHaveURL(/\/results(?:\?.*)?$/);
    await expect(page.getByRole("heading", { level: 1, name: "あなたの結果" })).toBeVisible();
    await expect(page.getByText("結果を読み込んでいます。")).toHaveCount(0);
    const spinnerWasObserved = await page.evaluate(() => {
      type ResultsObserverWindow = Window & {
        __resultsSpinnerSeen?: boolean;
        __resultsObserver?: MutationObserver;
      };
      const monitoredWindow = window as ResultsObserverWindow;
      monitoredWindow.__resultsObserver?.disconnect();
      return monitoredWindow.__resultsSpinnerSeen;
    });
    expect(spinnerWasObserved).toBe(false);
  } finally {
    releaseHeldNavigationRequest?.();
    if (migrationReady) {
      await db.delete(schema.presentationEntries);
      await db.delete(schema.presentationQuestions);
      await db.delete(schema.presentationSessions);
      await db.delete(schema.participantResultSettings);
      if (ownerId !== null) {
        await db.delete(schema.examParticipants).where(eq(schema.examParticipants.id, ownerId));
      }
    }
    await ownerContext.close();
    await client.close();
  }
});

async function signIn(page: Page, name = "Test Participant", pin = "0123") {
  await page.getByLabel("受験者氏名").fill(name);
  await page.getByLabel("受験コード").fill(pin);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(
    page.getByRole("heading", {
      name: /しゅんたま検定|受検票|問題が足りません|問題を読み込めませんでした/,
    }),
  ).toBeVisible();
}

async function startQuiz(page: Page) {
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
}

async function expectResultsWaiting(page: Page) {
  await expect(page.getByRole("heading", { name: "回答済み" })).toBeVisible();
}

async function selectRadio(page: Page, name: RegExp) {
  const radio = page.getByRole("radio", { name });
  await radio.locator("xpath=ancestor::label").click();
  await expect(radio).toBeChecked();
}

async function expectCenteredHitTest(locator: Locator, name: string) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      inViewport: x >= 0 && x < document.documentElement.clientWidth && y >= 0 && y < innerHeight,
      hitAcceptsTarget: hit === element || (hit !== null && element.contains(hit)),
    };
  });
  expect(result.inViewport, `${name} center is in the viewport`).toBe(true);
  expect(result.hitAcceptsTarget, `${name} center is not occluded`).toBe(true);
}

async function answerQuestion(page: Page, id: number, choice: string) {
  if (id === 5) {
    await page.getByRole("textbox", { name: "回答" }).fill(`自由記載${choice}`);
  } else {
    await selectRadio(page, new RegExp(`Option ${id}${choice}`));
  }
}

test("@chromium participant login follows native Tab/Enter and session request order", async ({
  page,
}) => {
  const requestTrace = captureApiRequests(page);
  const { loginRequests } = await mockParticipantSession(page);
  const questionRequests: string[] = [];
  await mockQuestions(page, questionRequests);

  await page.goto("/answer");
  const name = page.getByRole("textbox", { name: "受験者氏名" });
  const pin = page.getByRole("textbox", { name: "受験コード" });
  const submit = page.getByRole("button", { name: "はじめる" });
  await expect(name).toHaveAccessibleName("受験者氏名");
  await expect(pin).toHaveAccessibleName("受験コード");

  await name.fill("Aki");
  await name.focus();
  await page.keyboard.press("Tab");
  await expect(pin).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(name).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(pin).toBeFocused();
  await pin.fill("0123");
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("heading", {
      name: /しゅんたま検定|受検票|問題が足りません|問題を読み込めませんでした/,
    }),
  ).toBeVisible();
  expect(loginRequests).toEqual([{ name: "Aki", pin: "0123" }]);
  expect(questionRequests).toEqual(["/api/questions/batch"]);
  const session = requestIndex(requestTrace, "GET", "/api/participants/session");
  const login = requestIndex(requestTrace, "POST", "/api/participants/session");
  const latest = requestIndex(requestTrace, "GET", "/api/answers/latest");
  const questions = requestIndex(requestTrace, "GET", "/api/questions/batch");
  expect(session).toBeGreaterThanOrEqual(0);
  expect(login).toBeGreaterThan(session);
  expect(latest).toBeGreaterThan(login);
  expect(questions).toBeGreaterThan(latest);
});

test("@chromium root-to-answer flow keeps choices local, blocks an incomplete batch, then confirms all five with the participant cookie", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const submitted: Array<{ body: BatchPayload; cookie: string | undefined }> = [];
  await page.route("**/api/answers/batch**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ resultsVisible: false }),
      });
      return;
    }
    const body = route.request().postDataJSON() as BatchPayload;
    submitted.push({
      body,
      cookie: route.request().headers().cookie,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
    });
  });

  await page.goto("/");
  await signIn(page, "Aki");
  await startQuiz(page);
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  const answeringNameField = page.locator("dt").filter({ hasText: "氏名" });
  await expect(answeringNameField).toHaveText("氏名");
  await expect(answeringNameField).toBeVisible();
  await expect(answeringNameField.locator("xpath=following-sibling::dd")).toHaveText("Aki");
  await expect(page.getByText("本人の回答", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "設問へ移動" })).toBeVisible();
  const incompleteSubmit = page.getByRole("button", {
    name: "未回答の設問に回答してください",
  });
  await expect(incompleteSubmit).toBeDisabled();
  await answerQuestion(page, 1, "B");
  expect(submitted).toHaveLength(0);
  for (let id = 2; id <= 5; id += 1) await answerQuestion(page, id, "B");
  const confirm = page.getByRole("button", { name: "5問の回答を確定する" });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expectResultsWaiting(page);
  const completionNameField = page.locator("dt").filter({ hasText: "氏名" });
  await expect(completionNameField).toHaveText("氏名");
  await expect(completionNameField.locator("xpath=following-sibling::dd")).toHaveText("Aki");
  await expect(page.getByText("本人の回答", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "回答を修正する" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "設問へ移動" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await expect(page.getByText(/正解！|不正解|解説:|正答率|合格/)).toHaveCount(0);
  await expectNoAccessibilityViolations(page, "completed answer submission");
  expect(submitted).toHaveLength(1);
  expect(submitted[0].body).toMatchObject({ expectedRevision: 0 });
  expect(submitted[0].body.answers).toHaveLength(5);
  expect(
    submitted[0].body.answers.map((answer: { questionId: number }) => answer.questionId),
  ).toEqual([1, 2, 3, 4, 5]);
  expect(submitted[0].body.answers.filter((answer) => "selectedIndex" in answer)).toHaveLength(4);
  expect(submitted[0].body.answers[4]).toMatchObject({ questionId: 5, freeText: "自由記載B" });
  expect(submitted[0].cookie).toContain("stcirt_participant_session=mock-session");
});

test("@chromium pending batch preserves accessible motion behavior and locks the answer sheet", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);

  let releasePost!: () => void;
  let announcePostStarted!: () => void;
  let finishPostRoute!: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const postStarted = new Promise<void>((resolve) => {
    announcePostStarted = resolve;
  });
  const postHandled = new Promise<void>((resolve) => {
    finishPostRoute = resolve;
  });
  let hasPendingPost = false;
  await page.route("**/api/answers/batch**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { resultsVisible: false } });
      return;
    }

    hasPendingPost = true;
    announcePostStarted();
    try {
      await postGate;
      const body = route.request().postDataJSON() as BatchPayload;
      await route.fulfill({
        json: { submissionId: body.submissionId, revision: 1 },
      });
    } finally {
      finishPostRoute();
    }
  });

  try {
    await page.goto("/answer");
    await signIn(page, "Aki");
    await startQuiz(page);
    for (let id = 1; id <= 4; id += 1) await answerQuestion(page, id, "B");
    await page.getByRole("textbox", { name: "回答" }).fill("pending animation state");
    await page.getByRole("button", { name: "5問の回答を確定する" }).click();
    await postStarted;

    const submit = page.getByRole("button", { name: "回答を送信しています…" });
    const spinner = submit.locator('span[aria-hidden="true"]');
    const selectedChoice = page.getByRole("radio", { name: /Option 1B/ });
    const nextChoice = page.getByRole("radio", { name: /Option 2B/ });
    const assertPendingAnswerState = async () => {
      await expect(submit).toBeDisabled();
      await expect(submit).toContainText("回答を送信しています");
      await expect(selectedChoice).toBeChecked();
      await expect(selectedChoice).toBeDisabled();
      await expect(nextChoice).toBeDisabled();
    };

    await assertPendingAnswerState();
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveAttribute("aria-hidden", "true");
    await expect(spinner).toHaveCSS("width", "16px");
    await expect(spinner).toHaveCSS("height", "16px");
    await expect(spinner).toHaveCSS("border-top-width", "2px");
    await expect(spinner).toHaveCSS("border-right-width", "2px");
    await expect
      .poll(() =>
        spinner.evaluate((element) => {
          const style = getComputedStyle(element);
          return style.borderRightColor === style.color;
        }),
      )
      .toBe(true);
    await expect(spinner).toHaveCSS("animation-name", "spin");
    await expect(submit).toHaveCSS("transition-duration", "0.2s");
    await expect(selectedChoice.locator("xpath=ancestor::label")).toHaveCSS(
      "transition-duration",
      "0.2s",
    );
    await expectNoAccessibilityViolations(page, "pending answer batch");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await assertPendingAnswerState();
    await expect(spinner).toHaveCSS("animation-name", "none");
    await expect(submit).toHaveCSS("transition-duration", "0s");
    await expect(selectedChoice.locator("xpath=ancestor::label")).toHaveCSS(
      "transition-duration",
      "0s",
    );

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await assertPendingAnswerState();
    await expect(spinner).toHaveCSS("animation-name", "spin");
    await expect(submit).toHaveCSS("transition-duration", "0.2s");
    await expect(selectedChoice.locator("xpath=ancestor::label")).toHaveCSS(
      "transition-duration",
      "0.2s",
    );
  } finally {
    releasePost();
    if (hasPendingPost) await postHandled;
  }
});

test("@mobile supports native radio keyboard operation and reflows long Japanese text at 320px", async ({
  page,
}) => {
  // This sets a 320 CSS px viewport; browser zoom at 200% needs a real-browser check.
  await page.setViewportSize({ width: 320, height: 900 });
  await mockParticipantSession(page);
  await page.route("**/api/questions/batch", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        questions: [1, 2, 3, 4, 5].map((id) =>
          makeQuestion({
            id,
            question: longJapaneseQuestion,
            choices:
              id === 5
                ? []
                : [
                    "長文の選択肢Aです。".repeat(20),
                    noSpaceChoice,
                    emojiChoice,
                    longJapaneseChoice,
                  ],
            answerType: id === 5 ? "freeText" : "selected",
          }),
        ),
      }),
    });
  });

  await page.goto("/answer");
  await signIn(page);

  const group = page.locator("#question-1 fieldset");
  await expect(group).toBeVisible();
  const longOptionRadios = group.getByRole("radio");
  await expect(longOptionRadios).toHaveCount(4);
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(16);
  await expect(page.getByRole("textbox", { name: "回答" })).toBeVisible();
  const firstRadio = group.getByRole("radio", { name: /長文の選択肢Aです/ });
  await page.evaluate(() => document.fonts.ready);
  await expectCenteredHitTest(
    firstRadio.locator("xpath=ancestor::label"),
    "visible label for long-content first answer option at 320px",
  );
  const noSpaceOption = group.getByRole("radio", { name: /BoundaryWithoutSpaces1234567890/ });
  const emojiOption = group.getByRole("radio", { name: /🧪🌿🎓📚✨/ });
  await expect(noSpaceOption).toHaveAccessibleName(/[A-D]\.\s*BoundaryWithoutSpaces1234567890/);
  await expect(emojiOption).toHaveAccessibleName(/[A-D]\.\s*🧪🌿🎓📚✨/);
  await expect(firstRadio).toHaveAttribute("name", "answer-1");
  await expect(firstRadio).toHaveAccessibleName(/[A-D]\.\s*長文の選択肢Aです/);
  const firstRadioId = await firstRadio.getAttribute("id");
  expect(firstRadioId).toBeTruthy();
  await expect(page.locator(`label[for="${firstRadioId}"]`)).toHaveCount(1);
  const radioNames = await radios.evaluateAll((inputs) => [
    ...new Set(inputs.map((input) => (input as HTMLInputElement).name)),
  ]);
  expect(radioNames).toEqual(["answer-1", "answer-2", "answer-3", "answer-4"]);

  const navigation = page.getByRole("navigation", { name: "設問へ移動" });
  await expect(firstRadio).not.toBeChecked();
  const navControls = navigation.getByRole("link");
  for (let index = 0; index < 5; index += 1) {
    const box = await navControls.nth(index).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }

  await firstRadio.focus();
  await expect(firstRadio).toBeFocused();
  await expect(firstRadio).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(firstRadio).toBeChecked();
  await expect(navigation.getByRole("link", { name: "第1問へ移動、回答済み" })).toBeVisible();
  const firstRow = firstRadio.locator("xpath=..");
  const radioFocusRing = await firstRow.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(radioFocusRing).not.toBe("none");

  await expect(navigation.locator("xpath=ancestor::header")).toBeVisible();
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "設問へ移動" })).toHaveCount(1);
  await expect(navigation.getByRole("list").getByRole("listitem")).toHaveCount(5);
  await expect(navigation.locator("a, button, input")).toHaveCount(5);
  const targetHeading = page.locator("#question-5 h2");
  await navigation.getByRole("link", { name: "第5問へ移動、未回答" }).click();
  await expect(targetHeading).toBeFocused();
  const headingTop = await targetHeading.evaluate((heading) => heading.getBoundingClientRect().top);
  const stickyBottom = await page
    .locator("body > header")
    .evaluate((header) => header.getBoundingClientRect().bottom);
  expect(headingTop).toBeGreaterThanOrEqual(stickyBottom - 1);
  await expect(firstRadio).toBeChecked();

  const [rowBox, confirmBox] = await Promise.all([
    firstRow.boundingBox(),
    page.getByRole("button", { name: "未回答の設問に回答してください" }).boundingBox(),
  ]);
  expect(rowBox?.height).toBeGreaterThanOrEqual(44);
  expect(confirmBox?.height).toBeGreaterThanOrEqual(44);
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(Math.max(widths.document, widths.body)).toBeLessThanOrEqual(widths.viewport + 1);
});

test("@mobile reviews and edits an answer at 320px with a hittable review target", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 812 });
  await mockParticipantSession(page);
  await mockQuestions(page);
  await page.goto("/answer");
  await signIn(page, "Aki");
  await startQuiz(page);

  for (let id = 1; id <= 4; id += 1) await answerQuestion(page, id, "B");
  await page.getByRole("textbox", { name: "回答" }).fill("小画面で編集する回答です。");
  await page
    .getByRole("navigation", { name: "設問へ移動" })
    .getByRole("link", { name: "第5問へ移動、回答済み" })
    .click();
  await page.keyboard.press("End");

  const review = page.locator('ol[aria-label="回答内容"]');
  const reviewItems = review.getByRole("listitem");
  await expect(reviewItems).toHaveCount(5);
  const editQuestionThree = reviewItems
    .nth(2)
    .getByRole("button", { name: "第3問「Question 3?」を編集" });
  await editQuestionThree.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await expectCenteredHitTest(editQuestionThree, "question 3 edit action in the 320px review");
  await editQuestionThree.click();

  const selectedQuestionThree = page.locator('#question-3 input[type="radio"]:checked');
  await expect(selectedQuestionThree).toBeFocused();
  await selectRadio(page, /Option 3C/);
  await page
    .getByRole("navigation", { name: "設問へ移動" })
    .getByRole("link", { name: "第5問へ移動、回答済み" })
    .click();
  await page.keyboard.press("End");
  await expect(reviewItems.nth(2)).toContainText("Option 3C");

  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(Math.max(widths.document, widths.body)).toBeLessThanOrEqual(widths.viewport + 1);
});

test("@chromium returns to owner completion after an assisted save and opens target correction directly", async ({
  page,
}) => {
  const requestTrace = captureApiRequests(page);
  const questions: SavedBatchAnswer[] = [
    { questionId: 1, answerKind: "selected", selectedIndex: 0, freeText: null },
    { questionId: 2, answerKind: "selected", selectedIndex: 0, freeText: null },
    { questionId: 3, answerKind: "selected", selectedIndex: 0, freeText: null },
    { questionId: 4, answerKind: "selected", selectedIndex: 0, freeText: null },
    { questionId: 5, answerKind: "freeText", selectedIndex: null, freeText: "本人の回答" },
  ];
  let assistedName: string | null = null;
  let assistedSubmission: {
    submissionId: string;
    revision: number;
    answers: SavedBatchAnswer[];
  } | null = null;
  const assistedLatestRequests: string[] = [];
  const assistedSaves: BatchPayload[] = [];
  const ownerSubmissions: Array<{ submissionId: string; revision: number }> = [];

  await page.route("**/api/participants/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ participant: { id: 17, name: "本人" } }),
    });
  });
  await page.route("**/api/participants/results", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "waiting" }),
    });
  });
  await page.route("**/api/participants/assisted", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          participant: assistedName ? { id: 18, name: assistedName } : null,
          hasSubmission: Boolean(assistedSubmission),
          eligible: !assistedName,
        }),
      });
      return;
    }
    const body = route.request().postDataJSON();
    expect(Object.keys(body)).toEqual(["name"]);
    assistedName = body.name;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ participant: { id: 18, name: assistedName }, hasSubmission: false }),
    });
  });
  await page.route("**/api/questions/batch**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ questions: [1, 2, 3, 4, 5].map(questionFor) }),
    });
  });
  await page.route("**/api/answers/latest**", async (route) => {
    const url = new URL(route.request().url());
    assistedLatestRequests.push(url.search);
    const assisted = url.searchParams.get("scope") === "assisted";
    const ownerSubmission = {
      submissionId: "00000000-0000-4000-8000-000000000041",
      revision: 1,
      answers: questions,
    };
    if (!assisted) {
      ownerSubmissions.push({
        submissionId: ownerSubmission.submissionId,
        revision: ownerSubmission.revision,
      });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        submission: assisted ? assistedSubmission : ownerSubmission,
      }),
    });
  });
  await page.route("**/api/answers/batch**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ resultsVisible: false }),
      });
      return;
    }

    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() as BatchPayload;
    expect(url.searchParams.get("scope")).toBe("assisted");
    assistedSaves.push(body);
    assistedSubmission = {
      submissionId: body.submissionId,
      revision: body.expectedRevision + 1,
      answers: body.answers.map((answer) =>
        "freeText" in answer
          ? {
              questionId: answer.questionId,
              answerKind: "freeText",
              selectedIndex: null,
              freeText: answer.freeText,
            }
          : {
              questionId: answer.questionId,
              answerKind: "selected",
              selectedIndex: answer.selectedIndex,
              freeText: null,
            },
      ),
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        submissionId: body.submissionId,
        revision: body.expectedRevision + 1,
      }),
    });
  });

  await page.goto("/answer");
  await expectResultsWaiting(page);
  await expect(page.getByRole("button", { name: "代理回答を行う" })).toBeVisible();
  await page.getByRole("button", { name: "代理回答を行う" }).click();
  await expect(page.getByRole("heading", { name: "代理回答" })).toBeVisible();
  await page.getByLabel("本来回答する人のお名前").fill("代理回答者");
  await page.getByRole("button", { name: "回答をはじめる" }).click();
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  await expect.poll(() => assistedLatestRequests).toContain("?scope=assisted");
  const assistedIdentityPost = requestIndex(requestTrace, "POST", "/api/participants/assisted");
  const assistedLatest = requestIndex(requestTrace, "GET", "/api/answers/latest?scope=assisted");
  const questionsLoaded = requestIndex(
    requestTrace,
    "GET",
    "/api/questions/batch",
    assistedIdentityPost + 1,
  );
  expect(assistedIdentityPost).toBeGreaterThanOrEqual(0);
  expect(assistedLatest).toBeGreaterThan(assistedIdentityPost);
  expect(questionsLoaded).toBeGreaterThan(assistedIdentityPost);

  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "B");
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();
  // Saving an assisted answer returns directly to the owner's completion view.
  await expectResultsWaiting(page);
  await expect(page.getByRole("definition")).toHaveText("本人");
  await expect(page.getByText("本人の回答", { exact: true })).toHaveCount(0);
  await expect(page.getByText("代理回答者", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "代理回答を修正する" })).toBeVisible();
  expect(assistedSaves).toHaveLength(1);
  const assistedSave = requestIndex(requestTrace, "POST", "/api/answers/batch?scope=assisted");
  expect(assistedSave).toBeGreaterThan(assistedLatest);

  await page.getByRole("button", { name: "代理回答を修正する" }).click();
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: /Option 1B/ })).toBeChecked();
  const assistedRequestsBeforeReload = assistedLatestRequests.filter(
    (search) => search === "?scope=assisted",
  ).length;
  const ownerRequestsBeforeReload = assistedLatestRequests.filter((search) => search === "").length;
  await page.reload();
  await expectResultsWaiting(page);
  await expect(page.getByRole("definition")).toHaveText("本人");
  await expect(page.getByText("本人の回答", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "代理回答を修正する" })).toBeVisible();
  await expect
    .poll(() => assistedLatestRequests.filter((search) => search === "").length)
    .toBeGreaterThan(ownerRequestsBeforeReload);
  expect(assistedLatestRequests.filter((search) => search === "?scope=assisted").length).toBe(
    assistedRequestsBeforeReload + 1,
  );
  expect(assistedSaves).toHaveLength(1);

  await page.getByRole("button", { name: "代理回答を修正する" }).click();
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: /Option 1B/ })).toBeChecked();
  await answerQuestion(page, 1, "C");
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expectResultsWaiting(page);
  await expect(page.getByRole("definition")).toHaveText("本人");
  await expect(page.getByText("本人の回答", { exact: true })).toHaveCount(0);
  await expect(page.getByText("代理回答者", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "代理回答を修正する" })).toBeVisible();
  expect(assistedSaves).toHaveLength(2);
  expect(assistedSaves[1]).toMatchObject({
    submissionId: assistedSaves[0]?.submissionId,
    expectedRevision: 1,
  });
  expect(assistedSubmission).toMatchObject({
    submissionId: assistedSaves[0]?.submissionId,
    revision: 2,
  });
  expect(ownerSubmissions.length).toBeGreaterThan(0);
  expect(ownerSubmissions.at(-1)).toEqual(ownerSubmissions[0]);
  expect(ownerSubmissions[0]).toEqual({
    submissionId: "00000000-0000-4000-8000-000000000041",
    revision: 1,
  });

  await page.getByRole("button", { name: "回答を修正する", exact: true }).click();
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: /Option 1A/ })).toBeChecked();
});

test("@chromium keeps a stale second-tab draft distinct from the canonical submission after a 409", async ({
  page,
}) => {
  const secondTab = await page.context().newPage();
  const submissionId = "00000000-0000-4000-8000-000000000044";
  const revisionOneAnswers: SavedBatchAnswer[] = [
    ...[1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: 0,
      freeText: null,
    })),
    {
      questionId: 5,
      answerKind: "freeText",
      selectedIndex: null,
      freeText: "保存済み revision 1",
    },
  ];
  await mockParticipantSession(page, "Shared Participant", {
    submissionId,
    revision: 1,
    answers: revisionOneAnswers,
  });
  await mockParticipantSession(secondTab, "Shared Participant", {
    submissionId,
    revision: 1,
    answers: revisionOneAnswers,
  });
  await mockQuestions(page);
  await mockQuestions(secondTab);

  // Both tabs share this deterministic API state; this exercises the client
  // conflict recovery, not a real database concurrency scenario.
  const writes: BatchPayload[] = [];
  let visibilityReads = 0;
  const canonicalReads: { revision: number; answers: SavedBatchAnswer[] }[] = [];
  let conflictReturned = false;
  let canonical = {
    submissionId,
    revision: 1,
    answers: revisionOneAnswers,
  };
  const handleBatchRoute = async (route: Route) => {
    if (route.request().method() === "GET") {
      visibilityReads += 1;
      if (conflictReturned && canonicalReads.length === 0) {
        canonicalReads.push({ revision: canonical.revision, answers: canonical.answers });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ resultsVisible: false, ...canonical }),
      });
      return;
    }

    const body = route.request().postDataJSON() as BatchPayload;
    writes.push(body);
    if (
      body.submissionId === canonical.submissionId &&
      body.expectedRevision === canonical.revision
    ) {
      canonical = {
        submissionId,
        revision: canonical.revision + 1,
        answers: body.answers.map((answer) =>
          "freeText" in answer
            ? { ...answer, answerKind: "freeText" as const, selectedIndex: null }
            : { ...answer, answerKind: "selected" as const, freeText: null },
        ),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ submissionId, revision: canonical.revision }),
      });
      return;
    }

    conflictReturned = true;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ message: "Revision conflict" }),
    });
  };
  await page.route("**/api/answers/batch**", handleBatchRoute);
  await secondTab.route("**/api/answers/batch**", handleBatchRoute);

  await page.goto("/answer");
  await secondTab.goto("/answer");
  await expectResultsWaiting(page);
  await expectResultsWaiting(secondTab);

  await page.getByRole("button", { name: "回答を修正する" }).click();
  await secondTab.getByRole("button", { name: "回答を修正する" }).click();
  expect(visibilityReads).toBeGreaterThan(0);
  expect(canonicalReads).toHaveLength(0);

  await answerQuestion(secondTab, 1, "D");
  await secondTab.getByRole("textbox", { name: "回答" }).fill("Bタブの未保存案");
  await answerQuestion(page, 1, "B");
  await page.getByRole("textbox", { name: "回答" }).fill("Aタブで保存した回答");
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expectResultsWaiting(page);
  expect(canonical.revision).toBe(2);

  await secondTab.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(
    secondTab.getByRole("alert").filter({ hasText: "保存済み回答が更新されています。" }),
  ).toContainText("回答案は保持しています。内容を確認して、もう一度確定してください。");
  expect(canonicalReads).toEqual([{ revision: 2, answers: canonical.answers }]);
  await expect(secondTab.getByRole("radio", { name: /Option 1D/ })).toBeChecked();
  await expect(secondTab.getByRole("textbox", { name: "回答" })).toHaveValue("Bタブの未保存案");

  const savedQuestionOne = canonical.answers.find((answer) => answer.questionId === 1);
  const localQuestionOne = writes[1]?.answers.find((answer) => answer.questionId === 1);
  const savedQuestionFive = canonical.answers.find((answer) => answer.questionId === 5);
  const localQuestionFive = writes[1]?.answers.find((answer) => answer.questionId === 5);
  expect(savedQuestionOne).toMatchObject({ answerKind: "selected" });
  expect(localQuestionOne).toHaveProperty("selectedIndex");
  if (!savedQuestionOne || !localQuestionOne || !savedQuestionFive || !localQuestionFive) {
    throw new Error("Expected saved and local answers for questions 1 and 5");
  }
  if (
    savedQuestionOne.answerKind !== "selected" ||
    !("selectedIndex" in localQuestionOne) ||
    savedQuestionFive.answerKind !== "freeText" ||
    !("freeText" in localQuestionFive)
  ) {
    throw new Error("Expected matching answer kinds for the saved and local drafts");
  }
  expect(localQuestionOne.selectedIndex).not.toBe(savedQuestionOne.selectedIndex);
  expect(localQuestionFive.freeText).not.toBe(savedQuestionFive.freeText);
  expect(canonicalReads).toHaveLength(1);
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ submissionId, expectedRevision: 1 });
  expect(writes[1]).toMatchObject({ submissionId, expectedRevision: 1 });
});
