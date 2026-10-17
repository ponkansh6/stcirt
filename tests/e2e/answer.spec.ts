import { test, expect, type Locator, type Page, type Route, type TestInfo } from "./fixtures/test";
import { makeQuestion } from "../fixtures/question";
import { expectNoAccessibilityViolations } from "./axe";
import { expectPrimaryTargetGeometry } from "./target-geometry";

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
const longReviewAnswer = "自由記述の全文を確認できるようにします。\n次の行も表示します。".repeat(
  14,
);

test("answer login controls meet the selected target geometry at representative widths", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  await page.goto("/answer");

  const participantName = page.getByRole("textbox", { name: "受験者氏名" });
  const pin = page.getByRole("textbox", { name: "受験コード" });
  const submit = page.getByRole("button", { name: "はじめる" });

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrimaryTargetGeometry(participantName, `answer participant name at ${width}px`);
    await expectPrimaryTargetGeometry(pin, `answer PIN at ${width}px`);
    await expectPrimaryTargetGeometry(submit, `answer login submit at ${width}px`);
  }
});

test("disables the answer glass header for stronger contrast and reduced transparency", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Reduced transparency emulation uses Chromium CDP.");
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

async function expectNoPageHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(Math.max(widths.document, widths.body)).toBeLessThanOrEqual(widths.viewport + 1);
}

async function answerQuestion(page: Page, id: number, choice: string) {
  if (id === 5) {
    await page.getByRole("textbox", { name: "回答（1000字以内）" }).fill(`自由記載${choice}`);
  } else {
    await selectRadio(page, new RegExp(`Option ${id}${choice}`));
  }
}

test("direct answer access requires name and four digit PIN before loading the quiz", async ({
  page,
}) => {
  const requestTrace = captureApiRequests(page);
  const { loginRequests } = await mockParticipantSession(page);
  const requests: string[] = [];
  await mockQuestions(page, requests);

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "参加して検定を受ける" })).toBeVisible();
  const sharedHeader = page.locator("body > header");
  await expect(sharedHeader.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await expect(page.getByLabel("受験コード")).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByLabel("受験コード")).toHaveAttribute("pattern", "[0-9]{4}");
  await expectNoAccessibilityViolations(page, "answer login form");
  await signIn(page, "Aki", "0123");

  expect(loginRequests).toEqual([{ name: "Aki", pin: "0123" }]);
  expect(requests).toEqual(["/api/questions/batch"]);
  const initialSession = requestIndex(requestTrace, "GET", "/api/participants/session");
  const login = requestIndex(requestTrace, "POST", "/api/participants/session");
  const latest = requestIndex(requestTrace, "GET", "/api/answers/latest");
  const questionBatch = requestIndex(requestTrace, "GET", "/api/questions/batch");
  expect(initialSession).toBeGreaterThanOrEqual(0);
  expect(login).toBeGreaterThan(initialSession);
  expect(latest).toBeGreaterThan(login);
  expect(questionBatch).toBeGreaterThan(latest);
  await startQuiz(page);
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  expect(requests).toEqual(["/api/questions/batch"]);
});

test("participant login follows name, PIN, and submit Tab order and submits once with Enter", async ({
  page,
}) => {
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
});

test("keeps DOM focus unchanged while checking whether a submission exists", async ({ page }) => {
  await mockParticipantSession(page);
  await mockQuestions(page);

  let releaseLatestResponse!: () => void;
  const latestResponseGate = new Promise<void>((resolve) => {
    releaseLatestResponse = resolve;
  });
  await page.route("**/api/answers/latest", async (route) => {
    await latestResponseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submission: null }),
    });
  });

  await page.goto("/answer");
  await page.getByLabel("受験者氏名").fill("Aki");
  await page.getByLabel("受験コード").fill("0123");
  await page.getByRole("button", { name: "はじめる" }).click();

  const checkingStatus = page.getByRole("status");
  await expect(checkingStatus).toBeVisible();
  await expect(checkingStatus).toHaveText("保存済みの回答状況を確認しています…");
  await expect(checkingStatus).toHaveAttribute("aria-live", "polite");
  const focusedElementBeforeRelease = await page.evaluateHandle(() => document.activeElement);

  releaseLatestResponse();

  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (focusedElement) => document.activeElement === focusedElement,
      focusedElementBeforeRelease,
    ),
  ).toBe(true);
});

