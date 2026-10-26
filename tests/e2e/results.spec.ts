import { expect, test } from "./fixtures/test";
import { expectNoAccessibilityViolations } from "./axe";

test("@chromium unauthenticated results show the safe return state", async ({ page }) => {
  await page.route(/^https?:\/\/[^/]+\/api\/participants\/results(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 401 });
  });

  await page.goto("/results");
  await expect(
    page.getByRole("heading", { name: "参加者セッションを確認できません" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "回答完了画面へ戻る" })).toBeVisible();
  await expect(page.getByRole("button", { name: "結果を再読み込み" })).toHaveCount(0);
  await expectNoAccessibilityViolations(page, "unauthenticated results");
});

test("@chromium silently refreshes on tab return without showing a manual reload button", async ({
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
  await expect(page.getByRole("link", { name: "回答完了画面へ戻る" })).toBeVisible();
  await expect(page.getByRole("button", { name: "結果を再読み込み" })).toHaveCount(0);
  expect(requests).toBe(0);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await refreshStarted;

  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "結果を再読み込み" })).toHaveCount(0);
  expect(requests).toBe(1);

  releaseUnauthorizedResponse();
  await expect(
    page.getByRole("heading", { name: "参加者セッションを確認できません" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "回答完了画面へ戻る" })).toBeVisible();
  expect(requests).toBe(1);
});
