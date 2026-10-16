import { test, expect } from "./fixtures/test";

test("root is a compatibility redirect to participant entry", async ({ page }) => {
  await page.route("**/api/participants/session", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ participant: null }),
    });
  });

  await page.goto("/");

  await expect(page).toHaveURL(/\/answer$/);
  await expect(page.getByRole("heading", { name: "参加して検定を受ける" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "しゅんたま検定" })).toHaveCount(0);
  await expect(page.getByText("これまでの回答状況")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveCount(0);
});