test("direct answer access refuses an incomplete question batch", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockParticipantSession(page);
  await page.route("**/api/questions/batch", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ questions: [questionFor(1)] }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "問題を読み込めませんでした" })).toBeVisible();
  const retry = page.getByRole("button", { name: "もう一度読み込む" });
  await expect(retry).toBeVisible();
  await expect(page.getByText("通信状態を確認して、もう一度お試しください。")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectCenteredHitTest(retry, "answer load-error retry");
  await expectNoPageHorizontalOverflow(page);
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await expectNoAccessibilityViolations(page, "incomplete question batch error");
});

test("keeps choices local, blocks an incomplete batch, then confirms all five with the participant cookie", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const submitted: Array<{ body: BatchPayload; cookie: string | undefined }> = [];
  await page.route("**/api/answers/batch", async (route) => {
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

  await page.goto("/answer");
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

test("reviews all five current answers on mobile and edits a question from the summary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockParticipantSession(page);
  await mockQuestions(page);
  await page.goto("/answer");
  await signIn(page, "Aki");
  await startQuiz(page);

  const selectedChoices = ["C", "A", "D", "B"];
  await expectNoAccessibilityViolations(page, "answer question form");
  for (let index = 0; index < selectedChoices.length; index += 1) {
    await answerQuestion(page, index + 1, selectedChoices[index]!);
  }
  const longFreeText = longReviewAnswer;
  expect(Array.from(longFreeText).length).toBeGreaterThan(180);
  await page.getByRole("textbox", { name: "回答（1000字以内）" }).fill(longFreeText);

  const participantName = page.locator("dt").filter({ hasText: "氏名" });
  await expect(participantName).toHaveText("氏名");
  await expect(participantName.locator("xpath=following-sibling::dd")).toHaveText("Aki");
  const answerTarget = page.locator("dt").filter({ hasText: "回答先" });
  await expect(answerTarget.locator("xpath=following-sibling::dd")).toHaveText(
    "Akiさん（本人の回答）",
  );

  const review = page.locator('ol[aria-label="回答内容"]');
  const reviewItems = review.getByRole("listitem");
  await expect(reviewItems).toHaveCount(5);
  await expect(reviewItems.locator("h3")).toHaveText([
    "Question 1?",
    "Question 2?",
    "Question 3?",
    "Question 4?",
    "Question 5?",
  ]);
  for (let index = 0; index < selectedChoices.length; index += 1) {
    await expect(reviewItems.nth(index)).toContainText(
      `Option ${index + 1}${selectedChoices[index]}`,
    );
  }
  await expect(reviewItems.nth(4)).toContainText(longFreeText.slice(0, 180));
  await expect(reviewItems.nth(4)).toContainText("…");
  await expectNoAccessibilityViolations(page, "answer review summary");

  const details = reviewItems.nth(4).locator("details");
  const summary = details.locator("summary");
  await expect(details).toHaveCount(1);
  await expect(summary).toHaveText(`全文を表示（${Array.from(longFreeText).length}文字）`);
  await expect(details).not.toHaveAttribute("open");
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(details.getByText(longFreeText, { exact: true })).toBeVisible();

  const questionThreeEdit = reviewItems
    .nth(2)
    .getByRole("button", { name: "第3問「Question 3?」を編集" });
  await questionThreeEdit.click();
  const selectedQuestionThree = page.locator('#question-3 input[type="radio"]:checked');
  await expect(selectedQuestionThree).toHaveCount(1);
  await expect(selectedQuestionThree).toBeFocused();

  await selectRadio(page, /Option 3C/);
  await page
    .getByRole("navigation", { name: "設問へ移動" })
    .getByRole("link", { name: "第5問へ移動、回答済み" })
    .click();
  await page.keyboard.press("End");
  await expect(page.getByRole("heading", { name: "回答内容を確認してください" })).toBeVisible();
  await expect(reviewItems.nth(2)).toContainText("Option 3C");
  await expect(reviewItems.nth(4)).toContainText(longFreeText.slice(0, 180));
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) {
    await summary.focus();
    await page.keyboard.press("Enter");
  }
  await expect(details).toHaveAttribute("open", "");
  await expect(details.getByText(longFreeText, { exact: true })).toBeVisible();
});

async function runAnswerFlowProxyAtWidth(page: Page, testInfo: TestInfo, width: number) {
  const viewport = { width, height: 812 };
  await page.setViewportSize(viewport);
  expect(page.viewportSize()).toEqual(viewport);
  await mockParticipantSession(page);
  const questionRequests: string[] = [];
  await mockQuestions(page, questionRequests);
  const submitted: BatchPayload[] = [];
  await page.route("**/api/answers/batch", async (route) => {
    submitted.push(route.request().postDataJSON() as BatchPayload);
    const body = submitted.at(-1)!;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
    });
  });

  // Count deliberate in-quiz browser interactions; sign-in is fixture setup.
  let operationCount = 0;
  const act = async (operation: () => Promise<unknown>) => {
    operationCount += 1;
    await operation();
  };
  const scrollCheckpoints: Array<{ name: string; scrollY: number; documentHeight: number }> = [];
  const recordScroll = async (name: string) => {
    const measurement = await page.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      documentHeight: document.documentElement.scrollHeight,
    }));
    scrollCheckpoints.push({ name, ...measurement });
  };
  const expectInViewport = async (locator: Locator) => {
    await expect(locator).toBeVisible();
    const bounds = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: document.documentElement.clientWidth,
        height: window.innerHeight,
      };
    });
    expect(bounds.right).toBeGreaterThan(0);
    expect(bounds.left).toBeLessThan(bounds.width);
    expect(bounds.bottom).toBeGreaterThan(0);
    expect(bounds.top).toBeLessThan(bounds.height);
  };
  const expectNoHorizontalOverflow = async () => {
    const widths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(Math.max(widths.document, widths.body)).toBeLessThanOrEqual(widths.viewport + 1);
  };

  await page.goto("/answer");
  await page.evaluate(() => document.fonts.ready);
  await signIn(page, "Aki");
  await startQuiz(page);
  await page.evaluate(() => document.fonts.ready);
  await recordScroll("question-1-start");

  await act(() => answerQuestion(page, 2, "B"));
  await act(() => answerQuestion(page, 3, "C"));
  await act(() => answerQuestion(page, 4, "D"));
  const longFreeText = longReviewAnswer;
  await act(() => page.getByRole("textbox", { name: "回答（1000字以内）" }).fill(longFreeText));
  await act(() =>
    page
      .getByRole("navigation", { name: "設問へ移動" })
      .getByRole("link", { name: "第5問へ移動、回答済み" })
      .click(),
  );
  await act(() => page.keyboard.press("End"));

  const unansweredLink = page.getByRole("button", { name: "第1問へ" });
  await expect(unansweredLink).toBeVisible();
  const unansweredGuidance = page.getByText("未回答の設問へ移動できます：");
  const disabledSubmit = page.getByRole("button", { name: "未回答の設問に回答してください" });
  await expect(disabledSubmit).toBeDisabled();
  await page.evaluate(() => document.fonts.ready);
  await act(() => unansweredGuidance.scrollIntoViewIfNeeded());
  await expectInViewport(unansweredGuidance);
  await expectInViewport(unansweredLink);
  await expectCenteredHitTest(unansweredLink, `unanswered question link at ${width}px`);
  await recordScroll("unanswered-guidance-visible");
  await act(() => disabledSubmit.scrollIntoViewIfNeeded());
  await expectInViewport(disabledSubmit);
  await expectCenteredHitTest(disabledSubmit, `incomplete submit at ${width}px`);
  await recordScroll("incomplete-primary-action-visible");
  await expectNoHorizontalOverflow();
  await act(() => unansweredLink.click());
  await act(() => answerQuestion(page, 1, "A"));
  await act(() =>
    page
      .getByRole("navigation", { name: "設問へ移動" })
      .getByRole("link", { name: "第5問へ移動、回答済み" })
      .click(),
  );
  await act(() => page.keyboard.press("End"));
  await page.evaluate(() => document.fonts.ready);
  await recordScroll("all-five-answered-review");

  const review = page.locator('ol[aria-label="回答内容"]');
  const reviewItems = review.getByRole("listitem");
  await expect(reviewItems).toHaveCount(5);
  await expect(reviewItems.nth(4)).toContainText(longFreeText.slice(0, 180));
  await expect(reviewItems.nth(4)).toContainText("…");
  const details = reviewItems.nth(4).locator("details");
  const summary = details.locator("summary");
  await expect(summary).toHaveText(`全文を表示（${Array.from(longFreeText).length}文字）`);
  await act(() => summary.click());
  await expect(details.getByText(longFreeText, { exact: true })).toBeVisible();

  await act(() =>
    reviewItems.nth(2).getByRole("button", { name: "第3問「Question 3?」を編集" }).click(),
  );
  await act(() => selectRadio(page, /Option 3A/));
  await act(() =>
    page
      .getByRole("navigation", { name: "設問へ移動" })
      .getByRole("link", { name: "第5問へ移動、回答済み" })
      .click(),
  );
  await act(() => page.keyboard.press("End"));
  await page.evaluate(() => document.fonts.ready);
  await expect(reviewItems.nth(2)).toContainText("Option 3A");
  await expect(details.getByText(longFreeText, { exact: true })).toBeVisible();
  await recordScroll("review-after-edit");
  await expectNoHorizontalOverflow();

  const submit = page.getByRole("button", { name: "5問の回答を確定する" });
  await act(() => submit.scrollIntoViewIfNeeded());
  await page.evaluate(() => document.fonts.ready);
  await expectInViewport(submit);
  await expectCenteredHitTest(submit, `final submit at ${width}px`);
  await recordScroll("final-primary-action-visible");
  await act(() => submit.click());
  await expectResultsWaiting(page);
  const maxObservedScrollY = Math.max(...scrollCheckpoints.map(({ scrollY }) => scrollY));
  await testInfo.attach(`answer-flow-${width}px-scroll-proxy`, {
    body: JSON.stringify(
      {
        definition:
          "Maximum window.scrollY sampled at named in-quiz checkpoints; not user-session scroll analytics.",
        viewport,
        browserProject: testInfo.project.name,
        maxObservedScrollY,
        checkpoints: scrollCheckpoints,
        inQuizOperationCount: operationCount,
        expectedInQuizOperationCount: 19,
        operationCountMatchesExpected: operationCount === 19,
        questionBatchFetchCount: questionRequests.length,
        answerBatchSubmitCount: submitted.length,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(operationCount).toBe(19);
  expect(questionRequests).toEqual(["/api/questions/batch"]);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    expectedRevision: 0,
    answers: [
      { questionId: 1, selectedIndex: 0 },
      { questionId: 2, selectedIndex: 1 },
      { questionId: 3, selectedIndex: 0 },
      { questionId: 4, selectedIndex: 3 },
      { questionId: 5, freeText: longFreeText },
    ],
  });
}

for (const width of [320, 375, 768, 1280]) {
  test(`records the ${width}×812 incomplete-answer recovery, review edit, and single submission flow`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "Mobile Chrome" && width !== 375,
      "The width matrix runs in Desktop Chromium; Mobile Chrome retains its 375px run.",
    );
    await runAnswerFlowProxyAtWidth(page, testInfo, width);
  });
}

