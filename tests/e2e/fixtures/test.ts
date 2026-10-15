import { expect, test as base } from "@playwright/test";

// These real-handler requests are intentional and narrowly scoped.
export const E2E_REAL_API_ALLOWLIST = [{ method: "POST", pathname: "/api/admin/session" }] as const;

export const test = base.extend({
  page: async ({ page }, use) => {
    const unmockedApiRequests: string[] = [];

    // Installed before each spec's routes; their route.fallback() reaches here.
    await page.context().route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const isExplicitlyAllowed = E2E_REAL_API_ALLOWLIST.some(
        (entry) => entry.method === request.method() && entry.pathname === pathname,
      );

      if (isExplicitlyAllowed) {
        await route.fallback();
        return;
      }

      unmockedApiRequests.push(`${request.method()} ${pathname}`);
      await route.abort();
    });

    await use(page);

    expect(unmockedApiRequests, "unmocked API requests").toEqual([]);
  },
});

export { expect };
export type { Locator, Page, Route, TestInfo } from "@playwright/test";
