import { expect, test } from "./fixtures/test";
import { expectNoAccessibilityViolations } from "./axe";
import { expectPrimaryTargetGeometry } from "./target-geometry";

test("unauthenticated results show the safe return state", async ({ page }) => {
  await page.route(/^https?:\/\/[^/]+\/api\/participants\/results(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 401 });
  });

  await page.goto("/results");
  await expect(
    page.getByRole("heading", { name: "参加者セッションを確認できません" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "回答画面へ戻る" })).toBeVisible();
  const refresh = page.getByRole("button", { name: "結果を再読み込み" });
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrimaryTargetGeometry(refresh, `results manual refresh at ${width}px`);
  }
  await expectNoAccessibilityViolations(page, "unauthenticated results");
});

test("refresh can be activated with Space from the safe state and blocks repeats while a 401 is pending", async ({
  page,
}) => {
  let requests = 0;
  let releaseUnauthorizedResponse!: () => void;
  let announceRefreshStarted!: () => void;
  const unauthorizedResponse = new Promise<void>((resolve) => {
    releaseUnauthorizedResponse = resolve;
  });
  const refreshStarted = new Promise<void>((resolve) => {
    announceRefreshStarted = resolve;
  });
  await page.route(/^https?:\/\/[^/]+\/api\/participants\/results(?:\?.*)?$/, async (route) => {
    requests += 1;
    announceRefreshStarted();
    await unauthorizedResponse;
    await route.fulfill({ status: 401 });
  });

  const participantCookies = (await page.context().cookies()).filter(
    (cookie) => cookie.name === "stcirt_participant_session",
  );
  expect(participantCookies).toEqual([]);
  await page.goto("/results");
  await expect(
    page.getByRole("heading", { name: "参加者セッションを確認できません" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "回答画面へ戻る" })).toBeVisible();
  expect(requests).toBe(0);

  const refresh = page.getByRole("button", { name: "結果を再読み込み" });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Space");
  await refreshStarted;

  const updatingButton = page.getByRole("button", { name: "更新中…" });
  await expect(updatingButton).toBeDisabled();
  await expect(updatingButton).toHaveAccessibleName("更新中…");
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("更新中…");
  await expect(page.locator("main > section")).toHaveAttribute("aria-busy", "true");
  expect(requests).toBe(1);

  const focusBeforeRepeat = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? `${active.tagName}:${active.id}:${active.getAttribute("aria-label")}:${active.textContent}`
      : null;
  });
  await page.keyboard.press("Space");
  const focusAfterRepeat = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? `${active.tagName}:${active.id}:${active.getAttribute("aria-label")}:${active.textContent}`
      : null;
  });
  expect(focusAfterRepeat).toBe(focusBeforeRepeat);
  await expect(page.getByRole("status")).toHaveCount(1);
  expect(requests).toBe(1);

  releaseUnauthorizedResponse();
  await expect(
    page.getByRole("heading", { name: "参加者セッションを確認できません" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "回答画面へ戻る" })).toBeVisible();
  expect(requests).toBe(1);
});
