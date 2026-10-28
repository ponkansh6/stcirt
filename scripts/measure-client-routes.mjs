/*
 * Local synthetic navigation baseline for /answer, /results and /presentation.
 * Requires an existing `pnpm build`; this script does not build the app. It
 * uses the same disposable SQLite fixture pattern as measure-results-page.mjs.
 * All requests are restricted to 127.0.0.1:3001.
 *
 * Fresh contexts approximate a cold browser cache; new pages in one context
 * approximate a warm browser cache. Server/OS/Next caches can remain
 * warm. Resource Timing sizes are browser observations, not wire-byte totals.
 * The bounded LCP observation is a synthetic proxy, not terminal/user LCP.
 */
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@libsql/client";
import { chromium } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = 3001;
const BASE_URL = `http://${HOST}:${PORT}`;
const SAMPLES = positiveInteger(process.env.ROUTE_BENCH_SAMPLES, 3);
const root = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "stcirt-client-routes-"));
const dbPath = join(tempDir, "fixture.db");
const secret = randomBytes(32).toString("hex");
const pin = "7316";
let db;
let server;
let browser;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cookie(participantId) {
  // Results route only needs an authenticated participant cookie. Authenticated
  // route state is therefore held constant across all three navigations.
  const key = createHmac("sha256", secret).update(`stcirt-participant-session-v1\0${pin}`).digest();
  const encoded = Buffer.from(
    JSON.stringify({ id: participantId, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}

async function seed() {
  db = createClient({ url: `file:${dbPath}` });
  const journalPath = join(root, "src/lib/db/migrations/meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  for (const entry of journal.entries) {
    const sql = await readFile(join(root, "src/lib/db/migrations", `${entry.tag}.sql`), "utf8");
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await db.execute(statement);
    }
  }
  await db.batch(
    [
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [1, "route-owner", "合成本人"],
      },
      {
        sql: "INSERT INTO participant_result_settings (id, visible, ever_published) VALUES (?, ?, ?)",
        args: [1, 1, 1],
      },
      {
        sql: "INSERT INTO presentation_sessions (id, state, version, question_index, question_count, snapshot_revision) VALUES (?, ?, ?, ?, ?, ?)",
        args: [1, "finished", 1, 0, 0, 1],
      },
    ],
    "write",
  );
  await db.close();
  db = undefined;
}

async function startServer() {
  await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen({ host: HOST, port: PORT, exclusive: true }, () => probe.close(resolve));
  });
  server = spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      HOST,
      "--port",
      String(PORT),
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        TURSO_DATABASE_URL: `file:${dbPath}`,
        TURSO_AUTH_TOKEN: "",
        STCIRT_E2E_DB_ISOLATION: "1",
        PARTICIPANT_SESSION_SECRET: secret,
        PARTICIPANT_PIN: pin,
        PARTICIPANT_SESSION_DAYS: "1",
      },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 120; i += 1) {
    if (server.exitCode !== null) throw new Error("Production server exited before becoming ready");
    try {
      const response = await fetch(BASE_URL);
      if (response.status) return;
    } catch {}
    await delay(250);
  }
  throw new Error("Timed out waiting for local production server");
}

