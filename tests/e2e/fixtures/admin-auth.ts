import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const configuredE2eDatabaseUrl = process.env.STCIRT_E2E_DATABASE_URL;
if (
  configuredE2eDatabaseUrl &&
  !/^file:\/tmp\/stcirt-playwright-\d+\.db$/.test(configuredE2eDatabaseUrl)
) {
  throw new Error("E2E database URL must use the dedicated local Playwright database path.");
}
export const e2eDatabaseUrl =
  configuredE2eDatabaseUrl ?? `file:/tmp/stcirt-playwright-${process.pid}.db`;
process.env.STCIRT_E2E_DATABASE_URL = e2eDatabaseUrl;

// Re-assert this worker's isolated values after .env.local has been loaded.
process.env.STCIRT_E2E_DB_ISOLATION = "1";
process.env.TURSO_DATABASE_URL = e2eDatabaseUrl;
process.env.TURSO_AUTH_TOKEN = "";

if (
  process.env.STCIRT_E2E_DB_ISOLATION !== "1" ||
  process.env.TURSO_DATABASE_URL !== e2eDatabaseUrl ||
  process.env.TURSO_AUTH_TOKEN !== ""
) {
  throw new Error("Playwright worker database environment is not isolated.");
}

const fallbackPin = "7316";
const fallbackSessionSecret = "e2e-only-admin-session-secret-not-for-production-32-bytes";

export const e2eAdminPin = process.env.E2E_ADMIN_PRESENTATION_PIN ?? fallbackPin;
export const e2eAdminSessionSecret =
  process.env.E2E_ADMIN_PRESENTATION_SESSION_SECRET ?? fallbackSessionSecret;
export const e2eParticipantPin = process.env.E2E_PARTICIPANT_PIN ?? "8426";
export const e2eParticipantSessionSecret =
  process.env.E2E_PARTICIPANT_SESSION_SECRET ??
  "e2e-only-participant-session-secret-not-for-production-32-bytes";

// The Playwright runner and its dedicated Next.js web server share these test-only values.
process.env.ADMIN_PRESENTATION_PIN = e2eAdminPin;
process.env.ADMIN_PRESENTATION_SESSION_SECRET = e2eAdminSessionSecret;
process.env.PARTICIPANT_PIN = e2eParticipantPin;
process.env.PARTICIPANT_SESSION_SECRET = e2eParticipantSessionSecret;
