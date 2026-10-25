import { defineConfig, devices } from "@playwright/test";
import {
  e2eAdminPin,
  e2eAdminSessionSecret,
  e2eDatabaseUrl,
  e2eParticipantPin,
  e2eParticipantSessionSecret,
} from "./tests/e2e/fixtures/admin-auth";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:3001",
    locale: "ja-JP",
    trace: "on-first-retry",
    serviceWorkers: "block",
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
    command: "pnpm exec next dev --turbopack --hostname 127.0.0.1 --port 3001",
    url: "http://127.0.0.1:3001",
    reuseExistingServer: false,
    env: {
      ADMIN_PRESENTATION_PIN: e2eAdminPin,
      ADMIN_PRESENTATION_SESSION_SECRET: e2eAdminSessionSecret,
      PARTICIPANT_PIN: e2eParticipantPin,
      PARTICIPANT_SESSION_SECRET: e2eParticipantSessionSecret,
      STCIRT_E2E_DB_ISOLATION: "1",
      STCIRT_E2E_DATABASE_URL: e2eDatabaseUrl,
      TURSO_DATABASE_URL: e2eDatabaseUrl,
      TURSO_AUTH_TOKEN: "",
    },
  },
});