test("locks the full answer sheet while its batch request is pending", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockParticipantSession(page);
  await mockQuestions(page);

  let answerCalls = 0;
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  let releaseAnswer!: () => void;
  const answerGate = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  await page.route("**/api/answers/batch", async (route) => {
    const body = route.request().postDataJSON() as BatchPayload;
    answerCalls += 1;
    markRequestStarted();
    await answerGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
    });
  });

  await page.goto("/answer");
  await page.evaluate(() => document.fonts.ready);
  await signIn(page);
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "B");
  const confirm = page.getByRole("button", { name: "5問の回答を確定する" });
  await confirm.click();
  await requestStarted;

  const submittingButton = page.getByRole("button", { name: "回答を送信しています…" });
  await expect(page.getByRole("heading", { name: "回答内容を確認してください" })).toBeFocused();
  await expect(submittingButton).toHaveAttribute("aria-disabled", "true");
  await expect(submittingButton).toHaveAccessibleName("回答を送信しています…");
  await expect(submittingButton).toHaveAttribute("disabled", "");
  await expect(submittingButton).not.toHaveAttribute("aria-busy");
  const submittingStatus = page.getByRole("status").filter({
    hasText: "回答を送信しています…",
  });
  await expect(submittingStatus).toContainText("回答を送信しています…");
  await expect(submittingStatus).toContainText(
    "送信が完了するまで、回答の変更や再送はできません。",
  );
  const selectedAnswer = page.getByRole("radio", { name: /Option 1B/ });
  const choiceButton = selectedAnswer.locator("xpath=..");
  await expect(selectedAnswer).toBeChecked();
  await expect(selectedAnswer).toBeDisabled();
  await expectNoAccessibilityViolations(page, "pending answer batch");
  const spinner = submittingButton.locator('[aria-hidden="true"]');
  await expect(spinner).toHaveCSS("animation-name", "spin");
  await expect(submittingButton).toHaveCSS("transition-duration", "0.2s");
  await expect(choiceButton).toHaveCSS("transition-duration", "0.2s");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(spinner).toHaveCSS("animation-name", "none");
  await expect(submittingButton).toHaveCSS("transition-duration", "0s");
  await expect(choiceButton).toHaveCSS("transition-duration", "0s");
  await expect(selectedAnswer).toBeChecked();
  await expect(selectedAnswer).toBeDisabled();
  await expect(submittingButton).toHaveAttribute("disabled", "");
  await expect(submittingButton).toHaveAccessibleName("回答を送信しています…");
  await expect(submittingStatus).toContainText("回答を送信しています…");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(spinner).toHaveCSS("animation-name", "spin");
  await expect(submittingButton).toHaveCSS("transition-duration", "0.2s");
  await expect(choiceButton).toHaveCSS("transition-duration", "0.2s");
  await expect(selectedAnswer).toBeChecked();
  await expect(selectedAnswer).toBeDisabled();
  await expect(submittingButton).toHaveAttribute("disabled", "");
  await expect(submittingButton).toHaveAccessibleName("回答を送信しています…");
  await expect(submittingStatus).toContainText("回答を送信しています…");
  await submittingButton.evaluate((button: HTMLButtonElement) => button.click());
  expect(answerCalls).toBe(1);

  releaseAnswer();
  await expectResultsWaiting(page);
});

