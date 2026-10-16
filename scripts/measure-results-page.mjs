/*
 * Local synthetic results page measurement. This script creates a disposable
 * file-backed SQLite database from the checked-in Drizzle migration journal,
 * seeds two synthetic participants, then starts the existing production build
 * on 127.0.0.1:3001 with that database and synthetic auth configuration.
 * It never reads .env.local values for the database/auth settings because the
 * child environment explicitly overrides them.
 *
 * Requires an existing production build (`pnpm build`); this script does not
 * build the app. Set RESULTS_BENCH_SAMPLES (default 3) to change sample count.
 * HTML response bytes and Playwright request timing are local HTTP observations,
 * not remote wire/Turso timings. Fresh browser contexts approximate cold client
 * cache; server/OS/Next caches may remain warm. Same-context reloads approximate
 * warm client cache. Content-Length is a response header, not total wire bytes.
 * RSC observations are reported only if Next emits them.
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
const SAMPLE_COUNT = positiveInteger(process.env.RESULTS_BENCH_SAMPLES, 3);
const COOKIE_NAME = "stcirt_participant_session";
const SESSION_PURPOSE = "stcirt-participant-session-v1";
const PIN = "7316";
const SECRET = randomBytes(32).toString("hex");
const ANSWER_KINDS = ["selected", "selected", "selected", "selected", "freeText"];
const fixtureQuestionIds = [101, 102, 103, 104, 105];
const root = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "stcirt-results-page-"));
const dbPath = join(tempDir, "fixture.db");
let client;
let server;
let browser;
let cleanupPromise;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function summarize(values) {
  return { p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) };
}

function summarizeValues(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function summarizeBytes(values) {
  return { p50_bytes: percentile(values, 0.5), p95_bytes: percentile(values, 0.95) };
}

function countHeaderValues(records, getValue) {
  const counts = new Map();
  for (const record of records) {
    const value = getValue(record) ?? null;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count }));
}

function summarizeResources(records) {
  return Object.fromEntries(
    ["font", "style", "script"].map((kind) => {
      const resources = records
        .flatMap((record) => record.resource_timings)
        .filter((resource) => resource.kind === kind);
      const byteTotals = Object.fromEntries(
        ["transfer_size_bytes", "encoded_body_size_bytes", "decoded_body_size_bytes"].map(
          (field) => {
            const values = resources.map((resource) => resource[field]).filter(Number.isFinite);
            return [
              field,
              {
                resource_count: resources.length,
                observed_count: values.length,
                missing_count: resources.length - values.length,
                total_bytes: values.reduce((sum, value) => sum + value, 0),
              },
            ];
          },
        ),
      );
      return [kind, { resource_count: resources.length, ...byteTotals }];
    }),
  );
}

function summarizePaintAndLayout(records) {
  const lcpBySample = records.map((record) => record.lcp_entries);
  const lcpLastStartTimes = lcpBySample.map((entries) => {
    const last = entries.at(-1)?.startTime_ms;
    return Number.isFinite(last) ? last : null;
  });
  const shiftsBySample = records.map((record) => record.layout_shift_entries);
  const layoutShiftObserverSupportedCount = records.filter(
    (record) => record.layout_shift_observer_supported,
  ).length;
  const clsSums = shiftsBySample.map((entries) =>
    entries.reduce((sum, entry) => sum + (entry.hadRecentInput ? 0 : entry.value), 0),
  );
  const layoutShiftEntryCount = shiftsBySample.reduce((sum, entries) => sum + entries.length, 0);
  const allLayoutShiftObserversSupported = layoutShiftObserverSupportedCount === records.length;
  return {
    lcp_start_time_ms: {
      ...summarize(lcpLastStartTimes.filter(Number.isFinite)),
      observed_sample_count: lcpLastStartTimes.filter(Number.isFinite).length,
      missing_sample_count: lcpLastStartTimes.filter((value) => !Number.isFinite(value)).length,
      timed_out_count: records.filter((record) => record.lcp_observation.timed_out).length,
      observation_is_bounded: true,
      terminal_lcp_established: false,
    },
    cls_sum_in_observed_window: {
      ...(allLayoutShiftObserversSupported ? summarizeValues(clsSums) : { p50: null, p95: null }),
      sample_count: clsSums.length,
      samples_with_entries: shiftsBySample.filter((entries) => entries.length > 0).length,
      samples_without_entries: shiftsBySample.filter((entries) => entries.length === 0).length,
      entry_count: layoutShiftEntryCount,
      observed_entry_count: layoutShiftEntryCount,
      included_entry_count: shiftsBySample.reduce(
        (sum, entries) => sum + entries.filter((entry) => !entry.hadRecentInput).length,
        0,
      ),
      observation_window_ms: summarize(
        records.map((record) => record.layout_shift_observation_window_ms),
      ),
      observer_supported_sample_count: layoutShiftObserverSupportedCount,
      observer_unsupported_sample_count: records.length - layoutShiftObserverSupportedCount,
      observer_supported_count: layoutShiftObserverSupportedCount,
      observer_unsupported_count: records.length - layoutShiftObserverSupportedCount,
      p50_available: allLayoutShiftObserversSupported,
      observation_is_bounded: true,
    },
  };
}

function summarizeRsc(records) {
  const requests = records.flatMap((record) => record.rsc_requests);
  const observedBodyBytes = requests.map((request) => request.bytes).filter(Number.isFinite);
  const perSampleBodyBytes = records
    .map((record) => {
      const observed = record.rsc_requests.map((request) => request.bytes).filter(Number.isFinite);
      return observed.length > 0 ? observed.reduce((sum, value) => sum + value, 0) : null;
    })
    .filter(Number.isFinite);
  const samplesWithObservedBodyBytes = perSampleBodyBytes.length;
  const missingBodyBytesCount = requests.length - observedBodyBytes.length;
  const allSamplesObserved = samplesWithObservedBodyBytes === records.length;
  const status =
    requests.length === 0
      ? "NOT_OBSERVED"
      : allSamplesObserved && missingBodyBytesCount === 0
        ? "OBSERVED_COMPLETE"
        : "INCONCLUSIVE";
  return {
    status,
    request_count: requests.length,
    observed_request_count: requests.length,
    observed_body_bytes_total: observedBodyBytes.reduce((sum, value) => sum + value, 0),
    body_bytes_read_count: observedBodyBytes.length,
    observed_body_bytes_count: observedBodyBytes.length,
    missing_body_bytes_count: missingBodyBytesCount,
    per_sample_body_bytes: summarizeBytes(perSampleBodyBytes),
    samples_with_observed_body_bytes: samplesWithObservedBodyBytes,
    samples_without_observed_body_bytes: records.length - samplesWithObservedBodyBytes,
    absent_requests_are_not_evidence_of_no_rsc: true,
  };
}

function installResultsHeadingFrameObserver() {
  const navigationStart = performance.getEntriesByType("navigation")[0]?.startTime ?? 0;
  window.__resultsPaintMetrics = {
    ...(window.__resultsPaintMetrics ?? {}),
    navigationStart,
    lcp: window.__resultsPaintMetrics?.lcp ?? [],
    layoutShifts: window.__resultsPaintMetrics?.layoutShifts ?? [],
    layoutShiftObserverSupported:
      window.__resultsPaintMetrics?.layoutShiftObserverSupported ?? false,
    firstResultsHeadingFrameProxyMs: null,
    firstResultsHeadingFrameProxyScheduled: false,
  };
  const isVisible = (element) => {
    if (!element || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility === "visible";
  };
  const recordFirstVisibleResultsHeading = () => {
    const metrics = window.__resultsPaintMetrics;
    if (
      metrics.firstResultsHeadingFrameProxyMs !== null ||
      metrics.firstResultsHeadingFrameProxyScheduled
    )
      return;
    const heading = document.querySelector("#answer-details-heading");
    if (!isVisible(heading)) return;
    metrics.firstResultsHeadingFrameProxyScheduled = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        metrics.firstResultsHeadingFrameProxyScheduled = false;
        if (metrics.firstResultsHeadingFrameProxyMs !== null || !isVisible(heading)) return;
        metrics.firstResultsHeadingFrameProxyMs = performance.now() - navigationStart;
      }),
    );
  };
  const observer = new MutationObserver(recordFirstVisibleResultsHeading);
  observer.observe(document.documentElement ?? document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"],
  });
  recordFirstVisibleResultsHeading();
}

function requestTiming(request) {
  const timing = request.timing();
  const start = timing.requestStart;
  const responseStart = timing.responseStart;
  return start >= 0 && responseStart >= start ? responseStart - start : null;
}

function makeSessionCookie(participantId) {
  const key = createHmac("sha256", SECRET).update(`${SESSION_PURPOSE}\0${PIN}`).digest();
  const encoded = Buffer.from(
    JSON.stringify({ id: participantId, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  const signature = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function applyMigrations(dbClient) {
  const journalPath = join(root, "src/lib/db/migrations/meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  if (journal.dialect !== "sqlite" || !Array.isArray(journal.entries)) {
    throw new Error("Unexpected Drizzle migration journal");
  }
  for (const entry of journal.entries) {
    const sql = await readFile(join(root, "src/lib/db/migrations", `${entry.tag}.sql`), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await dbClient.execute(statement);
  }
}

async function seedDatabase() {
  client = createClient({ url: `file:${dbPath}` });
  await applyMigrations(client);
  await client.batch(
    [
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [1, "owner-synthetic", "合成本人"],
      },
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [2, "target-synthetic", "合成代理対象"],
      },
      {
        sql: "INSERT INTO assisted_participants (owner_participant_id, target_participant_id) VALUES (?, ?)",
        args: [1, 2],
      },
      {
        sql: "INSERT INTO participant_result_settings (id, visible, ever_published) VALUES (?, ?, ?)",
        args: [1, 1, 1],
      },
      {
        sql: "INSERT INTO presentation_sessions (id, state, version, question_index, question_count, snapshot_revision) VALUES (?, ?, ?, ?, ?, ?)",
        args: [1, "finished", 1, 4, 5, 1],
      },
      ...fixtureQuestionIds.map((id, index) => ({
        sql: "INSERT INTO presentation_questions (session_id, position, source_question_id, question, choices, correct_index, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          1,
          index,
          id,
          `合成質問 ${index + 1}`,
          JSON.stringify(index === 4 ? [] : ["選択肢A", "選択肢B"]),
          0,
          null,
        ],
      })),
      ...[1, 2].map((participantId, index) => ({
        sql: "INSERT INTO presentation_entries (session_id, participant_id, display_name, score, rank, answers) VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          1,
          participantId,
          participantId === 1 ? "合成本人" : "合成代理対象",
          index === 0 ? 4 : 3,
          index === 0 ? 1 : 2,
          JSON.stringify(
            fixtureQuestionIds.map((questionId, answerIndex) => ({
              questionId,
              answerKind: ANSWER_KINDS[answerIndex],
              selectedIndex: answerIndex === 4 ? null : 0,
              freeText: answerIndex === 4 ? `合成自由記述 ${participantId}` : null,
              rawScore: answerIndex === 4 ? 0.8 : null,
              normalizedScore: answerIndex === 4 ? 0.8 : null,
            })),
          ),
        ],
      })),
    ],
    "write",
  );
  await client.close();
  client = undefined;
}

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", (error) => {
      const message =
        error.code === "EADDRINUSE"
          ? `Refusing to use occupied ${HOST}:${PORT}`
          : `Could not verify local port ${PORT} is free`;
      reject(new Error(message, { cause: error }));
    });
    probe.listen({ host: HOST, port: PORT, exclusive: true }, () => {
      probe.close((error) => {
        if (error)
          reject(new Error(`Could not release port preflight socket ${PORT}`, { cause: error }));
        else resolve();
      });
    });
  });
}

async function startServer() {
  await assertPortFree();
  const env = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    TURSO_DATABASE_URL: `file:${dbPath}`,
    TURSO_AUTH_TOKEN: "",
    STCIRT_E2E_DB_ISOLATION: "1",
    PARTICIPANT_SESSION_SECRET: SECRET,
    PARTICIPANT_PIN: PIN,
    PARTICIPANT_SESSION_DAYS: "1",
  };
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
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  let readyLogged = false;
  let spawnError;
  let pendingLogLine = "";
  const collectLog = (chunk) => {
    const text = String(chunk);
    logs = `${logs}${text}`.slice(-4000);
    const lines = `${pendingLogLine}${text}`.split(/\r?\n/);
    pendingLogLine = lines.pop() ?? "";
    if (
      lines.some((line) =>
        /\bReady in \d+(?:\.\d+)?\s*(?:ms|s)\b/i.test(line.replace(/\u001b\[[0-9;]*m/g, "")),
      )
    ) {
      readyLogged = true;
    }
  };
  server.stdout.setEncoding("utf8").on("data", collectLog);
  server.stderr.setEncoding("utf8").on("data", collectLog);
  server.once("error", (error) => {
    spawnError = error;
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (spawnError)
      throw new Error("Could not start the isolated Next.js production server", {
        cause: spawnError,
      });
    if (server.exitCode !== null) throw new Error(`Production server exited early:\n${logs}`);
    if (readyLogged) {
      await delay(25);
      if (spawnError)
        throw new Error("Next.js server failed after its Ready log", { cause: spawnError });
      if (server.exitCode !== null)
        throw new Error(`Production server exited after Ready:\n${logs}`);
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the spawned Next.js child Ready log:\n${logs}`);
}

async function runActivityProbe() {
  await seedDatabase();
  await startServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let resultsRequests = 0;
  let mainDocumentRequests = 0;
  let answerPosts = 0;
  let failNextResultsRequest = true;

  await context.addCookies([{ name: COOKIE_NAME, value: makeSessionCookie(1), url: BASE_URL }]);
  await page.addInitScript(installResultsHeadingFrameObserver);
  await page.addInitScript(() => {
    const listeners = new Set();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    Object.defineProperty(window, "__resultsActivityProbeListeners", {
      configurable: false,
      value: listeners,
    });
    document.addEventListener = (type, listener, options) => {
      if (type === "visibilitychange") listeners.add(listener);
      add(type, listener, options);
    };
    document.removeEventListener = (type, listener, options) => {
      if (type === "visibilitychange") listeners.delete(listener);
      remove(type, listener, options);
    };
  });
  page.on("request", (request) => {
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      request.resourceType() === "document"
    ) {
      mainDocumentRequests += 1;
    }
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/participants/results") {
      resultsRequests += 1;
    }
    if (request.method() === "POST" && url.pathname.startsWith("/api/answers/")) {
      answerPosts += 1;
    }
  });
  const allowedAnswerGets = new Set([
    "/api/participants/session",
    "/api/answers/latest",
    "/api/questions/batch",
  ]);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== BASE_URL) {
      await route.abort();
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/participants/results") {
      if (failNextResultsRequest) {
        failNextResultsRequest = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Results are unavailable" }),
        });
      } else {
        await route.continue();
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method() === "GET" && allowedAnswerGets.has(url.pathname)) {
        await route.continue();
      } else {
        await route.abort();
      }
      return;
    }
    await route.continue();
  });

  await page.goto(`${BASE_URL}/results`, { waitUntil: "domcontentloaded" });
  if (mainDocumentRequests !== 1) {
    throw new Error(
      `Expected one initial main-frame document request, observed ${mainDocumentRequests}`,
    );
  }
  await page.getByRole("heading", { name: "あなたの結果" }).waitFor({ state: "visible" });
  await page.locator("#answer-details-heading").waitFor({ state: "visible" });
  await page.getByText("合成質問 1").waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    Number.isFinite(window.__resultsPaintMetrics?.firstResultsHeadingFrameProxyMs),
  );
  await page.waitForFunction(
    () => Reflect.get(window, "__resultsActivityProbeListeners")?.size > 0,
  );
  const activeListenerCount = await page.evaluate(
    () => Reflect.get(window, "__resultsActivityProbeListeners").size,
  );

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const refreshAlertText =
    "結果を更新できませんでした。通信状況を確認して、もう一度お試しください。";
  const refreshAlert = page.getByText(refreshAlertText, { exact: true });
  await refreshAlert.waitFor({ state: "visible" });
  if ((await refreshAlert.innerText()) !== refreshAlertText) {
    throw new Error("Controlled results refresh failure note did not match the application copy");
  }
  if (resultsRequests !== 1) {
    throw new Error(`Expected one controlled results API failure, observed ${resultsRequests}`);
  }

  await page.getByRole("link", { name: "回答画面へ戻る" }).click();
  await page.waitForURL(`${BASE_URL}/answer`);
  if (mainDocumentRequests !== 1) {
    throw new Error(
      "/results to /answer used a main-frame document navigation instead of client navigation",
    );
  }
  await page.waitForFunction(
    (baseline) => Reflect.get(window, "__resultsActivityProbeListeners")?.size === baseline - 1,
    activeListenerCount,
  );
  const requestsBeforeHiddenEvent = resultsRequests;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await delay(250);
  if (resultsRequests !== requestsBeforeHiddenEvent) {
    throw new Error("Results API ran while its route was hidden by Activity");
  }

  const answerDraft = "合成 Activity 保持確認用の未送信回答";
  const answerTextbox = page.getByRole("textbox", {
    name: "回答（1000字以内）",
    exact: true,
  });
  await answerTextbox.waitFor({ state: "visible" });
  await answerTextbox.fill(answerDraft);
  if ((await answerTextbox.inputValue()) !== answerDraft) {
    throw new Error("Could not enter the synthetic free-response draft");
  }
  if (answerPosts !== 0) {
    throw new Error(`Answer API POST occurred before leaving /answer (${answerPosts})`);
  }

  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForURL(`${BASE_URL}/results`);
  if (mainDocumentRequests !== 1) {
    throw new Error(
      "/answer back to /results used a main-frame document navigation instead of client navigation",
    );
  }
  await page.locator("#answer-details-heading").waitFor({ state: "visible" });
  await page.getByText("合成質問 1").waitFor({ state: "visible" });
  await refreshAlert.waitFor({ state: "visible" });
  if ((await refreshAlert.innerText()) !== refreshAlertText) {
    throw new Error(
      "ResultsPanel failure state was not preserved across route Activity navigation",
    );
  }
  await page.waitForFunction(
    (baseline) => Reflect.get(window, "__resultsActivityProbeListeners")?.size === baseline,
    activeListenerCount,
  );
  if (resultsRequests !== 1) {
    throw new Error(
      `Expected Activity return to preserve state without polling; observed ${resultsRequests} requests`,
    );
  }

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refreshAlert.waitFor({ state: "detached" });
  if (resultsRequests !== 2) {
    throw new Error(`Expected one resumed results refresh, observed ${resultsRequests} requests`);
  }

  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.waitForURL(`${BASE_URL}/answer`);
  if (mainDocumentRequests !== 1) {
    throw new Error(
      "/results forward to /answer used a main-frame document navigation instead of client navigation",
    );
  }
  await answerTextbox.waitFor({ state: "visible" });
  if ((await answerTextbox.inputValue()) !== answerDraft) {
    throw new Error("Synthetic free-response draft was not preserved across /results Activity");
  }
  if (answerPosts !== 0) {
    throw new Error(`Answer API POST occurred during the unsent-draft probe (${answerPosts})`);
  }

  await context.close();
  process.stdout.write(
    "[results-activity-probe] PASS: client navigation preserved authenticated synthetic ResultsPanel state and unsent answer draft; hidden effect stopped and active effect resumed; no answer POST occurred.\n",
  );
}

async function captureNavigation(context, scope, label) {
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === BASE_URL) await route.continue();
    else await route.abort();
  });
  await page.addInitScript(installResultsHeadingFrameObserver);
  await page.addInitScript(() => {
    window.__resultsPaintMetrics ??= { lcp: [], layoutShifts: [] };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === "first-contentful-paint") {
            window.__resultsPaintMetrics.fcpStartTimeMs = entry.startTime;
          }
        }
      }).observe({ type: "paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__resultsPaintMetrics.lcp.push({
            startTime_ms: entry.startTime,
            renderTime_ms: entry.renderTime,
            loadTime_ms: entry.loadTime,
            size: entry.size,
            url: entry.url,
          });
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
    try {
      const layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__resultsPaintMetrics.layoutShifts.push({
            startTime_ms: entry.startTime,
            value: entry.value,
            hadRecentInput: entry.hadRecentInput,
          });
        }
      });
      layoutShiftObserver.observe({ type: "layout-shift", buffered: true });
      window.__resultsPaintMetrics.layoutShiftObserverSupported = true;
    } catch {}
    const addDocumentListener = document.addEventListener.bind(document);
    window.__resultsVisibilityListenerReady = false;
    document.addEventListener = (type, listener, options) => {
      addDocumentListener(type, listener, options);
      if (type === "visibilitychange") window.__resultsVisibilityListenerReady = true;
    };
  });
  await context.addCookies([{ name: COOKIE_NAME, value: makeSessionCookie(1), url: BASE_URL }]);
  const rscBodyReads = [];
  page.on("response", (response) => {
    const request = response.request();
    if (new URL(response.url()).searchParams.has("_rsc")) {
      rscBodyReads.push(
        (async () => {
          let bytes = null;
          try {
            bytes = (await response.body()).byteLength;
          } catch {}
          return { status: response.status(), bytes, ttfb_proxy_ms: requestTiming(request) };
        })(),
      );
    }
  });
  const url = `${BASE_URL}/results${scope === "assisted" ? "?scope=assisted" : ""}`;
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!response) throw new Error(`${label}/${scope}: navigation returned no document response`);
  const body = await response.body();
  const documentHeaders = await response.allHeaders();
  if (response.status() !== 200) {
    throw new Error(`${label}/${scope}: expected HTTP 200, got ${response.status()}`);
  }
  const expectedName = scope === "owner" ? "あなたの結果" : "代理回答者の結果";
  await page
    .getByRole("heading", { name: expectedName, exact: true })
    .waitFor({ state: "visible" });
  await page.locator("#answer-details-heading").waitFor({ state: "visible" });
  await page.getByText("合成質問 1", { exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => window.__resultsVisibilityListenerReady === true);
  const browserMetrics = await page.evaluate(async () => {
    const fontsStart = performance.now();
    await document.fonts.ready;
    const documentFontsReadyMs = performance.now() - fontsStart;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const lcpQuietWindowMs = 500;
    const lcpObservationTimeoutMs = 3000;
    let observedLcpCount = window.__resultsPaintMetrics.lcp.length;
    let lastLcpChangeMs = performance.now();
    const lcpWaitStartedMs = performance.now();
    while (
      performance.now() - lcpWaitStartedMs < lcpObservationTimeoutMs &&
      performance.now() - lastLcpChangeMs < lcpQuietWindowMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (window.__resultsPaintMetrics.lcp.length !== observedLcpCount) {
        observedLcpCount = window.__resultsPaintMetrics.lcp.length;
        lastLcpChangeMs = performance.now();
      }
    }
    const lcpObservationEndedMs = performance.now();
    const resourceTimings = performance
      .getEntriesByType("resource")
      .filter((entry) => /\.(?:woff2?|ttf|otf|m?js|css)(?:$|\?)/i.test(entry.name))
      .map((entry) => ({
        url: new URL(entry.name).pathname,
        kind: /\.(?:woff2?|ttf|otf)(?:$|\?)/i.test(entry.name)
          ? "font"
          : /\.css(?:$|\?)/i.test(entry.name)
            ? "style"
            : "script",
        initiator_type: entry.initiatorType,
        transfer_size_bytes: entry.transferSize,
        encoded_body_size_bytes: entry.encodedBodySize,
        decoded_body_size_bytes: entry.decodedBodySize,
        duration_ms: entry.duration,
      }));
    return {
      document_fonts_ready_ms: documentFontsReadyMs,
      first_contentful_paint_ms:
        window.__resultsPaintMetrics.fcpStartTimeMs ??
        performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
        null,
      first_results_heading_frame_proxy_ms:
        window.__resultsPaintMetrics.firstResultsHeadingFrameProxyMs,
      layout_shift_observer_supported: window.__resultsPaintMetrics.layoutShiftObserverSupported,
      lcp_observation: {
        duration_ms: lcpObservationEndedMs - window.__resultsPaintMetrics.navigationStart,
        quiet_window_ms: lcpQuietWindowMs,
        timed_out: lcpObservationEndedMs - lcpWaitStartedMs >= lcpObservationTimeoutMs,
        terminal_lcp_established: false,
      },
      resource_timings: resourceTimings,
      lcp_entries: window.__resultsPaintMetrics.lcp,
      layout_shift_observation_window_ms:
        lcpObservationEndedMs - window.__resultsPaintMetrics.navigationStart,
      layout_shift_entries: window.__resultsPaintMetrics.layoutShifts,
    };
  });
  const rsc = await Promise.all(rscBodyReads);
  const navigation = {
    sample: label,
    scope,
    status: response.status(),
    document_body_decoded_bytes: body.byteLength,
    document_response_content_length_header: documentHeaders["content-length"] ?? null,
    document_response_content_encoding_header: documentHeaders["content-encoding"] ?? null,
    response_start_ttfb_proxy_ms: requestTiming(response.request()),
    ...browserMetrics,
    rsc_requests: rsc,
    layout_shift_observer_supported: browserMetrics.layout_shift_observer_supported,
  };

  const resultResponsePromise = page.waitForResponse(
    (item) => item.url().includes("/api/participants/results") && item.request().method() === "GET",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const apiResponse = await resultResponsePromise;
  const apiBody = await apiResponse.body();
  const apiHeaders = await apiResponse.allHeaders();
  navigation.visibility_refresh = {
    status: apiResponse.status(),
    body_decoded_bytes: apiBody.byteLength,
    response_content_length_header: apiHeaders["content-length"] ?? null,
    response_content_encoding_header: apiHeaders["content-encoding"] ?? null,
    response_start_ttfb_proxy_ms: requestTiming(apiResponse.request()),
  };
  return { page, navigation };
}

async function measure() {
  await seedDatabase();
  await startServer();
  browser = await chromium.launch({ headless: true });
  const records = [];
  for (const scope of ["owner", "assisted"]) {
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const context = await browser.newContext();
      const { page, navigation } = await captureNavigation(
        context,
        scope,
        `fresh-context-${sample + 1}`,
      );
      records.push(navigation);
      await page.close();
      await context.close();
    }

    const warmContext = await browser.newContext();
    const first = await captureNavigation(warmContext, scope, "reload-primer");
    await first.page.close();
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const { page, navigation } = await captureNavigation(
        warmContext,
        scope,
        `reload-${sample + 1}`,
      );
      records.push(navigation);
      await page.close();
    }
    await warmContext.close();
  }

  const groups = {};
  for (const scope of ["owner", "assisted"]) {
    for (const cacheState of ["fresh-context", "reload"]) {
      const expectedLabels = Array.from({ length: SAMPLE_COUNT }, (_, index) =>
        cacheState === "reload" ? `reload-${index + 1}` : `fresh-context-${index + 1}`,
      );
      const expectedLabelSet = new Set(expectedLabels);
      const selected = records.filter(
        (record) => record.scope === scope && expectedLabelSet.has(record.sample),
      );
      const selectedLabels = new Set(selected.map((record) => record.sample));
      if (
        selected.length !== SAMPLE_COUNT ||
        selectedLabels.size !== SAMPLE_COUNT ||
        expectedLabels.some((label) => !selectedLabels.has(label))
      ) {
        throw new Error(
          `Expected exactly ${SAMPLE_COUNT} ${scope}/${cacheState} navigation samples; observed labels: ${[...selectedLabels].join(", ")}`,
        );
      }
      groups[`${scope}_${cacheState.replaceAll("-", "_")}`] = {
        sample_count: selected.length,
        document_body_decoded_bytes: summarizeBytes(
          selected.map((item) => item.document_body_decoded_bytes),
        ),
        document_body_decoded_observed_sample_count: selected.filter((item) =>
          Number.isFinite(item.document_body_decoded_bytes),
        ).length,
        response_start_ttfb_proxy_ms: summarize(
          selected.map((item) => item.response_start_ttfb_proxy_ms).filter(Number.isFinite),
        ),
        response_start_ttfb_proxy_observed_sample_count: selected.filter((item) =>
          Number.isFinite(item.response_start_ttfb_proxy_ms),
        ).length,
        visibility_refresh_bytes: summarizeBytes(
          selected.map((item) => item.visibility_refresh.body_decoded_bytes),
        ),
        visibility_refresh_ttfb_proxy_ms: summarize(
          selected
            .map((item) => item.visibility_refresh.response_start_ttfb_proxy_ms)
            .filter(Number.isFinite),
        ),
        response_header_value_counts: {
          document_content_length: countHeaderValues(
            selected,
            (item) => item.document_response_content_length_header,
          ),
          document_content_encoding: countHeaderValues(
            selected,
            (item) => item.document_response_content_encoding_header,
          ),
          visibility_refresh_content_length: countHeaderValues(
            selected,
            (item) => item.visibility_refresh.response_content_length_header,
          ),
          visibility_refresh_content_encoding: countHeaderValues(
            selected,
            (item) => item.visibility_refresh.response_content_encoding_header,
          ),
        },
        ...summarizePaintAndLayout(selected),
        first_contentful_paint_ms: {
          ...summarize(
            selected.map((item) => item.first_contentful_paint_ms).filter(Number.isFinite),
          ),
          observed_sample_count: selected.filter((item) =>
            Number.isFinite(item.first_contentful_paint_ms),
          ).length,
        },
        first_results_heading_frame_proxy_ms: {
          ...summarize(
            selected
              .map((item) => item.first_results_heading_frame_proxy_ms)
              .filter(Number.isFinite),
          ),
          observed_sample_count: selected.filter((item) =>
            Number.isFinite(item.first_results_heading_frame_proxy_ms),
          ).length,
        },
        resource_byte_totals_by_kind: summarizeResources(selected),
        rsc: summarizeRsc(selected),
        rsc_requests: selected.flatMap((item) => item.rsc_requests),
      };
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        measurement: "local_synthetic_results_ssr",
        first_results_heading_frame_proxy_definition:
          "Navigation-relative performance.now() recorded on the second nested requestAnimationFrame after #answer-details-heading has non-empty client rects and computed display/visibility indicate visible; this is a two-RAF visibility proxy, not a paint timestamp.",
        base_url: BASE_URL,
        database: "disposable_file_backed_sqlite",
        fixture:
          "two synthetic participants, one assisted link, five immutable presentation questions and result entries",
        limits: [
          "Document and visibility-refresh decoded body sizes are separate from Content-Length and Content-Encoding response headers.",
          "Content-Length is not a measure of total wire bytes; it may describe encoded representation size and excludes transport framing.",
          "TTFB is Playwright request.timing() responseStart minus requestStart on local loopback, not remote latency.",
          "Fresh context means a new browser context and client cache only; server, OS and Next.js caches may remain warm.",
          "Reload means repeated navigation in one browser context; Next dynamic rendering still executes for every request.",
          "First results heading uses a navigation-relative two-requestAnimationFrame visibility proxy, not a paint timestamp. LCP observation waits for a 500 ms quiet window after fonts and two animation frames, capped at 3000 ms; terminal LCP is not established. CLS entries are observed from pre-navigation observer setup through that same explicit capture end, and neither metric is a production-user metric.",
          "Resource timing lists font, script and style transfer/encoded/decoded sizes when exposed by the browser; zero may indicate a cache hit or unavailable transfer size.",
          "Visibility refresh is explicitly triggered after hydration; it is a synthetic local API request.",
          "RSC requests are listed only when observed during document navigation; absence does not measure all client transitions.",
          "No production participant data, .env.local database, remote Turso, or external network is used.",
        ],
        groups,
        samples: records,
      },
      null,
      2,
    )}\n`,
  );
}

function cleanupResources() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      if (browser) await browser.close().catch(() => {});
      if (client) await client.close().catch(() => {});
      if (server && server.exitCode === null) {
        server.kill("SIGTERM");
        await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(5000)]);
        if (server.exitCode === null) {
          server.kill("SIGKILL");
          await new Promise((resolve) => server.once("exit", resolve));
        }
      }
      await rm(tempDir, { recursive: true, force: true });
    })();
  }
  return cleanupPromise;
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanupResources().then(
      () => process.exit(exitCode),
      () => process.exit(exitCode),
    );
  });
}

try {
  if (process.argv.includes("--activity-probe")) await runActivityProbe();
  else await measure();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await cleanupResources();
}
