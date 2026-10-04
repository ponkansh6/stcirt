import { test, expect } from "@playwright/test";

test("home page displays five-question exam briefing and secondary aggregate statistics", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator("h1")).toHaveText("5問検定");
  await expect(page.getByText("全5問", { exact: true })).toBeVisible();
  await expect(page.getByText("順番に出題")).toBeVisible();
  await expect(page.getByText("回答を記録します")).toBeVisible();
  await expect(page.getByRole("link", { name: "検定を開始する" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "これまでの回答状況" })).toBeVisible();
  await expect(page.getByText("検定1回ごとの成績ではありません")).toBeVisible();
  await expect(page.locator("text=問題数")).toBeVisible();
  await expect(page.locator("text=本日の解答数")).toBeVisible();
  await expect(page.locator("text=本日の正答率")).toBeVisible();
  await expect(page.locator("a[href='/create']")).toHaveCount(0);
  await expect(page.locator("a[href='/questions']")).toHaveCount(0);
});
