import { test, expect, type Page } from "@playwright/test";
import { makeQuestion } from "../fixtures/question";

const questionFor = (id: number) =>
  makeQuestion({
    id,
    question: `Question ${id}?`,
    choices: [`Option ${id}A`, `Option ${id}B`, `Option ${id}C`, `Option ${id}D`],
  });

const neutralAnswer = { isCorrect: false, correctIndex: 0, explanation: "Hidden explanation" };

async function mockParticipantSession(page: Page, initialName: string | null = null) {
  let activeParticipant = initialName ? { id: 17, name: initialName } : null;
  const loginRequests: unknown[] = [];
  let logoutRequests = 0;

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
      activeParticipant = { id: 17 + loginRequests.length, name: body.name };
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

  return {
    loginRequests,
    get logoutRequests() {
      return logoutRequests;
    },
  };
}

async function mockQuestions(page: Page, requests: string[] = []) {
  await page.route("**/api/questions/next*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const afterId = Number(url.searchParams.get("afterId") ?? 0);
    if (afterId >= 5) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "No question" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(questionFor(afterId + 1)),
    });
  });
}

async function signIn(page: Page, name = "Test Participant", pin = "0123") {
  await page.getByLabel("お名前").fill(name);
  await page.getByLabel("4桁PIN").fill(pin);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByRole("heading", { name: `${name}さん` })).toBeVisible();
}

async function startQuiz(page: Page) {
  await page.getByRole("button", { name: "検定をはじめる" }).click();
}

test("direct answer access requires name and four digit PIN before the explicit start action", async ({
  page,
}) => {
  const { loginRequests } = await mockParticipantSession(page);
  const requests: string[] = [];
  await mockQuestions(page, requests);

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "参加して検定を受ける" })).toBeVisible();
  await expect(page.getByLabel("4桁PIN")).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByLabel("4桁PIN")).toHaveAttribute("pattern", "[0-9]{4}");
  await signIn(page, "Aki", "0123");

  expect(loginRequests).toEqual([{ name: "Aki", pin: "0123" }]);
  expect(requests).toEqual([]);
  await expect(page.getByRole("button", { name: "検定をはじめる" })).toBeVisible();
  await startQuiz(page);
  await expect(page.getByRole("heading", { name: "第1問 / 全5問" })).toBeVisible();
  expect(requests).toEqual([
    "/api/questions/next",
    "/api/questions/next?afterId=1",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=3",
    "/api/questions/next?afterId=4",
  ]);
});

test("direct answer access explains when five questions are unavailable", async ({ page }) => {
  await mockParticipantSession(page);
  await page.route("**/api/questions/next*", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "No question" }),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  await expect(page.getByRole("heading", { name: "問題が足りません" })).toBeVisible();
  await expect(
    page.getByText(
      "全5問をそろえられないため、検定を開始できません。問題が5問そろったら、もう一度お試しください。",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/");
});

test("requires explicit confirmation, records the selected answer with the participant cookie, and advances without grading UI", async ({
  page,
}) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  const submitted: Array<{ body: unknown; cookie: string | undefined }> = [];
  await page.route("**/api/answers", async (route) => {
    submitted.push({
      body: route.request().postDataJSON(),
      cookie: route.request().headers().cookie,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(neutralAnswer),
    });
  });

  await page.goto("/answer");
  await signIn(page, "Aki");
  await startQuiz(page);
  await expect(page.getByText("Question 1?")).toBeVisible();
  const confirm = page.getByRole("button", { name: "回答を確定する" });
  await expect(confirm).toBeDisabled();
  await page.getByRole("button", { name: /Option 1B/ }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByRole("heading", { name: "第2問 / 全5問" })).toBeVisible();
  await expect(page.getByText("回答記録済み 1/5")).toBeVisible();
  await expect(page.getByText(/正解！|不正解|解説:|正答率|合格/)).toHaveCount(0);
  expect(submitted).toHaveLength(1);
  expect(submitted[0].body).toMatchObject({ questionId: 1 });
  expect(submitted[0].body).not.toHaveProperty("participantId");
  expect(submitted[0].cookie).toContain("stcirt_participant_session=mock-session");
});