test("supports native radio keyboard operation and reflows long Japanese text at 320px", async ({
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
  await expect(page.getByRole("textbox", { name: "回答（1000字以内）" })).toBeVisible();
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

test("returns to owner completion after an assisted save and opens target correction directly", async ({
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
  await expect(page.getByRole("heading", { name: "ほかの人の回答" })).toBeVisible();
  await page.getByLabel("回答する人のお名前").fill("代理回答者");
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

test("shows neutral completion after one batch and can reopen the same answer set for correction", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const submissions: BatchPayload[] = [];
  await page.route("**/api/answers/batch", async (route) => {
    const request = route.request().postDataJSON() as BatchPayload;
    submissions.push(request);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        submissionId: request.submissionId,
        revision: submissions.length,
      }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "A");
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();

  await expectResultsWaiting(page);
  await expect(page.getByRole("button", { name: "回答を修正する" })).toBeVisible();
  await expect(page.getByText(/正解！|不正解|解説:|正答率|合格|得点/)).toHaveCount(0);
  expect(submissions).toHaveLength(1);
  await page.getByRole("button", { name: "回答を修正する" }).click();
  await expect(page.getByRole("button", { name: "修正内容を確定する" })).toBeEnabled();
  expect(await page.getByRole("radio", { name: /Option 1A/ }).isChecked()).toBe(true);
});

test("revisits a saved submission, restores it, and posts a correction to the same revisioned submission", async ({
  page,
}) => {
  const requestTrace = captureApiRequests(page);
  const submissionId = "00000000-0000-4000-8000-000000000023";
  const savedAnswers: SavedBatchAnswer[] = [
    ...[1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: questionId - 1,
      freeText: null,
    })),
    {
      questionId: 5,
      answerKind: "freeText",
      selectedIndex: null,
      freeText: "保存済みの回答です。",
    },
  ];
  await mockParticipantSession(page, "Returning Participant", {
    submissionId,
    revision: 2,
    answers: savedAnswers,
  });
  await mockQuestions(page);
  const updates: BatchPayload[] = [];
  await page.route("**/api/answers/batch", async (route) => {
    updates.push(route.request().postDataJSON() as BatchPayload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId, revision: 3 }),
    });
  });

  await page.goto("/answer");
  await expectResultsWaiting(page);
  const edit = page.getByRole("button", { name: "回答を修正する" });
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(page.locator("#question-1 input[type=radio]:checked")).toHaveCount(1);
  const response = page.getByRole("textbox", { name: "回答（1000字以内）" });
  await expect(response).toHaveValue("保存済みの回答です。");

  await answerQuestion(page, 1, "B");
  await response.fill("修正後の回答です。");
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expectResultsWaiting(page);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    submissionId,
    expectedRevision: 2,
  });
  expect(updates[0]?.answers.find((answer) => answer.questionId === 2)).toMatchObject({
    questionId: 2,
    selectedIndex: 1,
  });
  expect(updates[0]?.answers.find((answer) => answer.questionId === 5)).toEqual({
    questionId: 5,
    freeText: "修正後の回答です。",
  });
  const latest = requestIndex(requestTrace, "GET", "/api/answers/latest");
  const questionsLoaded = requestIndex(requestTrace, "GET", "/api/questions/batch");
  const correction = requestIndex(requestTrace, "POST", "/api/answers/batch");
  expect(latest).toBeGreaterThanOrEqual(0);
  expect(questionsLoaded).toBeGreaterThan(latest);
  expect(correction).toBeGreaterThan(questionsLoaded);
});

