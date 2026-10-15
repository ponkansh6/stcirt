import { test, expect } from "./fixtures/test";
import { e2eAdminPin } from "./fixtures/admin-auth";
import { expectNoAccessibilityViolations } from "./axe";
import { expectPrimaryTargetGeometry } from "./target-geometry";

test.use({ trace: "off" });

test("an existing admin session opens the dashboard when revisiting the admin route", async ({
  page,
}) => {
  await page.route("**/api/admin/presentation", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const cookieHeader = route.request().headers().cookie ?? "";
    if (!/(?:^|;\s*)stcirt_admin_presentation=/.test(cookieHeader)) {
      await route.fulfill({ status: 401 });
      return;
    }
    await route.fulfill({
      json: {
        state: "not_started",
        snapshotRevision: 0,
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: false,
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
  const startPresentation = page.getByRole("button", { name: "発表を開始" });
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrimaryTargetGeometry(startPresentation, `admin presentation start at ${width}px`);
  }
  await expectNoAccessibilityViolations(page, "admin presentation dashboard");
  await expect(page.getByLabel("管理者 PIN")).toHaveCount(0);
});

test("admin PIN login follows Tab order and submits once with Enter", async ({ page }) => {
  let authenticated = false;
  let releaseLogin!: () => void;
  let announceLoginStarted!: () => void;
  const loginResponse = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  const loginStarted = new Promise<void>((resolve) => {
    announceLoginStarted = resolve;
  });
  const loginBodies: unknown[] = [];

  await page.route("**/api/admin/session", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { authenticated },
      });
      return;
    }
    if (route.request().method() === "POST") {
      loginBodies.push(route.request().postDataJSON());
      announceLoginStarted();
      await loginResponse;
      authenticated = true;
      await route.fulfill({ json: { authenticated: true } });
      return;
    }
    await route.fulfill({ status: 405 });
  });
  await page.route("**/api/admin/presentation", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 405 });
      return;
    }
    if (!authenticated) {
      await route.fulfill({ status: 401, json: {} });
      return;
    }
    await route.fulfill({
      json: {
        state: "not_started",
        snapshotRevision: 0,
        questionIndex: 0,
        questionCount: 5,
        projectionHidden: false,
        participantResultsVisible: false,
        participantResultsReady: true,
      },
    });
  });

  await page.goto("/admin/presentation");
  const pin = page.getByLabel("管理者 PIN");
  await expect(pin).toHaveAccessibleName("管理者 PIN");
  const submit = page.getByRole("button", { name: "管理ページにログイン" });
  await expect(submit).toBeDisabled();
  await pin.focus();
  await page.keyboard.press("Enter");
  expect(loginBodies).toEqual([]);
  await expect(pin).toBeFocused();
  await pin.fill(e2eAdminPin);
  await expect(submit).toBeEnabled();
  await pin.focus();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(pin).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Enter");
  await loginStarted;

  const pendingSubmit = page.getByRole("button", { name: "確認中…" });
  await expect(pendingSubmit).toBeDisabled();
  expect(loginBodies).toEqual([{ pin: e2eAdminPin }]);
  const focusWhilePending = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? `${active.tagName}:${active.id}:${active.getAttribute("aria-label")}:${active.textContent}`
      : null;
  });
  await page.keyboard.press("Enter");
  const focusAfterRepeat = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? `${active.tagName}:${active.id}:${active.getAttribute("aria-label")}:${active.textContent}`
      : null;
  });
  expect(focusAfterRepeat).toBe(focusWhilePending);
  expect(loginBodies).toEqual([{ pin: e2eAdminPin }]);

  releaseLogin();
  await expect(page.getByText("現在の状態：未開始")).toBeVisible();
  expect(loginBodies).toEqual([{ pin: e2eAdminPin }]);
});
