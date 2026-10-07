import { test, expect } from "@playwright/test";

test("root is a compatibility redirect to participant entry", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/answer$/);
  await expect(page.getByRole("heading", { name: "参加して検定を受ける" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "5問検定" })).toHaveCount(0);
  await expect(page.getByText("これまでの回答状況")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
});
