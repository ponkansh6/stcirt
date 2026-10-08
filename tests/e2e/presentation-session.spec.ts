import { test, expect } from "@playwright/test";
import { e2eAdminPin } from "./fixtures/admin-auth";

test.use({ trace: "off" });

test("an existing admin session opens the dashboard when revisiting the admin route", async ({
  page,
}) => {
  await page.route("**/api/admin/presentation", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        state: "not_started",
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
  });

  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").fill(e2eAdminPin);
  await page.getByRole("button", { name: "管理ページにログイン" }).click();
  await expect(page.getByText("現在の状態：未開始")).toBeVisible();

  const adminCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "stcirt_admin_presentation",
  );
  expect(adminCookie?.httpOnly).toBe(true);

  await page.goto("about:blank");
  await page.goto("/admin/presentation");
  await expect(page.getByText("現在の状態：未開始")).toBeVisible();
  await expect(page.getByRole("button", { name: "発表を開始" })).toBeVisible();
  await expect(page.getByLabel("管理者 PIN")).toHaveCount(0);
});
