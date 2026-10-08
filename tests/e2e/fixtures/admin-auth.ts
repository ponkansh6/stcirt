import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const fallbackPin = "7316";
const fallbackSessionSecret = "e2e-only-admin-session-secret-not-for-production-32-bytes";

export const e2eAdminPin = process.env.E2E_ADMIN_PRESENTATION_PIN ?? fallbackPin;
export const e2eAdminSessionSecret =
  process.env.E2E_ADMIN_PRESENTATION_SESSION_SECRET ?? fallbackSessionSecret;

// The Playwright runner and its dedicated Next.js web server share these test-only values.
process.env.ADMIN_PRESENTATION_PIN = e2eAdminPin;
process.env.ADMIN_PRESENTATION_SESSION_SECRET = e2eAdminSessionSecret;