test("restores the latest saved answers after a same-participant re-login on correction 401", async ({
  page,
}) => {
  const requestTrace = captureApiRequests(page);
  const initialSubmissionId = "00000000-0000-4000-8000-000000000031";
  const latestSubmissionId = initialSubmissionId;
  const savedAnswers = (questionOneIndex: number, freeText: string): SavedBatchAnswer[] => [
    ...[1, 2, 3, 4].map((questionId) => ({
      questionId,
      answerKind: "selected" as const,
      selectedIndex: questionId === 1 ? questionOneIndex : questionId - 1,
      freeText: null,
    })),
    {
      questionId: 5,
      answerKind: "freeText" as const,
      selectedIndex: null,
      freeText,
    },
  ];
  const session = await mockParticipantSession(page, "Returning Participant", {
    submissionId: initialSubmissionId,
    revision: 2,
    answers: savedAnswers(0, "確認済みの保存回答です。"),
  });
  await mockQuestions(page);
  let answerCalls = 0;
  const posts: BatchPayload[] = [];
  await page.route("**/api/answers/batch**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          submissionId: latestSubmissionId,
          revision: 3,
          answers: savedAnswers(2, "再認証後の保存回答です。"),
        }),
      });
      return;
    }

    answerCalls += 1;
    posts.push(route.request().postDataJSON() as BatchPayload);
    session.setLatestSubmission({
      submissionId: latestSubmissionId,
      revision: 3,
      answers: savedAnswers(2, "再認証後の保存回答です。"),
    });
    if (answerCalls > 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ submissionId: latestSubmissionId, revision: 4 }),
      });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Authentication required" }),
    });
  });

  await page.goto("/answer");
  await expectResultsWaiting(page);
  await page.getByRole("button", { name: "回答を修正する" }).click();
  await answerQuestion(page, 1, "B");
  await page
    .getByRole("textbox", { name: "回答（1000字以内）" })
    .fill("送信に失敗した未保存の回答。");
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(page.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "回答（1000字以内）" })).toHaveValue(
    "送信に失敗した未保存の回答。",
  );

  await page.getByLabel("4桁PIN").fill("0123");
  await page.getByRole("button", { name: "再ログインする" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "保存済み回答の再確認が必要です" }),
  ).toBeVisible();
  expect(session.loginRequests).toEqual([{ name: "Returning Participant", pin: "0123" }]);
  expect(answerCalls).toBe(1);
  const recheck = page.getByRole("button", { name: "保存済み回答を再確認する" });
  await expect(recheck).toBeEnabled();
  await expect(page.locator("#question-1 input[type=radio]:checked")).toHaveCount(1);
  await expect(page.getByRole("radio", { name: /Option 1B/ })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "回答（1000字以内）" })).toHaveValue(
    "送信に失敗した未保存の回答。",
  );
  expect(answerCalls).toBe(1);

  await recheck.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "保存済み回答の再確認が必要です" }),
  ).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Option 1B/ })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "回答（1000字以内）" })).toHaveValue(
    "送信に失敗した未保存の回答。",
  );
  expect(answerCalls).toBe(1);

  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expectResultsWaiting(page);
  expect(posts[1]).toMatchObject({ submissionId: initialSubmissionId, expectedRevision: 3 });
  expect(posts[1]?.answers.find((answer) => answer.questionId === 1)).toEqual({
    questionId: 1,
    selectedIndex: 1,
  });
  expect(posts[1]?.answers.find((answer) => answer.questionId === 5)).toEqual({
    questionId: 5,
    freeText: "送信に失敗した未保存の回答。",
  });
  const correctionAttempts = requestTrace
    .map((request, index) => ({ request, index }))
    .filter(
      ({ request }) =>
        request.method === "POST" && matchesRequestPath(request.path, "/api/answers/batch"),
    );
  const relogin = requestIndex(requestTrace, "POST", "/api/participants/session");
  const latestAfterRelogin = requestIndex(requestTrace, "GET", "/api/answers/latest", relogin + 1);
  const restoredBatch = requestIndex(requestTrace, "GET", "/api/answers/batch", relogin + 1);
  expect(correctionAttempts).toHaveLength(2);
  expect(relogin).toBeGreaterThan(correctionAttempts[0]!.index);
  expect(latestAfterRelogin).toBeGreaterThan(relogin);
  expect(restoredBatch).toBeGreaterThan(latestAfterRelogin);
  expect(correctionAttempts[1]!.index).toBeGreaterThan(restoredBatch);
});

