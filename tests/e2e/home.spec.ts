import { test, expect } from "@playwright/test";

test("home removes aggregate answer status and gates the start CTA on five available questions", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator("h1")).toHaveText("5問検定");
  await expect(page.getByRole("listitem").filter({ hasText: "全5問" })).toBeVisible();
  await expect(page.getByText("順番に出題")).toBeVisible();
  await expect(page.getByText("回答を記録します")).toBeVisible();
  await expect(page.getByRole("heading", { name: "これまでの回答状況" })).toHaveCount(0);
  await expect(page.getByText("検定1回ごとの成績ではありません")).toHaveCount(0);
  await expect(page.getByText("本日の解答数")).toHaveCount(0);
  await expect(page.getByText("本日の正答率")).toHaveCount(0);
  await expect(page.locator("a[href='/create']")).toHaveCount(0);
  await expect(page.locator("a[href='/questions']")).toHaveCount(0);

  const start = page.getByRole("link", { name: "検定を開始する" });
  await expect(start).toBeVisible();
  if ((await start.getAttribute("aria-disabled")) === "true") {
    const shortage = page.getByRole("status");
    await expect(shortage).toHaveText(/問題は現在\d+問です。5問そろうと開始できます。/);
    const count = Number((await shortage.textContent())?.match(/現在(\d+)問/)?.[1]);
    expect(count).toBeLessThan(5);
    await start.click();
    await expect(page).toHaveURL(/\/$/);
  } else {
    await expect(page.getByRole("status")).toHaveCount(0);
    await start.click();
    await expect(page).toHaveURL(/\/answer$/);
    await expect(page.getByRole("heading", { name: "参加して検定を受ける" })).toBeVisible();
  }
});
