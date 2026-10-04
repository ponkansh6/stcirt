import { test, expect } from "@playwright/test";
import { makeQuestion } from "../fixtures/question";

const questionFor = (id: number) =>
  makeQuestion({
    id,
    question: `Question ${id}?`,
    choices: [`Option ${id}A`, `Option ${id}B`, `Option ${id}C`, `Option ${id}D`],
  });

const neutralAnswer = { isCorrect: false, correctIndex: 0, explanation: "Hidden explanation" };

test("direct answer access explains when five questions are unavailable", async ({ page }) => {
  await page.route("/api/questions/next*", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "No question" }),
    });
  });

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "問題が足りません" })).toBeVisible();
  await expect(page.getByText("全5問をそろえられないため、検定を開始できません。")).toBeVisible();
  await expect(page.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/");
});

test("loads the first five questions in order and keeps the question set fixed", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("/api/questions/next*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const afterId = Number(url.searchParams.get("afterId") ?? 0);
    const id = afterId + 1;
    if (id > 5) {
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
      body: JSON.stringify(questionFor(id)),
    });
  });

  await page.goto("/answer");
  await expect(page.getByRole("heading", { name: "第1問 / 全5問" })).toBeVisible();
  await expect(page.getByText("Question 1?")).toBeVisible();
  await expect(page.getByText("回答記録済み 0/5")).toBeVisible();
  expect(requests).toEqual([
    "/api/questions/next",
    "/api/questions/next?afterId=1",
    "/api/questions/next?afterId=2",
    "/api/questions/next?afterId=3",
    "/api/questions/next?afterId=4",
  ]);
});

test("requires explicit confirmation, records the answer, and advances without grading UI", async ({
  page,
}) => {
  const submitted: unknown[] = [];
  await page.route("/api/questions/next*", async (route) => {
    const afterId = Number(new URL(route.request().url()).searchParams.get("afterId") ?? 0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(questionFor(afterId + 1)),
    });
  });
  await page.route("/api/answers", async (route) => {
    submitted.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(neutralAnswer),
    });
  });

  await page.goto("/answer");
  await expect(page.getByText("Question 1?")).toBeVisible();
  const confirm = page.getByRole("button", { name: "回答を確定する" });
  await expect(confirm).toBeDisabled();
  await page.getByRole("button", { name: /Option 1B/ }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByRole("heading", { name: "第2問 / 全5問" })).toBeVisible();
  await expect(page.getByText("回答記録済み 1/5")).toBeVisible();
  await expect(page.getByText(/正解！|不正解|解説:|正答率|合格/)).toHaveCount(0);
  expect(submitted).toEqual([{ questionId: 1, selectedIndex: 1 }]);
});

test("shows neutral completion after the fifth recorded answer", async ({ page }) => {
  await page.route("/api/questions/next*", async (route) => {
    const afterId = Number(new URL(route.request().url()).searchParams.get("afterId") ?? 0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(questionFor(afterId + 1)),
    });
  });
  await page.route("/api/answers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(neutralAnswer),
    });
  });

  await page.goto("/answer");
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

test("keeps the selected answer and resends only after an explicit retry action", async ({
  page,
}) => {
  let answerCalls = 0;
  await page.route("/api/questions/next*", async (route) => {
    const afterId = Number(new URL(route.request().url()).searchParams.get("afterId") ?? 0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(questionFor(afterId + 1)),
    });
  });
  await page.route("/api/answers", async (route) => {
    answerCalls += 1;
    if (answerCalls === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary failure" }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(neutralAnswer),
      });
    }
  });

  await page.goto("/answer");
  await page.getByRole("button", { name: /Option 1C/ }).click();
  await page.getByRole("button", { name: "回答を確定する" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: /Option 1C.*選択中/ })).toBeDisabled();
  await expect(page.getByRole("link", { name: "ホームへ戻る" })).toHaveAttribute("href", "/");
  await page.getByRole("button", { name: "回答を再送する" }).click();
  await expect(page.getByRole("heading", { name: "第2問 / 全5問" })).toBeVisible();
  expect(answerCalls).toBe(2);
});

test("retries only missing questions after a prefetch network failure", async ({ page }) => {
  let fail = true;
  const requests: string[] = [];
  await page.route("/api/questions/next*", async (route) => {
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