test("loads the canonical batch after a revision conflict while preserving the local draft", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const posts: BatchPayload[] = [];
  let savedAnswers: SavedBatchAnswer[] = [];
  let canonicalSubmissionId: string | undefined;
  await page.route("**/api/answers/batch**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          submissionId: canonicalSubmissionId,
          revision: 2,
          answers: savedAnswers,
        }),
      });
      return;
    }
    const body = request.postDataJSON() as BatchPayload;
    if (posts.length === 0) {
      canonicalSubmissionId = body.submissionId;
      savedAnswers = body.answers.map((answer) =>
        "freeText" in answer
          ? { ...answer, answerKind: "freeText" as const, selectedIndex: null }
          : { ...answer, answerKind: "selected" as const, freeText: null },
      );
      posts.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
      });
      return;
    }
    if (posts.length === 1) {
      posts.push(body);
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Revision conflict" }),
      });
      return;
    }
    posts.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 3 }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "A");
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();
  await expectResultsWaiting(page);

  await page.getByRole("button", { name: "回答を修正する" }).click();
  const q1Alternate = page.getByRole("radio", { name: /Option 1B/ });
  await selectRadio(page, /Option 1B/);
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "保存済み回答が更新されています。" }),
  ).toContainText("回答案は保持しています。内容を確認して、もう一度確定してください。");
  await expect(q1Alternate).toBeChecked();
  expect(posts).toHaveLength(2);
  expect(posts[1]?.submissionId).toBe(posts[0]?.submissionId);
  expect(posts[1]?.expectedRevision).toBe(1);
  const originalFirstAnswer = posts[0]?.answers[0];
  const revisedFirstAnswer = posts[1]?.answers[0];
  if (
    !originalFirstAnswer ||
    !revisedFirstAnswer ||
    !("selectedIndex" in originalFirstAnswer) ||
    !("selectedIndex" in revisedFirstAnswer)
  ) {
    throw new Error("Expected the first answer to be a selected answer");
  }
  expect(revisedFirstAnswer.selectedIndex).not.toBe(originalFirstAnswer.selectedIndex);

  const editedAnswers = posts[1]!.answers;
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expectResultsWaiting(page);
  expect(posts).toHaveLength(3);
  expect(posts[2]?.expectedRevision).toBe(2);
  expect(posts[2]?.answers).toEqual(editedAnswers);
});