async function capture(context, pathname, cache, iteration) {
  const page = await context.newPage();
  const externalRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== BASE_URL) externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    window.__routeLcp = [];
    try {
      new PerformanceObserver((list) =>
        window.__routeLcp.push(...list.getEntries().map((e) => e.startTime)),
      ).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
  });
  await context.addCookies([
    { name: "stcirt_participant_session", value: cookie(1), url: BASE_URL },
  ]);
  const response = await page.goto(`${BASE_URL}${pathname}`, { waitUntil: "domcontentloaded" });
  if (!response) throw new Error(`${pathname}: missing document response`);
  if (response.status() !== 200) {
    throw new Error(`${pathname}: expected HTTP 200, got ${response.status()}`);
  }
  const finalUrl = new URL(page.url());
  if (finalUrl.origin !== BASE_URL || finalUrl.pathname !== pathname) {
    throw new Error(`${pathname}: unexpected final URL ${page.url()}`);
  }
  const decodedDocumentBytes = (await response.body()).byteLength;
  await page.waitForTimeout(750);
  if (externalRequests.length > 0) {
    throw new Error(
      `${pathname}: unexpected external request(s); browser DNS blocking is enabled: ${externalRequests.join(", ")}`,
    );
  }
  const metrics = await page.evaluate(async () => {
    await document.fonts.ready;
    const resources = performance
      .getEntriesByType("resource")
      .filter((e) => /\.(?:woff2?|ttf|otf|m?js|css)(?:$|\?)/i.test(e.name))
      .map((e) => ({
        path: new URL(e.name).pathname,
        kind: /\.(?:woff2?|ttf|otf)(?:$|\?)/i.test(e.name)
          ? "font"
          : /\.css(?:$|\?)/i.test(e.name)
            ? "style"
            : "script",
        transfer_size_bytes: e.transferSize,
        encoded_body_size_bytes: e.encodedBodySize,
        decoded_body_size_bytes: e.decodedBodySize,
      }));
    const byKind = Object.fromEntries(
      ["script", "style", "font"].map((kind) => {
        const entries = resources.filter((entry) => entry.kind === kind);
        return [
          kind,
          {
            resource_count: entries.length,
            transfer_size_bytes: entries.reduce((n, e) => n + e.transfer_size_bytes, 0),
            encoded_body_size_bytes: entries.reduce((n, e) => n + e.encoded_body_size_bytes, 0),
            decoded_body_size_bytes: entries.reduce((n, e) => n + e.decoded_body_size_bytes, 0),
          },
        ];
      }),
    );
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      fcp_ms: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      lcp_entries_ms: window.__routeLcp,
      resource_totals: byKind,
      resources,
      navigation_timing_ms: nav
        ? {
            response_start: nav.responseStart,
            dom_content_loaded: nav.domContentLoadedEventEnd,
            load: nav.loadEventEnd,
          }
        : null,
    };
  });
  const result = {
    route: pathname,
    final_path: finalUrl.pathname,
    cache,
    iteration,
    status: response.status(),
    decoded_document_body_bytes: decodedDocumentBytes,
    ...metrics,
  };
  await page.close();
  return result;
}

async function captureAnswerInteraction(browser) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
  const page = await context.newPage();
  const requests = [];
  const questions = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    question: `Synthetic question ${index + 1}?`,
    choices:
      index === 4
        ? []
        : [
            `Option ${index + 1}A`,
            `Option ${index + 1}B`,
            `Option ${index + 1}C`,
            `Option ${index + 1}D`,
          ],
    answerType: index === 4 ? "freeText" : "selected",
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const startedAt = performance.now();
    let status = 200;
    let body = {};
    if (url.pathname === "/api/participants/session" && request.method() === "GET") {
      body = { participant: null };
    } else if (url.pathname === "/api/participants/session" && request.method() === "POST") {
      body = {
        participant: { id: 17, name: "Synthetic participant" },
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    } else if (url.pathname === "/api/questions/batch") {
      body = { questions };
    } else if (url.pathname === "/api/answers/latest") {
      body = { submission: null };
    } else if (url.pathname === "/api/answers/batch" && request.method() === "GET") {
      body = { resultsVisible: false };
    } else if (url.pathname === "/api/answers/batch" && request.method() === "POST") {
      const payload = request.postDataJSON();
      body = { submissionId: payload.submissionId, revision: 1 };
    } else if (url.pathname === "/api/participants/results") {
      body = { state: "waiting" };
    } else if (url.pathname === "/api/participants/assisted") {
      body = { participant: null, hasSubmission: false, eligible: true };
    } else {
      status = 404;
      body = { error: "Unexpected synthetic API request" };
    }
    requests.push({
      method: request.method(),
      path: `${url.pathname}${url.search}`,
      status,
      elapsed_ms: performance.now() - startedAt,
    });
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  const externalRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== BASE_URL) externalRequests.push(request.url());
  });
  await page.goto(`${BASE_URL}/answer`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "受験者氏名" }).fill("Synthetic participant");
  await page.getByRole("textbox", { name: "受験コード" }).fill("7316");
  const loginStartedAt = performance.now();
  await page.getByRole("button", { name: "はじめる" }).click();
  await page.locator('section[aria-labelledby="question-title-1"]').waitFor({ state: "visible" });
  const firstQuestionReadyMs = performance.now() - loginStartedAt;
  const resourcesBeforeAnswers = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  for (let index = 1; index <= 4; index += 1) {
    await page.getByRole("radio", { name: new RegExp(`Option ${index}A`) }).check({ force: true });
  }
  await page.getByRole("textbox", { name: "回答" }).fill("Synthetic free text");
  const submitStartedAt = performance.now();
  await page.getByRole("button", { name: "5問の回答を確定する" }).click();
  await page.getByRole("heading", { name: "回答済み" }).waitFor({ state: "visible" });
  const completionReadyMs = performance.now() - submitStartedAt;
  if (externalRequests.length > 0 || requests.some(({ status }) => status !== 200)) {
    throw new Error(`answer interaction encountered invalid traffic or API responses`);
  }
  const result = {
    route: "/answer",
    scenario: "synthetic_login_load_answer_submit",
    sample_count: 1,
    login_to_first_question_ready_ms: firstQuestionReadyMs,
    submit_to_completion_ready_ms: completionReadyMs,
    requests,
    resources_loaded_after_initial_document: await page.evaluate(
      (before) =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => !before.includes(entry.name))
          .map((entry) => ({
            path: new URL(entry.name).pathname,
            transfer_size_bytes: entry.transferSize,
            encoded_body_size_bytes: entry.encodedBodySize,
          })),
      resourcesBeforeAnswers,
    ),
    limits: [
      "API responses are synthetic and fulfilled inside Playwright; API elapsed_ms is route-handler time, not network or database latency.",
      "One sample only; resource differences cover login, question load, answer interactions and completion as a combined interval.",
      "This does not measure production API activity, remote wire transfer, image decode or terminal LCP.",
    ],
  };
  await context.close();
  return result;
}

