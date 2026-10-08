import { defineConfig, devices } from "@playwright/test";
import { e2eAdminPin, e2eAdminSessionSecret } from "./tests/e2e/fixtures/admin-auth";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
  ],

  webServer: {
    command: "pnpm exec next dev --turbopack --port 3001",
    url: "http://localhost:3001",
    reuseExistingServer: false,
    env: {
      ADMIN_PRESENTATION_PIN: e2eAdminPin,
      ADMIN_PRESENTATION_SESSION_SECRET: e2eAdminSessionSecret,
    },
  },
});
