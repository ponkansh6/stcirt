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
  const lcpStartTimes = lcpBySample.flatMap((entries) =>
    entries.map((entry) => entry.startTime_ms).filter(Number.isFinite),
  );
  const shiftsBySample = records.map((record) => record.layout_shift_entries);
  const clsSums = shiftsBySample.map((entries) =>
    entries.reduce((sum, entry) => sum + (entry.hadRecentInput ? 0 : entry.value), 0),
  );
  const layoutShiftEntryCount = shiftsBySample.reduce((sum, entries) => sum + entries.length, 0);
  return {
    lcp_start_time_ms: {
      ...summarize(lcpStartTimes),
      observed_entry_count: lcpStartTimes.length,
      missing_sample_count: lcpBySample.filter((entries) => entries.length === 0).length,
      observation_is_bounded: true,
      terminal_lcp_established: false,
    },
    cls_sum_in_observed_window: {
      ...summarizeValues(clsSums),
      sample_count: clsSums.length,
      samples_with_entries: shiftsBySample.filter((entries) => entries.length > 0).length,
      samples_without_entries: shiftsBySample.filter((entries) => entries.length === 0).length,
      observed_entry_count: layoutShiftEntryCount,
      included_entry_count: shiftsBySample.reduce(
        (sum, entries) => sum + entries.filter((entry) => !entry.hadRecentInput).length,
        0,
      ),
      observation_window_ms: summarize(
        records.map((record) => record.layout_shift_observation_window_ms),
      ),
      observation_is_bounded: true,
    },
  };
}

function summarizeRsc(records) {
  const requests = records.flatMap((record) => record.rsc_requests);
  const observedBodyBytes = requests.map((request) => request.bytes).filter(Number.isFinite);
  return {
    observed_request_count: requests.length,
    observed_body_bytes_total: observedBodyBytes.reduce((sum, value) => sum + value, 0),
    observed_body_bytes_count: observedBodyBytes.length,
    missing_body_bytes_count: requests.length - observedBodyBytes.length,
    absent_requests_are_not_evidence_of_no_rsc: true,
  };
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
  try {
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(750) });
    throw new Error(`Refusing to use occupied ${BASE_URL} (HTTP ${response.status})`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing to use occupied")) throw error;
    if (error?.name !== "TimeoutError" && error?.cause?.code !== "ECONNREFUSED") {
      throw new Error(`Could not verify local port ${PORT} is free`, { cause: error });
    }
  }
}

async function startServer() {
  await assertPortFree();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    TURSO_DATABASE_URL: `file:${dbPath}`,
    TURSO_AUTH_TOKEN: "local-synthetic-no-auth-token",
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
  server.stdout.setEncoding("utf8").on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-4000);
  });
  server.stderr.setEncoding("utf8").on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-4000);
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Production server exited early:\n${logs}`);
    try {
      const response = await fetch(`${BASE_URL}/results`, {
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      });
      if (response.status > 0) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for production server:\n${logs}`);
}

async function captureNavigation(context, scope, label) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__resultsPaintMetrics = {
      startedAt: performance.now(),
      lcp: [],
      layoutShifts: [],
    };
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
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__resultsPaintMetrics.layoutShifts.push({
            startTime_ms: entry.startTime,
            value: entry.value,
            hadRecentInput: entry.hadRecentInput,
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
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
  if (!(await page.locator("main").innerText()).includes(expectedName)) {
    throw new Error(`${label}/${scope}: synthetic result was not present in rendered page`);
  }
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
      lcp_observation: {
        duration_ms: lcpObservationEndedMs - window.__resultsPaintMetrics.startedAt,
        quiet_window_ms: lcpQuietWindowMs,
        timed_out: lcpObservationEndedMs - lcpWaitStartedMs >= lcpObservationTimeoutMs,
        terminal_lcp_established: false,
      },
      resource_timings: resourceTimings,
      lcp_entries: window.__resultsPaintMetrics.lcp,
      layout_shift_observation_window_ms:
        lcpObservationEndedMs - window.__resultsPaintMetrics.startedAt,
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
      const selected = records.filter(
        (record) => record.scope === scope && record.sample.startsWith(cacheState),
      );
      groups[`${scope}_${cacheState.replaceAll("-", "_")}`] = {
        sample_count: selected.length,
        document_body_decoded_bytes: summarizeBytes(
          selected.map((item) => item.document_body_decoded_bytes),
        ),
        response_start_ttfb_proxy_ms: summarize(
          selected.map((item) => item.response_start_ttfb_proxy_ms).filter(Number.isFinite),
        ),
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
          "LCP observation waits for a 500 ms quiet window after fonts and two animation frames, capped at 3000 ms; terminal LCP is not established. CLS entries are observed from pre-navigation observer setup through that same explicit capture end, and neither metric is a production-user metric.",
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

try {
  await measure();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
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
}