try {
  await seed();
  await startServer();
  browser = await chromium.launch({
    headless: true,
    args: [
      // Keep browser HTTP cache active (Playwright route interception disables
      // it). Normal app requests bypass the proxy only for the exact local app
      // origin; external hostname requests fail DNS, and external IP literals
      // are sent to the app server as a non-forwarding proxy sink.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--proxy-server=http://127.0.0.1:3001",
      "--proxy-bypass-list=127.0.0.1:3001",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
    ],
  });
  const routes = ["/answer", "/results", "/presentation"];
  const samples = [];
  for (const route of routes) {
    for (let i = 1; i <= SAMPLES; i += 1) {
      const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
      samples.push(await capture(context, route, "fresh_context", i));
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
    await capture(context, route, "same_context_new_page_primer", 0);
    for (let i = 1; i <= SAMPLES; i += 1)
      samples.push(await capture(context, route, "same_context_new_page", i));
    await context.close();
  }
  const answerInteraction = await captureAnswerInteraction(browser);
  process.stdout.write(
    `${JSON.stringify(
      {
        measurement: "synthetic_local_production_route_navigation",
        bundler: "Next.js production Webpack build; existing build is not changed by this script",
        environment: {
          browser: "Playwright Chromium headless",
          viewport: "1365x768",
          samples_per_route_cache_state: SAMPLES,
          base_url: BASE_URL,
        },
        fixture:
          "disposable file-backed SQLite; synthetic participant and result/presentation settings; no production data",
        cache_definition:
          "fresh_context uses a new browser context for each sample; same_context_new_page creates a new page for each sample in one context. These are not reloads of the same page. Playwright route interception is not enabled, so Chromium HTTP cache remains active. Server, OS and Next caches may remain warm.",
        outbound_safety:
          "HTTP/HTTPS requests use 127.0.0.1:3001 as a non-forwarding proxy sink, with bypass only for the exact local app origin. The local Next.js server is not a proxy and cannot forward external IP-literal requests. Host resolver rules also fail closed for non-loopback hostnames. The probe fails if any non-local origin request is observed. Background networking, component updates and sync are disabled.",
        auth: "same synthetic participant cookie on every route; /presentation is public mode (presenter=0)",
        limits: [
          "Resource Timing transfer/encoded/decoded sizes are browser observations and do not include transport framing; zero transfer size may indicate cache or unavailable data.",
          "Local loopback measurements do not represent remote wire transfer or production latency.",
          "LCP entries are observed for a fixed 750 ms window after DOMContentLoaded, so the last entry is not guaranteed terminal LCP.",
          "This navigation probe does not exercise answer interactions, image waits, presentation animation completion, or API activity latency; those require route-specific probes.",
          "Results and presentation fixture content is intentionally minimal; /answer route asset loading is measured with synthetic session auth, but this fixture does not model a complete exam interaction.",
        ],
        samples,
        answer_interaction: answerInteraction,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (db) await db.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await rm(tempDir, { recursive: true, force: true });
}