test("shows neutral completion after the fifth recorded answer", async ({ page }) => {
  await mockParticipantSession(page);
  await mockQuestions(page);
  await page.route("**/api/answers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(neutralAnswer),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  for (let id = 1; id <= 5; id += 1) {
    await expect(page.getByText(`Question ${id}?`)).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`Option ${id}A`) }).click();
    await page.getByRole("button", { name: "回答を確定する" }).click();
  }

  await expect(page.getByRole("heading", { name: "回答完了" })).toBeVisible();
  await expect(page.getByText("全5問の回答を記録しました。")).toBeVisible();
  await expect(page.getByRole("button", { name: "もう一度受検する" })).toBeVisible();
  await expect(page.getByText(/正解！|不正解|解説:|正答率|合格|得点/)).toHaveCount(0);
});

test("allows a different participant after ending the current session", async ({ page }) => {
  const session = await mockParticipantSession(page, "First Participant");
  await mockQuestions(page);

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "First Participantさん" })).toBeVisible();
  await expect(page.getByRole("button", { name: "検定をはじめる" })).toBeVisible();
  await page.getByRole("button", { name: "別の名前で参加" }).click();
  await expect(page.getByRole("heading", { name: "参加して検定を受ける" })).toBeVisible();
  await signIn(page, "Second Participant", "0042");
  expect(session.logoutRequests).toBe(1);
  expect(session.loginRequests).toEqual([{ name: "Second Participant", pin: "0042" }]);
  await expect(page.getByRole("button", { name: "検定をはじめる" })).toBeVisible();
});

test("retains a selected answer through reauthentication and resends only after an explicit action", async ({
  page,
}) => {
  await mockParticipantSession(page, "Aki");
  await mockQuestions(page);
  let answerCalls = 0;
  await page.route("**/api/answers", async (route) => {
    answerCalls += 1;
    if (answerCalls === 1) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Authentication required" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(neutralAnswer),
    });
  });

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "Akiさん" })).toBeVisible();
  await startQuiz(page);
  await page.getByRole("button", { name: /Option 1C/ }).click();
  await page.getByRole("button", { name: "回答を確定する" }).click();
  await expect(page.getByRole("heading", { name: "参加状態の確認が必要です" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Option 1C.*選択中/ })).toBeDisabled();

  await page.getByLabel("4桁PIN").fill("0123");
  await page.getByRole("button", { name: "再ログインする" }).click();
  await expect(page.getByRole("heading", { name: "回答を記録できませんでした" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Option 1C.*選択中/ })).toBeDisabled();
  expect(answerCalls).toBe(1);
  await page.getByRole("button", { name: "回答を再送する" }).click();
  await expect(page.getByRole("heading", { name: "第2問 / 全5問" })).toBeVisible();
  expect(answerCalls).toBe(2);
});

test("retries only missing questions after a prefetch network failure", async ({ page }) => {
  await mockParticipantSession(page);
  let fail = true;
  const requests: string[] = [];
  await page.route("**/api/questions/next*", async (route) => {
    const url = new URL(route.request().url());
    const afterId = Number(url.searchParams.get("afterId") ?? 0);
    requests.push(`${url.pathname}${url.search}`);
    if (afterId === 2 && fail) {
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
      body: JSON.stringify(questionFor(afterId + 1)),
    });
  });

  await page.goto("/answer");
  await signIn(page);
  await startQuiz(page);
  await page.getByRole("button", { name: "不足分を再読み込み" }).click();
  await expect(page.getByRole("heading", { name: "第1問 / 全5問" })).toBeVisible();
  expect(requests).toEqual([
    "/api/questions/next",
    "/api/questions/next?afterId=1",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=3",
    "/api/questions/next?afterId=4",
  ]);
});