test("keeps a stale second-tab draft distinct from the canonical submission after a 409", async ({
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
  const canonicalReads: { revision: number; answers: SavedBatchAnswer[] }[] = [];
  let canonical = {
    submissionId,
    revision: 1,
    answers: revisionOneAnswers,
  };
  const handleBatchRoute = async (route: Route) => {
    if (route.request().method() === "GET") {
      canonicalReads.push({ revision: canonical.revision, answers: canonical.answers });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(canonical),
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
  expect(canonicalReads).toHaveLength(0);

  await answerQuestion(secondTab, 1, "D");
  await secondTab.getByRole("textbox", { name: "回答（1000字以内）" }).fill("Bタブの未保存案");
  await answerQuestion(page, 1, "B");
  await page.getByRole("textbox", { name: "回答（1000字以内）" }).fill("Aタブで保存した回答");
  await page.getByRole("button", { name: "修正内容を確定する" }).click();
  await expectResultsWaiting(page);
  expect(canonical.revision).toBe(2);

  await secondTab.getByRole("button", { name: "修正内容を確定する" }).click();
  await expect(
    secondTab.getByRole("alert").filter({ hasText: "保存済み回答が更新されています。" }),
  ).toContainText("回答案は保持しています。内容を確認して、もう一度確定してください。");
  expect(canonicalReads).toEqual([{ revision: 2, answers: canonical.answers }]);
  await expect(secondTab.getByRole("radio", { name: /Option 1D/ })).toBeChecked();
  await expect(secondTab.getByRole("textbox", { name: "回答（1000字以内）" })).toHaveValue(
    "Bタブの未保存案",
  );

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

test("retains all choices through reauthentication and resubmits the batch only after an explicit action", async ({
  page,
}) => {
  await mockParticipantSession(page, "Aki");
  await mockQuestions(page);
  let answerCalls = 0;
  await page.route("**/api/answers/batch", async (route) => {
    answerCalls += 1;
    if (answerCalls === 1) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "Authentication required" }),
      });
      return;
    }
    const body = route.request().postDataJSON() as BatchPayload;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ submissionId: body.submissionId, revision: 1 }),
    });
  });

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "しゅんたま検定" })).toBeVisible();
  await expect(page.getByText("Aki", { exact: true })).toBeVisible();
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) await answerQuestion(page, id, "C");
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();
  await expect(page.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "回答内容を確認してください" })).toBeFocused();
  await expect(page.getByRole("radio", { name: /Option 1C/ })).toBeChecked();

  await page.getByLabel("4桁PIN").fill("0123");
  await page.getByRole("button", { name: "再ログインする" }).click();
  await expect(page.getByRole("button", { name: "同じ回答を再送する" })).toBeVisible();
  await expect(page.getByRole("button", { name: "同じ回答を再送する" })).toBeFocused();
  await expect(page.getByRole("radio", { name: /Option 1C/ })).toBeChecked();
  expect(answerCalls).toBe(1);
  await page.getByRole("button", { name: "同じ回答を再送する" }).click();
  await expectResultsWaiting(page);
  expect(answerCalls).toBe(2);
});

test("retries a failed exam batch with one request per attempt", async ({ page }) => {
  await mockParticipantSession(page);
  let fail = true;
  const requests: string[] = [];
  await page.route("**/api/questions/batch", async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary failure" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ questions: [1, 2, 3, 4, 5].map(questionFor) }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await expect(page.getByRole("button", { name: "もう一度読み込む" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
  await page.getByRole("button", { name: "もう一度読み込む" }).click();
  await expect(
    page.locator('section[aria-labelledby="question-title-1"]').getByRole("heading", {
      name: "Question 1?",
    }),
  ).toBeVisible();
  expect(requests).toEqual(["/api/questions/batch", "/api/questions/batch"]);
});
