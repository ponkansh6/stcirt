/*
 * Plan 71 presentation-latency runner. This revision changes the legacy output:
 * all samples default to at least 30, metrics include browser-clock POST timings,
 * boundary/burst and synthetic-fixture coverage scenarios, and per-operation
 * failures/missing counts. Mock-only boundary, delay/failure, and deck payload
 * scenarios are explicitly not applicable in real-route mode.
 * Legacy latency values are not directly comparable: interaction intervals use
 * browser performance clocks and host navigation intervals use Node monotonic time.
 * Both modes own only 127.0.0.1:3001 and use a disposable SQLite fixture.
 * Mock mode intercepts app APIs; real mode exercises the app's real routes.
 * DOM mutation plus two rAF callbacks is a paint proxy. GETs overlapping an
 * interaction remain window counts because poll causality cannot be separated.
 * Fetch instrumentation supports the current screen's plain string URL POST;
 * it observes fetch only and does not measure non-fetch transport paths.
 * Burst inputs are synthetic; unmatched_busy_input_count is a proxy, not a
 * complete count of physical user inputs lost. Successful samples can be fewer than 30.
 * Presenter click always advances; previous is keyboard/swipe only.
 * Previous samples start at answer and measure the answer-to-question transition;
 * the inverse probe advances back toward answer after the primary measurement.
 * Run mock with node scripts/measure-presentation-latency.mjs
 * Run real with PRESENTATION_BENCH_MODE=real node scripts/measure-presentation-latency.mjs
 */
import { chromium } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, release, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createClient } from "@libsql/client";
import { setTimeout as timerDelay } from "node:timers/promises";

const mode = process.env.PRESENTATION_BENCH_MODE ?? "mock";
const baseUrl = "http://127.0.0.1:3001";
const pin = "7316";
const sampleRepeats = Math.max(30, positiveInteger(process.env.PRESENTATION_BENCH_SAMPLES, 30));
const mockDelayMs = nonNegativeInteger(process.env.PRESENTATION_BENCH_DELAY_MS, 50);
const host = "127.0.0.1";
const port = 3001;
let tempDir;
let dbPath;
let artifactDir;
const adminSecret = "presentation-latency-benchmark-session-secret-not-for-production";
let localServer;
let localServerReady = false;
let localServerSpawnError = null;
let dbClient;
let browserInstance;
let contextInstance;
let browserLaunchAttempted = false;
const visualArtifacts = { before: null, after: null };
let sourceFingerprint = null;

if (!new Set(["mock", "real"]).has(mode)) {
  process.stderr.write("PRESENTATION_BENCH_MODE must be mock or real\n");
  process.exit(2);
}
if (process.env.BASE_URL) {
  process.stderr.write("BASE_URL is forbidden; the runner owns its isolated loopback server\n");
  process.exit(2);
}
const states = [
  "not_started",
  "question",
  "answer",
  "podium_preview",
  "third",
  "second",
  "first",
  "finished",
];
const question = {
  id: 11,
  question: "ふたりが初めて出会った場所は？",
  choices: ["カフェ", "大学", "駅"],
  correctAnswer: "大学",
  explanation: "共通の友人が開いた集まりで出会いました。",
};
const visualArtifactQuestionTitle =
  mode === "real" ? `${question.question} [visual ${randomUUID()}]` : question.question;
let realFixtureQuestionTitle = question.question;
const entries = [
  { displayName: "花子", score: 1, rank: 1 },
  { displayName: "太郎", score: 0, rank: 2 },
];
const samples = new Map();
const requestCountSamples = new Map();
const browserResourceTimingWindows = {};
const definitions = [
  { name: "keyboard_advance", input: "keyboard", action: "advance" },
  { name: "keyboard_previous", input: "keyboard", action: "previous" },
  { name: "click_advance", input: "click", action: "advance" },
  { name: "swipe_advance", input: "swipe", action: "advance" },
  { name: "swipe_previous", input: "swipe", action: "previous" },
];
const operationFailures = new Map(definitions.map(({ name }) => [name, []]));
const operationFailureDetails = new Map(definitions.map(({ name }) => [name, []]));
let currentStage = "initialization";

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function summary(values, expectedCount = sampleRepeats) {
  return {
    n: values.length,
    missing_count: Math.max(0, expectedCount - values.length),
    outlier_count: outlierCount(values),
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
  };
}

function countSummary(values) {
  return {
    n: values.length,
    missing_count: Math.max(0, sampleRepeats - values.length),
    outlier_count: outlierCount(values),
    p50_count: percentile(values, 0.5),
    p95_count: percentile(values, 0.95),
  };
}

function outlierCount(values) {
  if (values.length < 4) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const spread = q3 - q1;
  return values.filter((value) => value < q1 - 1.5 * spread || value > q3 + 1.5 * spread).length;
}

function addSample(name, metric, value) {
  let byMetric = samples.get(name);
  if (!byMetric) {
    byMetric = new Map();
    samples.set(name, byMetric);
  }
  let values = byMetric.get(metric);
  if (!values) {
    values = [];
    byMetric.set(metric, values);
  }
  values.push(value);
}

function createOperationTracker() {
  let resolveFirstPost;
  let resolveSecondPost;
  const tracker = {
    requests: [],
    posts: [],
    firstPost: new Promise((resolve) => {
      resolveFirstPost = resolve;
    }),
    secondPost: new Promise((resolve) => {
      resolveSecondPost = resolve;
    }),
  };
  tracker.recordRequest = (record) => {
    tracker.requests.push(record);
    if (record.kind !== "post") return;
    tracker.posts.push(record);
    if (tracker.posts.length === 1) resolveFirstPost(record);
    if (tracker.posts.length === 2) resolveSecondPost(record);
  };
  return tracker;
}

async function withTimeout(promise, ms, message) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function dispatchSingleInverseInput(page, tracker, key) {
  tracker.probeAttempts = 1;
  const input = await page.evaluate((probeKey) => {
    const target = document.querySelector("main");
    if (!target) return null;
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: probeKey, bubbles: true, cancelable: true }),
    );
    const id = window.__presentationBench?.lastInputId ?? null;
    const recorded = window.__presentationBench?.inputs?.find(({ id: inputId }) => inputId === id);
    return recorded ? { id: recorded.id, at: recorded.at } : null;
  }, key);
  if (!input || !Number.isFinite(input.id) || !Number.isFinite(input.at)) {
    throw new Error("inverse_probe_input_unavailable");
  }
  tracker.probeInputIds = [input.id];
  return input;
}

async function collectBrowserResourceTimings(page, windowName) {
  browserResourceTimingWindows[windowName] = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => {
        const type = entry.initiatorType;
        return ["script", "link", "css", "font"].includes(type);
      })
      .map((entry) => {
        const url = new URL(entry.name);
        const resourceType =
          entry.initiatorType === "script"
            ? "script"
            : entry.initiatorType === "font"
              ? "font"
              : entry.initiatorType === "css"
                ? "stylesheet"
                : url.pathname.endsWith(".css")
                  ? "stylesheet"
                  : url.pathname.match(/\.(woff2?|ttf|otf)(?:$|\?)/i)
                    ? "font"
                    : null;
        if (!resourceType) return null;
        const timing = {
          resource_type: resourceType,
          pathname: url.pathname,
          transfer_size_bytes: entry.transferSize ?? null,
          encoded_body_size_bytes: entry.encodedBodySize ?? null,
          decoded_body_size_bytes: entry.decodedBodySize ?? null,
          duration_ms: entry.duration ?? null,
          response_end_ms: entry.responseEnd ?? null,
          next_hop_protocol: entry.nextHopProtocol || null,
        };
        timing.transfer_observation =
          timing.transfer_size_bytes === 0
            ? "zero_reported_cache_or_reuse_possible_not_proven"
            : timing.transfer_size_bytes > 0
              ? "browser_reports_transfer"
              : "unknown_or_unavailable";
        return timing;
      })
      .filter(Boolean),
  );
}

async function collectEnvironmentMetadata(page, browser) {
  const packageManifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const nextManifest = JSON.parse(
    await readFile(join(process.cwd(), "node_modules/next/package.json"), "utf8"),
  );
  const playwrightManifest = JSON.parse(
    await readFile(join(process.cwd(), "node_modules/@playwright/test/package.json"), "utf8"),
  );
  let buildId = null;
  try {
    buildId = (await readFile(join(process.cwd(), ".next/BUILD_ID"), "utf8")).trim();
  } catch {}
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  const browserDevice = await page.evaluate(() => ({
    user_agent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight },
    device_pixel_ratio: devicePixelRatio,
    screen: { width: screen.width, height: screen.height },
  }));
  return {
    commit,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    package: {
      name: packageManifest.name ?? null,
      version: packageManifest.version ?? null,
      next: nextManifest.version ?? null,
      next_requested:
        packageManifest.dependencies?.next ?? packageManifest.devDependencies?.next ?? null,
      playwright: playwrightManifest.version ?? null,
    },
    browser: { engine: "chromium", version: browser.version(), ...browserDevice },
    device: {
      platform: process.platform,
      os_release: release(),
      architecture: process.arch,
      cpu_count: cpus().length,
      cpu_model: cpus()[0]?.model ?? null,
      viewport: browserDevice.viewport,
      device_pixel_ratio: browserDevice.device_pixel_ratio,
      screen: browserDevice.screen,
      refresh_rate_hz: null,
      refresh_rate_note: "Not exposed by the Playwright browser context.",
    },
    server: {
      ownership: "script-managed child process",
      command: "next start",
      hostname: host,
      port,
      address: `${host}:${port}`,
      base_url: baseUrl,
      pid: localServer?.pid ?? null,
      build_id: buildId,
      route_mode: mode === "real" ? "real_routes" : "mock_intercepts",
    },
    database: {
      engine: "SQLite via local libsql file URL",
      mode:
        mode === "real"
          ? "isolated_disposable_sqlite_real_routes"
          : "isolated_disposable_sqlite_with_mocked_app_api_routes",
      isolated_temp_file: true,
      auth_token_empty: process.env.TURSO_AUTH_TOKEN === "",
      route_mode: mode === "real" ? "real_routes" : "mock_intercepts",
      active_temp_fixture_verified_after_server_start: mode === "real" && localServerReady,
      query_count: null,
      query_count_status: "not_instrumented",
    },
    refresh: {
      real_mode: "presenter reload after each synthetic DB reset",
      mock_mode: "same-page route fixture reset between samples",
      browser_cache: "not explicitly cleared; primary actions are warm after startup",
    },
    mock_delay_ms: mockDelayMs,
    sample_temperature: {
      startup: "separate initial page and login path",
      cold_sample: "startup/deck navigation recorded separately before primary operations",
      primary_operations: "warm, repeated minimum 30 times per operation",
      mock_primary_route_delay_ms: mockDelayMs,
      real_primary_route_delay_ms: null,
    },
  };
}

async function captureVisualArtifact(page, label, expectedQuestionTitle) {
  if (!artifactDir)
    artifactDir = await mkdtemp(join(tmpdir(), "stcirt-presentation-latency-visual-"));
  const heading = page.getByRole("heading", { name: expectedQuestionTitle, exact: true });
  await heading.waitFor({ state: "visible", timeout: 10_000 });
  const questionTitle = (await heading.textContent())?.trim() ?? null;
  if (questionTitle !== expectedQuestionTitle) throw new Error("artifact_question_title_mismatch");
  const path = join(artifactDir, `${label}.png`);
  await page.screenshot({ path, animations: "disabled" });
  return { path, question_title: questionTitle };
}

async function captureCoreOperationAfterArtifact(page, mockFixture) {
  const expectedQuestionTitle = visualArtifactQuestionTitle;
  if (mode === "real") {
    const client = createIsolatedDbClient();
    try {
      await client.execute({
        sql: "UPDATE presentation_questions SET question = ? WHERE session_id = 1 AND position = 0",
        args: [expectedQuestionTitle],
      });
      await client.execute(
        "UPDATE presentation_sessions SET state = 'question', question_index = 0, version = version + 1, projection_hidden = 0 WHERE id = 1",
      );
    } finally {
      await client.close();
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: expectedQuestionTitle, exact: true })
      .waitFor({ timeout: 10_000 });
    await assertRealStateSync(page, "question", expectedQuestionTitle, 0);
    await page.locator("main").press("ArrowRight");
    await assertRealStateSync(page, "answer", expectedQuestionTitle, 0);
  } else {
    mockFixture.setState("question");
    mockFixture.setDeckScenario("default");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: question.question, exact: true }).waitFor();
    await page
      .locator('[role="status"][aria-live="polite"]')
      .filter({ hasText: "第1問" })
      .waitFor({ timeout: 10_000 });
    await page.locator("main").press("ArrowRight");
    await page
      .locator('[role="status"][aria-live="polite"]')
      .filter({ hasText: "第1問の解説" })
      .waitFor({ timeout: 10_000 });
    const state = await page.evaluate(async () => {
      const [controlsResponse, projectionResponse] = await Promise.all([
        fetch("/api/admin/presentation?view=controls", { cache: "no-store" }),
        fetch("/api/presentation", { cache: "no-store" }),
      ]);
      return {
        controls: (await controlsResponse.json()).state,
        projection: (await projectionResponse.json()).state,
      };
    });
    if (state.controls !== "answer" || state.projection !== "answer") {
      throw new Error("artifact_core_operation_state_mismatch");
    }
  }
  return captureVisualArtifact(page, "after", expectedQuestionTitle);
}

async function performUnmeasuredKeyboardAction(page, key, setActiveOperation) {
  const tracker = createOperationTracker();
  setActiveOperation(tracker);
  await page.locator("main").press(key);
  await withTimeout(tracker.firstPost, 10_000, "primary_action_not_started");
  await waitForOperationQuiet(tracker);
  setActiveOperation(null);
}

function makeControls(
  state,
  version,
  hidden,
  snapshotRevision,
  questionCount = 1,
  questionIndex = 0,
) {
  return {
    state,
    version,
    snapshotRevision,
    questionIndex,
    questionCount,
    projectionHidden: hidden,
  };
}

function makeDeck(snapshotRevision, scenario = "default") {
  if (scenario === "empty") return { snapshotRevision, slides: [] };
  if (scenario === "large_long_text") {
    const longText = "Synthetic long presenter question. ".repeat(128);
    return {
      snapshotRevision,
      slides: Array.from({ length: 100 }, (_, index) => ({
        state: "question",
        questionIndex: index,
        projection: {
          state: "question",
          question: {
            id: index + 1,
            ordinal: index + 1,
            total: 100,
            question: `${longText} [item ${index + 1}]`,
            choices: question.choices,
          },
        },
      })),
    };
  }
  const slides = ["question", "answer", "podium_preview", "third", "second", "first", "finished"];
  return {
    snapshotRevision,
    slides: slides.map((state) => {
      let projection;
      if (state === "question" || state === "answer") {
        projection = {
          state,
          question: {
            id: question.id,
            ordinal: 1,
            total: 1,
            question: question.question,
            choices: question.choices,
            ...(state === "answer"
              ? {
                  correctAnswer: question.correctAnswer,
                  correctIndex: 1,
                  explanation: question.explanation,
                }
              : {}),
          },
        };
      } else if (["third", "second", "first"].includes(state)) {
        const rank = state === "third" ? 3 : state === "second" ? 2 : 1;
        projection = {
          state,
          winners: entries
            .filter((entry) => entry.rank === rank)
            .map(({ displayName, score, rank: winnerRank }) => ({
              displayName,
              score,
              rank: winnerRank,
            })),
        };
      } else {
        projection = { state };
      }
      return { state, questionIndex: 0, projection };
    }),
  };
}

async function installMock(context) {
  let authenticated = false;
  let state = "not_started";
  let cursor = 0;
  let questionIndex = 0;
  let version = 0;
  let hidden = false;
  let snapshotRevision = 1;
  let deckScenario = "default";
  let nextPostBehavior = null;

  const delay = async () => {
    if (mockDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
  };
  const fulfill = async (route, json, status = 200) => {
    await delay();
    await route.fulfill({ status, json });
  };

  await context.route("**/api/admin/session", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await fulfill(route, { authenticated });
    } else if (request.method() === "POST") {
      // Keep the real login endpoint so the running app issues its normal auth cookie.
      const body = request.postDataJSON();
      await delay();
      await route.fallback();
      authenticated = body.pin === pin;
    } else if (request.method() === "DELETE") {
      authenticated = false;
      await fulfill(route, { authenticated });
    } else {
      await fulfill(route, { error: "Method not allowed" }, 405);
    }
  });

  await context.route("**/api/admin/presentation/deck", async (route) => {
    await fulfill(route, makeDeck(snapshotRevision, deckScenario));
  });

  await context.route(
    (url) => url.pathname === "/api/admin/presentation",
    async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        if (!authenticated) {
          await fulfill(route, { error: "Unauthorized" }, 401);
          return;
        }
        const url = new URL(request.url());
        if (url.searchParams.get("view") === "controls") {
          const questionCount =
            deckScenario === "empty" ? 0 : deckScenario === "large_long_text" ? 100 : 1;
          await fulfill(
            route,
            makeControls(state, version, hidden, snapshotRevision, questionCount, questionIndex),
          );
        } else {
          await fulfill(route, {
            ...makeControls(state, version, hidden, snapshotRevision, 1, questionIndex),
            questions: [question],
            entries,
            participantResultsVisible: false,
            participantResultsReady: snapshotRevision > 0,
          });
        }
        return;
      }

      const body = request.postDataJSON();
      if (!authenticated || !body.operationId) {
        await fulfill(route, { error: "Unauthorized" }, 401);
        return;
      }
      const postBehavior = nextPostBehavior;
      nextPostBehavior = null;
      if (postBehavior?.releasePromise) await postBehavior.releasePromise;
      else if (postBehavior?.delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, postBehavior.delayMs));
      if (postBehavior?.status) {
        await route.fulfill({
          status: postBehavior.status,
          json: { error: "Synthetic benchmark failure" },
        });
        return;
      }
      if (body.action === "position") {
        if (
          body.expectedSnapshotRevision !== snapshotRevision ||
          !Number.isInteger(body.expectedSnapshotRevision)
        ) {
          await fulfill(route, { error: "Presentation snapshot changed concurrently" }, 409);
          return;
        }
        if (
          body.expectedSessionVersion !== version ||
          !Number.isInteger(body.expectedSessionVersion)
        ) {
          await fulfill(route, { error: "Presentation session version changed concurrently" }, 409);
          return;
        }
        const positionStates = [
          "opening",
          "question",
          "answer",
          "podium_preview",
          "third",
          "second",
          "first",
          "finished",
        ];
        if (
          state === "not_started" ||
          !positionStates.includes(body.state) ||
          body.questionIndex !== 0
        ) {
          await fulfill(route, { error: "Invalid presentation position" }, 409);
          return;
        }
        state = body.state;
        cursor = body.state === "opening" ? 0 : states.indexOf(body.state);
        questionIndex = body.questionIndex;
        version += 1;
        const questionCount =
          deckScenario === "empty" ? 0 : deckScenario === "large_long_text" ? 100 : 1;
        await fulfill(
          route,
          makeControls(state, version, hidden, snapshotRevision, questionCount, questionIndex),
        );
        return;
      }
      if (body.action === "start" && state !== "not_started") {
        await fulfill(route, { error: "Presentation has already started" }, 409);
        return;
      }
      if (body.action !== "start" && state === "not_started") {
        await fulfill(route, { error: "Presentation has not started" }, 409);
        return;
      }
      if (body.action === "previous" && state === "opening") {
        await fulfill(route, { error: "Presentation is already at its first state" }, 409);
        return;
      }
      if (body.action === "start" && state === "not_started") {
        snapshotRevision += 1;
        cursor = 1;
        state = states[cursor];
        questionIndex = 0;
      } else if (body.action === "advance" && cursor + 1 < states.length) {
        cursor += 1;
        state = states[cursor];
      } else if (body.action === "previous" && cursor > 1) {
        cursor -= 1;
        state = states[cursor];
      } else if (body.action === "hide") {
        hidden = true;
      } else if (body.action === "show") {
        hidden = false;
      }
      version += 1;
      const questionCount =
        deckScenario === "empty" ? 0 : deckScenario === "large_long_text" ? 100 : 1;
      await fulfill(
        route,
        makeControls(state, version, hidden, snapshotRevision, questionCount, questionIndex),
      );
    },
  );

  await context.route("**/api/presentation", async (route) => {
    const projection = hidden ? { state: "standby" } : projectionForState(state, snapshotRevision);
    await fulfill(route, projection);
  });
  return {
    setState(nextState) {
      state = nextState;
      cursor = nextState === "opening" ? 0 : states.indexOf(nextState);
      questionIndex = 0;
    },
    setDeckScenario(nextScenario) {
      deckScenario = nextScenario;
    },
    setNextPostBehavior(behavior) {
      if (!behavior.hold) {
        nextPostBehavior = behavior;
        return () => {};
      }
      let release;
      const releasePromise = new Promise((resolve) => {
        release = resolve;
      });
      nextPostBehavior = { ...behavior, releasePromise };
      return release;
    },
  };
}

function assertLocalDatabaseIsolation(env = process.env) {
  if (env.STCIRT_E2E_DB_ISOLATION !== "1" || env.TURSO_AUTH_TOKEN !== "" || !tempDir || !dbPath) {
    throw new Error("real_database_isolation_environment_invalid");
  }
  const url = env.TURSO_DATABASE_URL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("real_database_isolation_url_invalid");
  }
  const activePath = resolve(decodeURIComponent(parsed.pathname));
  const tempRoot = resolve(tempDir);
  const relativePath = relative(tempRoot, activePath);
  if (
    parsed.protocol !== "file:" ||
    parsed.hostname !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    url !== `file:${resolve(dbPath)}` ||
    activePath !== resolve(dbPath) ||
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("real_database_isolation_path_invalid");
  }
  return true;
}

function createIsolatedDbClient() {
  assertLocalDatabaseIsolation();
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function makeIsolatedChildEnvironment() {
  const childEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TZ: process.env.TZ ?? "UTC",
    NODE_ENV: "production",
    STCIRT_E2E_DB_ISOLATION: "1",
    TURSO_DATABASE_URL: `file:${resolve(dbPath)}`,
    TURSO_AUTH_TOKEN: "",
    ADMIN_PRESENTATION_PIN: "7316",
    ADMIN_PRESENTATION_SESSION_SECRET: adminSecret,
  };
  assertLocalDatabaseIsolation(childEnv);
  return childEnv;
}

async function seedRealDatabase() {
  dbClient = createIsolatedDbClient();
  const root = process.cwd();
  const journal = JSON.parse(
    await readFile(join(root, "src/lib/db/migrations/meta/_journal.json"), "utf8"),
  );
  if (journal.dialect !== "sqlite" || !Array.isArray(journal.entries)) {
    throw new Error("unexpected_migration_journal");
  }
  for (const entry of journal.entries) {
    const sql = await readFile(join(root, "src/lib/db/migrations", `${entry.tag}.sql`), "utf8");
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await dbClient.execute(statement);
    }
  }
  await dbClient.execute({
    sql: "UPDATE exam_questions SET question_version = CASE id WHEN 5 THEN 'tamami-egg-v1' ELSE 'bench-fixture-v1' END",
  });
  const questionRows = await dbClient.execute(
    "SELECT id, question_key, question_version FROM exam_questions ORDER BY id",
  );
  const questions = questionRows.rows;
  if (questions.length !== 5 || questions.some((row) => !row.question_version)) {
    throw new Error("real_fixture_question_versions_unavailable");
  }
  const questionVersions = Object.fromEntries(
    questions.map((row) => [String(row.id), row.question_version]),
  );
  const rubricVersions = { 5: "jev-q5-fulfillment-v3-02" };
  await dbClient.execute({
    sql: "INSERT INTO presentation_sessions (id, state, version, question_index, question_count, snapshot_revision, question_versions, rubric_versions) VALUES (1, 'not_started', 1, 0, 5, 1, ?, ?)",
    args: [JSON.stringify(questionVersions), JSON.stringify(rubricVersions)],
  });
  for (let position = 0; position < questions.length; position += 1) {
    const row = questions[position];
    await dbClient.execute({
      sql: "INSERT INTO presentation_questions (session_id, position, source_question_id, question, choices, correct_index, explanation) VALUES (1, ?, ?, ?, ?, ?, ?)",
      args: [
        position,
        row.id,
        position === 0 ? realFixtureQuestionTitle : `合成質問 ${position + 1}`,
        JSON.stringify(question.choices),
        1,
        "合成ベンチデータです。",
      ],
    });
  }
  await dbClient.close();
  dbClient = undefined;
}

async function startIsolatedLocalServer() {
  currentStage = "server_preflight";
  const childEnv = makeIsolatedChildEnvironment();
  await rejectRemoteDotEnvDatabaseSettings(childEnv);
  const serverUrl = `http://${host}:${port}`;
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, host, () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  }).catch((error) => {
    throw new Error("fixed_loopback_port_unavailable", { cause: error });
  });
  currentStage = "database_seed";
  await seedRealDatabase();
  currentStage = "server_startup";
  localServer = spawn(
    process.execPath,
    [
      join(process.cwd(), "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      host,
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  localServer.on("error", (error) => {
    localServerSpawnError = error;
  });
  let logs = "";
  for (const stream of [localServer.stdout, localServer.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk) => {
      logs = `${logs}${chunk}`.slice(-4000);
    });
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (localServerSpawnError) throw new Error("server_child_spawn_failed");
    if (localServer.exitCode !== null) throw new Error("real_server_exited");
    try {
      const response = await fetch(`${serverUrl}/api/admin/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: serverUrl },
        body: JSON.stringify({ pin: "7316" }),
        signal: AbortSignal.timeout(500),
      });
      const body = await response.json();
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      if (response.status !== 200 || body.authenticated !== true || !cookie) continue;
      const controlsResponse = await fetch(`${serverUrl}/api/admin/presentation?view=controls`, {
        headers: { cookie },
      });
      const controls = await controlsResponse.json();
      const deckResponse = await fetch(`${serverUrl}/api/admin/presentation/deck`, {
        headers: { cookie },
      });
      const deck = await deckResponse.json();
      if (
        controlsResponse.status === 200 &&
        controls.state === "not_started" &&
        controls.questionCount === 5 &&
        controls.snapshotRevision === 1 &&
        deckResponse.status === 200 &&
        deck.slides?.some(
          (slide) => slide.projection?.question?.question === realFixtureQuestionTitle,
        )
      ) {
        localServerReady = true;
        return;
      }
    } catch {}
    await timerDelay(250);
  }
  throw new Error("real_server_start_timeout");
}

async function rejectRemoteDotEnvDatabaseSettings(childEnv) {
  // Next's environment-variable guide gives process.env precedence over .env*.
  // The child receives this exact, independently validated allowlist, so source
  // dotenv values cannot replace its owned SQLite URL or empty auth token.
  const childEnvironmentIsolated = assertLocalDatabaseIsolation(childEnv);
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    let contents;
    try {
      contents = await readFile(join(process.cwd(), file), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(
        /^\s*(?:export\s+)?(TURSO_DATABASE_URL|TURSO_AUTH_TOKEN)\s*=\s*(.*)\s*$/,
      );
      if (!match) continue;
      const value = match[2].replace(/^['"]|['"]$/g, "").trim();
      if (match[1] === "TURSO_AUTH_TOKEN" && value !== "" && !childEnvironmentIsolated) {
        throw new Error(`remote_database_credentials_in_${file}`);
      }
      if (
        match[1] === "TURSO_DATABASE_URL" &&
        !value.startsWith("file:") &&
        !childEnvironmentIsolated
      ) {
        throw new Error(`remote_database_url_in_${file}`);
      }
    }
  }
}

async function resetRealFixtureToQuestion(page, sampleTag) {
  // The isolated fixture is rewound between trials so every route measurement
  // starts from the same question state, independent of the prior operation.
  const client = createIsolatedDbClient();
  realFixtureQuestionTitle = `${question.question} [bench ${sampleTag}]`;
  try {
    await client.execute({
      sql: "UPDATE presentation_questions SET question = ? WHERE session_id = 1 AND position = 0",
      args: [realFixtureQuestionTitle],
    });
    await client.execute(
      "UPDATE presentation_sessions SET state = 'question', question_index = 0, version = version + 1, snapshot_revision = snapshot_revision + 1, projection_hidden = 0 WHERE id = 1",
    );
  } finally {
    await client.close();
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: realFixtureQuestionTitle, exact: true })
    .waitFor({ timeout: 10_000 });
  await assertRealStateSync(page, "question", realFixtureQuestionTitle, 0);
}

async function resetMockFixtureToQuestion(page, mockFixture, { reload = false } = {}) {
  mockFixture.setState("question");
  if (reload) await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(async () => {
    const [controlsResponse, projectionResponse] = await Promise.all([
      fetch("/api/admin/presentation?view=controls", { cache: "no-store" }),
      fetch("/api/presentation", { cache: "no-store" }),
    ]);
    if (!controlsResponse.ok || !projectionResponse.ok) return false;
    const [controls, projection] = await Promise.all([
      controlsResponse.json(),
      projectionResponse.json(),
    ]);
    return controls.state === "question" && projection.state === "question";
  });
  await page.getByRole("heading", { name: question.question, exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page
    .locator('[role="status"][aria-live="polite"]')
    .filter({ hasText: /^第1問$/ })
    .waitFor({ timeout: 10_000 });
}

async function assertRealStateSync(
  page,
  expectedState,
  expectedQuestionTitle = realFixtureQuestionTitle,
  expectedQuestionIndex,
) {
  const controls = await page.evaluate(async () => {
    const response = await fetch("/api/admin/presentation?view=controls", { cache: "no-store" });
    return { status: response.status, value: await response.json() };
  });
  const client = createIsolatedDbClient();
  let dbState;
  let dbQuestionCount;
  let dbQuestionIndex;
  let dbSnapshotRevision;
  let dbQuestionTitle;
  try {
    const result = await client.execute(
      "SELECT state, question_count, question_index, snapshot_revision FROM presentation_sessions WHERE id = 1",
    );
    dbState = result.rows[0]?.state;
    dbQuestionCount = Number(result.rows[0]?.question_count);
    dbQuestionIndex = Number(result.rows[0]?.question_index);
    dbSnapshotRevision = Number(result.rows[0]?.snapshot_revision);
    const questionRow = await client.execute({
      sql: "SELECT question FROM presentation_questions WHERE session_id = 1 AND position = ?",
      args: [dbQuestionIndex],
    });
    dbQuestionTitle = questionRow.rows[0]?.question;
  } finally {
    await client.close();
  }
  const projection = await page.evaluate(async () => {
    const response = await fetch("/api/presentation", { cache: "no-store" });
    return { status: response.status, value: await response.json() };
  });
  const deck = await page.evaluate(async () => {
    const response = await fetch("/api/admin/presentation/deck", { cache: "no-store" });
    return { status: response.status, value: await response.json() };
  });
  const expectedAnnouncement = {
    not_started: "",
    opening: "発表を開始しました",
    question: "第1問",
    answer: "第1問の解説",
    podium_preview: "結果発表を開始します",
    third: "第三位を発表します",
    second: "第二位を発表します",
    first: "第一位を発表します",
    finished: "発表が終了しました",
  }[expectedState];
  if (expectedAnnouncement) {
    await page
      .locator('[role="status"][aria-live="polite"]')
      .filter({ hasText: expectedAnnouncement })
      .waitFor({ timeout: 10_000 });
  }
  const statusText =
    (await page.locator('[role="status"][aria-live="polite"]').first().textContent()) ?? "";
  if (
    controls.status !== 200 ||
    controls.value.state !== expectedState ||
    controls.value.questionCount !== dbQuestionCount ||
    controls.value.questionIndex !== dbQuestionIndex ||
    controls.value.snapshotRevision !== dbSnapshotRevision ||
    dbState !== expectedState ||
    dbQuestionCount !== 5 ||
    (expectedQuestionIndex !== undefined && dbQuestionIndex !== expectedQuestionIndex) ||
    dbQuestionTitle !== expectedQuestionTitle ||
    projection.status !== 200 ||
    projection.value.state !== expectedState ||
    ((expectedState === "question" || expectedState === "answer") &&
      (projection.value.question?.question !== expectedQuestionTitle ||
        projection.value.question?.ordinal !== dbQuestionIndex + 1)) ||
    deck.status !== 200 ||
    deck.value.snapshotRevision !== dbSnapshotRevision ||
    deck.value.questionCount !== dbQuestionCount ||
    deck.value.questionIndex !== dbQuestionIndex ||
    !deck.value.slides?.some(
      (slide) => slide.projection?.question?.question === expectedQuestionTitle,
    ) ||
    !statusText.includes(expectedAnnouncement)
  ) {
    throw new Error("real_fixture_ui_db_controls_out_of_sync");
  }
}

async function setRealFixtureState(state) {
  const client = createIsolatedDbClient();
  try {
    await client.execute({
      sql: "UPDATE presentation_sessions SET state = ?, question_index = 0, version = version + 1, projection_hidden = 0 WHERE id = 1",
      args: [state],
    });
  } finally {
    await client.close();
  }
}

async function runSanityScenarios(page, mockFixture, setActiveOperation, installInstrumentation) {
  const result = {};
  const boundaryState = "opening";
  let boundaryStage = "fixture_setup";
  let boundaryHttpStatus = null;
  let boundaryStateUnchanged = null;
  const expectedBoundaryStatus = 409;
  try {
    boundaryStage = mode === "real" ? "set_real_opening_state" : "set_mock_opening_state";
    if (mode === "real") await setRealFixtureState(boundaryState);
    else mockFixture.setState(boundaryState);
    boundaryStage = "verify_opening_state";
    if (mode === "real") await assertRealStateSync(page, boundaryState);
    else {
      await page.waitForFunction(async () => {
        const response = await fetch("/api/presentation", { cache: "no-store" });
        return (await response.json()).state === "opening";
      });
    }
    boundaryStage = "dispatch_previous_request";
    boundaryHttpStatus = await page.evaluate(async () => {
      const response = await fetch("/api/admin/presentation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "previous", operationId: crypto.randomUUID() }),
      });
      return response.status;
    });
    boundaryStage = "verify_unchanged_state";
    if (mode === "real") {
      const stateAfter = await page.evaluate(async () => {
        const [controlsResponse, projectionResponse] = await Promise.all([
          fetch("/api/admin/presentation?view=controls", { cache: "no-store" }),
          fetch("/api/presentation", { cache: "no-store" }),
        ]);
        return {
          controlsStatus: controlsResponse.status,
          controls: (await controlsResponse.json()).state,
          projectionStatus: projectionResponse.status,
          projection: (await projectionResponse.json()).state,
        };
      });
      const client = createIsolatedDbClient();
      let dbState;
      try {
        dbState = (await client.execute("SELECT state FROM presentation_sessions WHERE id = 1"))
          .rows[0]?.state;
      } finally {
        await client.close();
      }
      boundaryStateUnchanged =
        stateAfter.controlsStatus === 200 &&
        stateAfter.projectionStatus === 200 &&
        stateAfter.controls === boundaryState &&
        stateAfter.projection === boundaryState &&
        dbState === boundaryState;
      if (boundaryStateUnchanged) await assertRealStateSync(page, boundaryState);
    } else {
      const stateAfter = await page.evaluate(async () => {
        const [controlsResponse, projectionResponse] = await Promise.all([
          fetch("/api/admin/presentation?view=controls", { cache: "no-store" }),
          fetch("/api/presentation", { cache: "no-store" }),
        ]);
        return {
          controlsStatus: controlsResponse.status,
          controls: (await controlsResponse.json()).state,
          projectionStatus: projectionResponse.status,
          projection: (await projectionResponse.json()).state,
        };
      });
      boundaryStateUnchanged =
        stateAfter.controlsStatus === 200 &&
        stateAfter.projectionStatus === 200 &&
        stateAfter.controls === boundaryState &&
        stateAfter.projection === boundaryState;
    }
    if (!boundaryStateUnchanged) throw new Error("boundary_state_changed");
    boundaryStage = "verify_conflict_status";
    if (boundaryHttpStatus !== expectedBoundaryStatus)
      throw new Error("boundary_result_unexpected");
    result.boundary = {
      status: "measured",
      scenario: "previous_from_first_presenter_state",
      expected_http_status: expectedBoundaryStatus,
      actual_http_status: boundaryHttpStatus,
      state_unchanged: boundaryStateUnchanged,
    };
  } catch (error) {
    result.boundary = {
      status: "failed",
      reason: classifyFailure(error),
      stage: boundaryStage,
      expected_http_status: expectedBoundaryStatus,
      actual_http_status: boundaryHttpStatus,
      state_unchanged: boundaryStateUnchanged,
    };
  }

  let burstStage = "fixture_setup";
  let burstDispatchDiagnostics = null;
  let releaseHeldPost = null;
  try {
    if (mode === "real") {
      burstStage = "real_fixture_reset";
      await resetRealFixtureToQuestion(page, "sanity-burst");
      await installInstrumentation();
    } else {
      burstStage = "mock_fixture_reset";
      mockFixture.setState("question");
      await page.waitForFunction(async () => {
        const response = await fetch("/api/presentation", { cache: "no-store" });
        return (await response.json()).state === "question";
      });
      await page
        .locator('[role="status"][aria-live="polite"]')
        .filter({ hasText: "第1問" })
        .waitFor({ timeout: 10_000 });
    }
    releaseHeldPost = mode === "mock" ? mockFixture.setNextPostBehavior({ hold: true }) : null;
    const burst = createOperationTracker();
    setActiveOperation(burst);
    burstStage = "arm_and_dispatch";
    await page.evaluate(() => window.__presentationBenchArm());
    const burstInputCount = 5;
    const busyInputCount = burstInputCount - 1;
    const dispatchOutcome = await page.evaluate(async (count) => {
      const bench = window.__presentationBench;
      const target = document.querySelector("main");
      if (!bench || !target) {
        return {
          ok: false,
          errorCode: "fixture_unavailable",
          dispatchEventCount: 0,
          inputIds: [],
          observedInputIds: [],
        };
      }
      bench.burstDispatchInputIds = [];
      bench.burstDispatchError = null;
      bench.burstDispatchEventCount = 1;
      bench.burstDispatchRecords = [];
      const primaryDispatchRecord = {
        slot: "primary",
        event_count: 1,
        input_ids: [],
      };
      bench.burstDispatchRecords.push(primaryDispatchRecord);
      let resolveDispatch;
      const dispatchComplete = new Promise((resolve) => {
        resolveDispatch = resolve;
      });
      const finishDispatch = () => {
        if (
          bench.burstDispatchError === null &&
          (bench.burstDispatchEventCount !== count + 1 ||
            bench.burstDispatchInputIds.length !== count + 1)
        ) {
          bench.burstDispatchError = "dispatch_capture_incomplete";
        }
        bench.busyBurstInputIds = bench.burstDispatchInputIds.slice(1);
        resolveDispatch({
          errorCode: bench.burstDispatchError,
          dispatchEventCount: bench.burstDispatchEventCount,
          records: [...bench.burstDispatchRecords],
          inputIds: [...bench.burstDispatchInputIds],
          observedInputIds: bench.inputs.map((input) => input.id),
        });
      };
      bench.onNextPostStart = (primaryPost) => {
        const orderedIds = primaryPost.inputId === null ? [] : [primaryPost.inputId];
        bench.burstDispatchInputIds = [...orderedIds];
        primaryDispatchRecord.input_ids = [...orderedIds];
        if (primaryPost.inputId === null) bench.burstDispatchError = "input_id_capture_missing";
        for (let index = 0; index < count; index += 1) {
          const previousInputCount = bench.inputs.length;
          const record = {
            slot: `synthetic_${index + 1}`,
            event_count: 1,
            input_ids: [],
          };
          bench.burstDispatchRecords.push(record);
          bench.burstDispatchEventCount += 1;
          try {
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "ArrowRight",
                bubbles: true,
                cancelable: true,
              }),
            );
          } catch {
            bench.burstDispatchError = "dispatch_failed";
            break;
          }
          const observedInputs = bench.inputs.slice(previousInputCount);
          record.input_ids = observedInputs.map((input) => input.id);
          orderedIds.push(...record.input_ids);
          bench.burstDispatchInputIds = [...orderedIds];
          if (observedInputs.length !== 1 || observedInputs[0].type !== "keydown") {
            bench.burstDispatchError = "dispatch_input_unobserved";
            break;
          }
        }
        finishDispatch();
      };
      const initialInputCount = bench.inputs.length;
      try {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
      } catch {
        bench.burstDispatchError = "dispatch_failed";
        finishDispatch();
      }
      let dispatchTimeoutId;
      const dispatchResult = await Promise.race([
        dispatchComplete,
        new Promise(
          (resolve) =>
            (dispatchTimeoutId = setTimeout(() => {
              bench.burstDispatchError ??= "post_start_not_observed";
              resolve({
                errorCode: bench.burstDispatchError,
                dispatchEventCount: bench.burstDispatchEventCount,
                records: [...bench.burstDispatchRecords],
                inputIds: [...bench.burstDispatchInputIds],
                observedInputIds: bench.inputs.map((input) => input.id),
              });
            }, 5_000)),
        ),
      ]);
      clearTimeout(dispatchTimeoutId);
      const primaryObservedIds = bench.inputs.slice(initialInputCount).map((input) => input.id);
      const errorCode = dispatchResult.errorCode;
      return {
        ok: errorCode === null,
        errorCode,
        dispatchEventCount: dispatchResult.dispatchEventCount,
        records: dispatchResult.records,
        inputIds: dispatchResult.inputIds,
        observedInputIds: dispatchResult.observedInputIds,
        primaryObservedIds,
      };
    }, busyInputCount);
    burstDispatchDiagnostics = dispatchOutcome;
    if (!dispatchOutcome.ok) {
      const error = new Error(
        dispatchOutcome.errorCode === "fixture_unavailable"
          ? "burst_fixture_unavailable"
          : dispatchOutcome.errorCode === "dispatch_input_unobserved"
            ? "burst_dispatch_input_unobserved"
            : "burst_dispatch_failed",
      );
      error.name =
        dispatchOutcome.errorCode === "fixture_unavailable"
          ? "BenchFixtureError"
          : "BenchDispatchError";
      error.code = dispatchOutcome.errorCode;
      throw error;
    }
    const dispatchedInputIds = dispatchOutcome.inputIds;
    await withTimeout(burst.firstPost, 10_000, "burst_primary_not_started");
    const expectedLatestLocalState = "first";
    let localCursorDuringHold = null;
    let noSecondWriteWhileHeld = null;
    if (mode === "mock") {
      burstStage = "verify_local_cursor_while_post_held";
      await page.waitForFunction(
        (expectedState) =>
          document.querySelector('[role="status"][aria-live="polite"]')?.textContent?.includes(
            {
              opening: "発表を開始しました",
              question: "第1問",
              answer: "第1問の解説",
              first: "第一位を発表します",
            }[expectedState] ?? expectedState,
          ),
        expectedLatestLocalState,
        { timeout: 5_000 },
      );
      const heldSnapshot = await page.evaluate(() => ({
        statusText:
          document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "",
        posts: window.__presentationBench.posts.map((post) => ({
          inputId: post.inputId,
          endedAt: post.endedAt,
        })),
      }));
      localCursorDuringHold = heldSnapshot.statusText.includes("第一位を発表します");
      noSecondWriteWhileHeld =
        heldSnapshot.posts.length === 1 && heldSnapshot.posts[0]?.endedAt === null;
      releaseHeldPost();
      releaseHeldPost = null;
    }
    burstStage = "wait_for_latest_position_write";
    if (mode === "mock")
      await withTimeout(burst.secondPost, 10_000, "burst_coalesced_write_not_started");
    await waitForOperationQuiet(burst);
    await page.waitForFunction(
      () =>
        window.__presentationBench.posts.length > 0 &&
        window.__presentationBench.posts.every((post) => post.endedAt !== null),
      null,
      { timeout: 5_000 },
    );
    const burstBrowser = await page.evaluate(() => ({
      inputs: window.__presentationBench.inputs,
      posts: window.__presentationBench.posts,
      busyInputIds: window.__presentationBench.busyBurstInputIds ?? [],
      dispatchedInputIds: window.__presentationBench.burstDispatchInputIds ?? [],
      burstDispatchError: window.__presentationBench.burstDispatchError ?? null,
      burstDispatchEventCount: window.__presentationBench.burstDispatchEventCount ?? 0,
      burstDispatchRecords: window.__presentationBench.burstDispatchRecords ?? [],
      instrumentationError: window.__presentationBench.instrumentationError,
    }));
    if (burstBrowser.instrumentationError) throw new Error(burstBrowser.instrumentationError);
    burstStage = "validate_position_coalescing";
    const burstPostRecords = burstBrowser.posts;
    const burstInputIds = burstBrowser.inputs.map((input) => input.id);
    const dispatchInputIdsMatchObserved =
      dispatchOutcome.observedInputIds.length === burstInputCount &&
      dispatchOutcome.observedInputIds.every(
        (id, index) => id === burstInputIds[index] && id === dispatchedInputIds[index],
      );
    const dispatchRecordIds = dispatchOutcome.records.flatMap((record) => record.input_ids);
    const dispatchRecordsComplete =
      dispatchOutcome.records.length === burstInputCount &&
      dispatchOutcome.records[0]?.slot === "primary" &&
      dispatchOutcome.records
        .slice(1)
        .every((record, index) => record.slot === `synthetic_${index + 1}`) &&
      dispatchOutcome.records.every((record) => record.event_count === 1) &&
      dispatchRecordIds.length === burstInputCount &&
      dispatchRecordIds.every((id, index) => id === dispatchedInputIds[index]);
    const dispatchCaptureValid =
      dispatchOutcome.dispatchEventCount === burstInputCount &&
      burstBrowser.burstDispatchEventCount === burstInputCount &&
      dispatchedInputIds.length === burstInputCount &&
      dispatchRecordsComplete &&
      JSON.stringify(burstBrowser.burstDispatchRecords) ===
        JSON.stringify(dispatchOutcome.records) &&
      dispatchInputIdsMatchObserved;
    const dispatchErrorCode =
      burstBrowser.burstDispatchError ??
      (dispatchCaptureValid ? null : "dispatch_capture_incomplete");
    const failedPostCount = burstPostRecords.filter(
      (post) => post.status < 200 || post.status >= 300 || post.failure !== null,
    ).length;
    const expectedPostCount = mode === "mock" ? 2 : null;
    const coalescedPost = burstPostRecords[1] ?? null;
    const coalescedToNewestInput =
      mode === "mock" ? coalescedPost?.inputId === dispatchedInputIds.at(-1) : null;
    let serverConvergedToLatestTarget = null;
    if (mode === "real") {
      burstStage = "verify_real_state_sync";
      const client = createIsolatedDbClient();
      let expectedState;
      try {
        expectedState = (
          await client.execute("SELECT state FROM presentation_sessions WHERE id = 1")
        ).rows[0]?.state;
      } finally {
        await client.close();
      }
      await assertRealStateSync(page, expectedState);
      serverConvergedToLatestTarget = expectedState === expectedLatestLocalState;
    } else {
      const finalState = await page.evaluate(async () => {
        const [controlsResponse, projectionResponse] = await Promise.all([
          fetch("/api/admin/presentation?view=controls", { cache: "no-store" }),
          fetch("/api/presentation", { cache: "no-store" }),
        ]);
        return {
          controls: await controlsResponse.json(),
          projection: await projectionResponse.json(),
        };
      });
      serverConvergedToLatestTarget =
        finalState.controls.state === expectedLatestLocalState &&
        finalState.projection.state === expectedLatestLocalState &&
        finalState.controls.questionIndex === 0;
    }
    const coalescingValid =
      burstInputIds.length === burstInputCount &&
      dispatchCaptureValid &&
      dispatchInputIdsMatchObserved &&
      burstBrowser.inputs.every((input) => input.type === "keydown") &&
      (mode !== "mock" || burstBrowser.posts.length === expectedPostCount) &&
      failedPostCount === 0 &&
      (mode !== "mock" || coalescedToNewestInput) &&
      serverConvergedToLatestTarget &&
      (mode !== "mock" || (localCursorDuringHold && noSecondWriteWhileHeld));
    result.burst = {
      status: coalescingValid ? "measured" : "partial",
      scenario: "four_synthetic_position_inputs_while_the_first_write_is_in_flight",
      measurement_scope: "synthetic input burst; mock mode uses a held POST to check coalescing",
      input_count: burstInputCount,
      observed_input_count: burstInputIds.length,
      dispatch_error_code: dispatchErrorCode,
      dispatch_event_count: burstBrowser.burstDispatchEventCount,
      dispatch_event_observed_count: dispatchRecordIds.length,
      dispatched_input_id_count: dispatchedInputIds.length,
      observed_input_id_count: burstBrowser.inputs.length,
      dispatch_records: dispatchOutcome.records,
      dispatched_input_ids: dispatchedInputIds,
      observed_input_ids_match_dispatch_order: dispatchInputIdsMatchObserved,
      post_request_count: burstPostRecords.length,
      failed_post_count: failedPostCount,
      expected_write_count: expectedPostCount,
      local_cursor_during_first_write: {
        status:
          mode === "mock" ? (localCursorDuringHold ? "measured" : "failed") : "not_applicable",
        state: mode === "mock" ? (localCursorDuringHold ? expectedLatestLocalState : null) : null,
        reason: mode === "mock" ? undefined : "requires_controlled_mock_post_hold",
      },
      no_second_write_while_first_held: {
        status:
          mode === "mock" ? (noSecondWriteWhileHeld ? "measured" : "failed") : "not_applicable",
        value: mode === "mock" ? noSecondWriteWhileHeld : null,
        reason: mode === "mock" ? undefined : "requires_controlled_mock_post_hold",
      },
      intermediate_positions_coalesced: {
        status: mode === "mock" ? (coalescingValid ? "measured" : "failed") : "not_applicable",
        latest_input_id: dispatchedInputIds.at(-1) ?? null,
        followup_write_input_id: coalescedPost?.inputId ?? null,
        reason: mode === "mock" ? undefined : "requires_controlled_mock_post_hold",
      },
      server_converged_to_latest_target: {
        status: serverConvergedToLatestTarget ? "measured" : "failed",
        expected_state: expectedLatestLocalState,
        final_state_matches: serverConvergedToLatestTarget,
      },
      obsolete_rejection_metrics: {
        status: "not_applicable",
        reason: "position inputs advance the local cursor and coalesce while a write is in flight",
      },
    };
  } catch (error) {
    const reason = classifyFailure(error);
    result.burst = {
      status: "failed",
      reason,
      stage: burstStage,
      error_name: error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : "Error",
      dispatch_error_code: [
        "fixture_unavailable",
        "dispatch_failed",
        "dispatch_input_unobserved",
        "dispatch_capture_incomplete",
        "input_id_capture_missing",
        "post_start_not_observed",
      ].includes(error?.code)
        ? error.code
        : (burstDispatchDiagnostics?.errorCode ?? "dispatch_diagnostics_unavailable"),
      dispatch_event_count: burstDispatchDiagnostics?.dispatchEventCount ?? 0,
      dispatch_event_observed_count: burstDispatchDiagnostics?.inputIds?.length ?? 0,
      dispatched_input_id_count: burstDispatchDiagnostics?.inputIds?.length ?? 0,
      observed_input_id_count: burstDispatchDiagnostics?.observedInputIds?.length ?? 0,
      dispatch_records: burstDispatchDiagnostics?.records ?? [],
      dispatched_input_ids: burstDispatchDiagnostics?.inputIds ?? [],
      observed_input_count: burstDispatchDiagnostics?.observedInputIds?.length ?? 0,
      observed_input_ids: burstDispatchDiagnostics?.observedInputIds ?? [],
      sanitized_message: reason,
    };
  } finally {
    releaseHeldPost?.();
    setActiveOperation(null);
  }
  return result;
}

async function runMockCoverageScenarios(
  page,
  mockFixture,
  setActiveOperation,
  installInstrumentation,
) {
  const result = {};
  const action = async (name) =>
    page.evaluate(async (actionName) => {
      const response = await fetch("/api/admin/presentation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: actionName, operationId: crypto.randomUUID() }),
      });
      return { status: response.status };
    }, name);
  const readState = () =>
    page.evaluate(async () => {
      const [controlsResponse, projectionResponse] = await Promise.all([
        fetch("/api/admin/presentation?view=controls", { cache: "no-store" }),
        fetch("/api/presentation", { cache: "no-store" }),
      ]);
      return {
        controls: await controlsResponse.json(),
        projection: await projectionResponse.json(),
      };
    });

  try {
    mockFixture.setState("not_started");
    const start = await action("start");
    const afterStart = await readState();
    const duplicateStart = await action("start");
    const afterDuplicateStart = await readState();
    if (
      start.status !== 200 ||
      afterStart.controls.state !== "question" ||
      duplicateStart.status !== 409 ||
      afterDuplicateStart.controls.state !== "question"
    )
      throw new Error("start_boundary_unexpected");
    result.start_boundary = {
      status: "measured",
      start_status: start.status,
      duplicate_start_status: duplicateStart.status,
      state_after_duplicate_start: afterDuplicateStart.controls.state,
      state_unchanged_after_conflict: true,
    };
  } catch (error) {
    result.start_boundary = { status: "failed", reason: classifyFailure(error) };
  }

  try {
    mockFixture.setState("finished");
    const before = await readState();
    const end = await action("advance");
    const after = await readState();
    if (
      before.controls.state !== "finished" ||
      end.status !== 200 ||
      after.controls.state !== "finished" ||
      after.projection.state !== "finished"
    )
      throw new Error("end_boundary_unexpected");
    result.end_boundary = {
      status: "measured",
      advance_status: end.status,
      state_before: before.controls.state,
      state_after: after.controls.state,
      state_unchanged: true,
    };
  } catch (error) {
    result.end_boundary = { status: "failed", reason: classifyFailure(error) };
  }

  try {
    mockFixture.setState("podium_preview");
    const observed = [];
    for (const expected of ["third", "second", "first", "finished"]) {
      const response = await action("advance");
      const after = await readState();
      if (
        response.status !== 200 ||
        after.controls.state !== expected ||
        after.projection.state !== expected
      ) {
        throw new Error("rank_boundary_unexpected");
      }
      observed.push({ state: expected, winners: after.projection.winners?.length ?? 0 });
    }
    result.rank_boundaries = { status: "measured", transitions: observed };
  } catch (error) {
    result.rank_boundaries = { status: "failed", reason: classifyFailure(error) };
  }

  try {
    mockFixture.setDeckScenario("empty");
    const empty = await page.evaluate(async () => {
      const response = await fetch("/api/admin/presentation/deck", { cache: "no-store" });
      const body = await response.json();
      return { status: response.status, slide_count: body.slides?.length ?? null };
    });
    if (empty.status !== 200 || empty.slide_count !== 0) throw new Error("empty_deck_unexpected");
    result.empty_deck = {
      status: "measured",
      http_status: empty.status,
      slide_count: empty.slide_count,
      fixture: "synthetic_mock_only",
    };
  } catch (error) {
    result.empty_deck = { status: "failed", reason: classifyFailure(error) };
  } finally {
    mockFixture.setDeckScenario("default");
  }

  try {
    mockFixture.setDeckScenario("large_long_text");
    const large = await page.evaluate(async () => {
      const startedAt = performance.now();
      const response = await fetch("/api/admin/presentation/deck", { cache: "no-store" });
      const text = await response.text();
      const endedAt = performance.now();
      const deck = JSON.parse(text);
      const longestQuestion = Math.max(
        0,
        ...deck.slides.map((slide) => slide.projection?.question?.question?.length ?? 0),
      );
      return {
        status: response.status,
        slide_count: deck.slides?.length ?? null,
        payload_bytes: new TextEncoder().encode(text).byteLength,
        longest_question_characters: longestQuestion,
        fetch_elapsed_ms: endedAt - startedAt,
      };
    });
    if (
      large.status !== 200 ||
      large.slide_count !== 100 ||
      large.longest_question_characters < 1000
    )
      throw new Error("large_long_text_fixture_unexpected");
    result.large_deck_long_text = {
      status: "measured",
      http_status: large.status,
      fixture: "synthetic_mock_only",
      measurement_scope: "deck payload GET only; no full presenter rendering claim",
      slide_count: large.slide_count,
      payload_bytes: large.payload_bytes,
      longest_question_characters: large.longest_question_characters,
      fetch_elapsed_ms: large.fetch_elapsed_ms,
    };
  } catch (error) {
    result.large_deck_long_text = { status: "failed", reason: classifyFailure(error) };
  } finally {
    mockFixture.setDeckScenario("default");
  }

  const slowOverlap = {
    status: "failed",
    stage: "fixture_setup",
    post_status: null,
    elapsed_ms: null,
    concurrent_controls_get_count: 0,
    failed_predicates: [],
    poll_source: "synthetic controlled GET; not evidence of app polling cadence",
  };
  result.controlled_slow_poll_overlap = slowOverlap;
  let slowOverlapErrorCode = null;
  try {
    slowOverlap.stage = "reset_fixture_and_presenter";
    await resetMockFixtureToQuestion(page, mockFixture, { reload: true });
    await installInstrumentation();
    mockFixture.setNextPostBehavior({ delayMs: 1_000 });
    const tracker = createOperationTracker();
    setActiveOperation(tracker);
    slowOverlap.stage = "arm_and_dispatch_post";
    await page.evaluate(() => window.__presentationBenchArm());
    await page.locator("main").press("ArrowRight");
    slowOverlap.stage = "await_post_start";
    const post = await withTimeout(tracker.firstPost, 10_000, "slow_scenario_post_start_timeout");
    const postStartedAt = post.startedAt;
    slowOverlap.stage = "dispatch_concurrent_controls_get";
    await page.evaluate(async () => {
      const response = await fetch("/api/admin/presentation?view=controls", { cache: "no-store" });
      await response.json();
    });
    slowOverlap.stage = "await_post_completion";
    await waitForOperationQuiet(tracker);
    slowOverlap.post_status = post.status;
    slowOverlap.elapsed_ms =
      post.responseAt !== null && post.responseAt !== undefined
        ? post.responseAt - post.startedAt
        : post.finishedAt !== undefined
          ? post.finishedAt - post.startedAt
          : null;
    slowOverlap.concurrent_controls_get_count = tracker.requests.filter(
      (request) =>
        request.kind === "window_controls_get" &&
        request.startedAt >= postStartedAt &&
        request.startedAt < (post.responseAt ?? post.finishedAt ?? Number.NEGATIVE_INFINITY),
    ).length;
    slowOverlap.stage = "validate_predicates";
    if (post.status !== 200) slowOverlap.failed_predicates.push("post_status_200");
    if (slowOverlap.elapsed_ms === null || slowOverlap.elapsed_ms < 900) {
      slowOverlap.failed_predicates.push("controlled_delay_elapsed_at_least_900ms");
    }
    if (slowOverlap.concurrent_controls_get_count < 1) {
      slowOverlap.failed_predicates.push("concurrent_controls_get_observed");
    }
    slowOverlap.status = slowOverlap.failed_predicates.length === 0 ? "measured" : "failed";
  } catch (error) {
    slowOverlapErrorCode = classifyFailure(error);
    slowOverlap.stage = slowOverlap.stage || "unknown";
    slowOverlap.failed_predicates.push(`stage_failed:${slowOverlapErrorCode}`);
  } finally {
    if (slowOverlap.status !== "measured" && slowOverlap.failed_predicates.length === 0) {
      slowOverlap.failed_predicates.push("scenario_did_not_complete");
    }
    slowOverlap.reason = slowOverlap.status === "failed" ? slowOverlapErrorCode : undefined;
    setActiveOperation(null);
  }

  try {
    mockFixture.setState("question");
    mockFixture.setNextPostBehavior({ status: 503 });
    const tracker = createOperationTracker();
    setActiveOperation(tracker);
    await page.evaluate(() => window.__presentationBenchArm());
    await page.locator("main").press("ArrowRight");
    const post = await withTimeout(tracker.firstPost, 10_000, "failure_scenario_post_not_started");
    await waitForOperationQuiet(tracker);
    const after = await readState();
    if (
      post.status !== 503 ||
      after.controls.state !== "question" ||
      after.projection.state !== "question"
    ) {
      throw new Error("controlled_failure_unexpected");
    }
    result.controlled_failure = {
      status: "measured",
      response_status: post.status,
      state_unchanged: true,
      state_after: after.controls.state,
    };
  } catch (error) {
    result.controlled_failure = { status: "failed", reason: classifyFailure(error) };
  } finally {
    setActiveOperation(null);
    mockFixture.setState("question");
  }
  return result;
}

async function stopLocalServer() {
  if (!localServer || localServer.exitCode !== null) return;
  const exited = new Promise((resolve) => localServer.once("exit", resolve));
  localServer.kill("SIGTERM");
  await Promise.race([exited, timerDelay(3000)]);
  if (localServer.exitCode === null) {
    localServer.kill("SIGKILL");
    await Promise.race([exited, timerDelay(1000)]);
  }
}

async function cleanupResources() {
  if (contextInstance) {
    await contextInstance.close().catch(() => {});
    contextInstance = undefined;
  }
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = undefined;
  }
  await stopLocalServer().catch(() => {});
  if (dbClient) {
    await dbClient.close().catch(() => {});
    dbClient = undefined;
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, async () => {
    await cleanupResources();
    process.exit(exitCode);
  });
}

function classifyFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) return "timeout";
  if (/measurement_invariant/.test(message)) return "measurement_invariant";
  if (/^burst_fixture_unavailable$/.test(message)) return "burst_fixture_unavailable";
  if (/^burst_dispatch_failed$/.test(message)) return "burst_dispatch_failed";
  if (/boundary_result_unexpected/.test(message)) return "boundary_http_status_unexpected";
  if (/boundary_state_changed/.test(message)) return "boundary_state_changed";
  if (
    /primary_action_not_started|next_action_not_accepted|next_save_not_dispatched|inverse_probe_input_unavailable/.test(
      message,
    )
  )
    return "action_not_accepted";
  if (/measurement unavailable/.test(message)) return "measurement_timeout";
  if (/real_fixture_ui_db_controls_out_of_sync/.test(message)) return "real_state_out_of_sync";
  if (/not found|no element/i.test(message)) return "page_element_unavailable";
  if (/net::ERR_|navigation failed/i.test(message)) return "navigation_or_request_failed";
  return "unexpected_error";
}

function classifyBrowserLaunchFailure(error) {
  const message = error instanceof Error ? error.message : "";
  if (/sandbox|namespace|no usable sandbox/i.test(message)) return "sandbox_shutdown";
  if (
    (error && typeof error === "object" && "code" in error && error.code === "ENOENT") ||
    /executable.{0,40}(not found|does not exist|doesn't exist)|browser executable/i.test(message)
  ) {
    return "missing_executable";
  }
  if (/browser process (?:has )?(?:exited|closed)|browser.*(?:crashed|terminated)/i.test(message)) {
    return "browser_process_exited";
  }
  return "unknown";
}

function classifyStageFailure(stage, error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (typeof current.message === "string") messages.push(current.message);
    current = current.cause;
  }
  const message = messages.join(" ");
  if (stage === "server_preflight") {
    if (/fixed_loopback_port_unavailable|EADDRINUSE/i.test(message)) {
      return "loopback_port_unavailable";
    }
    if (/remote_database_|isolation/i.test(message)) return "environment_isolation_rejected";
    return "server_preflight_failure";
  }
  if (stage === "database_seed") {
    if (/migration|journal/i.test(message)) return "migration_failure";
    if (/fixture|question_versions/i.test(message)) return "fixture_failure";
    if (/sqlite|database|libsql|turso/i.test(message)) return "sqlite_failure";
    return "unknown";
  }
  if (stage === "server_startup") {
    if (localServer?.exitCode !== null && localServer?.exitCode !== undefined) {
      return "server_child_exited";
    }
    if (/real_server_start_timeout/i.test(message)) return "server_start_timeout";
    if (/real_server_exited/i.test(message)) return "server_child_exited";
    return "server_start_failure";
  }
  if (stage === "browser_launch") return classifyBrowserLaunchFailure(error);
  if (stage === "temp_fixture_creation") return "temp_fixture_failure";
  if (stage === "context_and_routes") return "browser_context_failure";
  if (
    stage === "measurement" ||
    stage.startsWith("warm_sample_") ||
    stage.startsWith("next_action_probe_") ||
    stage.startsWith("next_save_probe_") ||
    stage.startsWith("freeze_primary_paint_") ||
    stage === "visual_artifact_core_operation" ||
    stage.startsWith("summary_")
  ) {
    return "measurement_failure";
  }
  return "unknown";
}

function countReasons(reasons) {
  return Object.fromEntries(
    [...new Set(reasons)]
      .sort()
      .map((reason) => [reason, reasons.filter((value) => value === reason).length]),
  );
}

function projectionForState(state, revision) {
  if (state === "question" || state === "answer") {
    return {
      state,
      question: {
        id: question.id,
        ordinal: 1,
        total: 1,
        question: revision > 1 ? `${question.question}（snapshot ${revision}）` : question.question,
        choices: question.choices,
        ...(state === "answer" ? { correctAnswer: question.correctAnswer, correctIndex: 1 } : {}),
      },
    };
  }
  if (["third", "second", "first"].includes(state)) {
    const rank = state === "third" ? 3 : state === "second" ? 2 : 1;
    return {
      state,
      winners: entries
        .filter((entry) => entry.rank === rank)
        .map(({ displayName, score, rank: winnerRank }) => ({
          displayName,
          score,
          rank: winnerRank,
        })),
    };
  }
  return { state };
}

async function main() {
  currentStage = "initialization";
  sourceFingerprint = createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  currentStage = "temp_fixture_creation";
  tempDir = await mkdtemp(join(tmpdir(), "stcirt-presentation-latency-"));
  dbPath = join(tempDir, "fixture.db");
  currentStage = "database_seed";
  process.env.STCIRT_E2E_DB_ISOLATION = "1";
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  process.env.TURSO_AUTH_TOKEN = "";
  if (mode === "real") {
    realFixtureQuestionTitle = visualArtifactQuestionTitle;
  }
  assertLocalDatabaseIsolation();
  await startIsolatedLocalServer();
  currentStage = "browser_launch";
  browserLaunchAttempted = true;
  const browser = (browserInstance = await chromium.launch({ headless: true }));
  let context;
  currentStage = "context_and_routes";
  context = contextInstance = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  if (mode === "real") {
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== baseUrl) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }
  const mockFixture = mode === "mock" ? await installMock(context) : null;

  let activeOperation = null;
  let activeAssetWindow = null;
  const assetResponses = [];
  const pendingRequests = new Map();
  let requestOrder = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    const resourceType = request.resourceType();
    let asset;
    if (activeAssetWindow && ["script", "stylesheet", "font"].includes(resourceType)) {
      asset = {
        request_window: activeAssetWindow,
        resource_type: resourceType,
        pathname: url.pathname,
        http_status: null,
        content_length_bytes: null,
        content_encoding: null,
      };
    }
    const kind = requestKind(url, request.method());
    const record = {
      kind,
      method: request.method(),
      pathname: url.pathname,
      startedAt: Date.now(),
      responseAt: null,
      status: null,
      failure: null,
      order: requestOrder++,
      asset,
    };
    pendingRequests.set(request, record);
    if (activeOperation && kind) {
      activeOperation.recordRequest(record);
    }
  });
  page.on("response", (response) => {
    const record = pendingRequests.get(response.request());
    if (record?.asset) {
      const headers = response.headers();
      const contentLength = headers["content-length"];
      record.asset.http_status = response.status();
      record.asset.content_length_bytes =
        contentLength !== undefined && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
      record.asset.content_encoding = headers["content-encoding"] ?? null;
      assetResponses.push(record.asset);
    }
    if (record) {
      record.responseAt = Date.now();
      record.status = response.status();
    }
  });
  page.on("requestfinished", (request) => {
    const record = pendingRequests.get(request);
    if (record) record.finishedAt = Date.now();
  });
  page.on("requestfailed", (request) => {
    const record = pendingRequests.get(request);
    if (record) {
      record.finishedAt = Date.now();
      record.failure = request.failure()?.errorText ?? null;
    }
  });

  currentStage = "admin_navigation";
  activeAssetWindow = "initial_admin_navigation";
  const startupRequestsStartedAt = Date.now();
  const startupStartedAt = performance.now();
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").waitFor({ state: "visible" });
  const pinVisibleAt = performance.now();
  await collectBrowserResourceTimings(page, "initial_admin_navigation");
  activeAssetWindow = null;
  currentStage = "admin_login";
  await page.getByLabel("管理者 PIN").fill(pin);
  const loginSubmitAt = performance.now();
  await page.getByRole("button", { name: "管理ページにログイン" }).click();
  await page.getByText(/現在の状態：/).waitFor();
  const authenticatedStateAt = performance.now();
  currentStage = "start_presentation";
  const startClickAt = performance.now();
  await page.getByRole("button", { name: "発表を開始" }).click();
  if (mode === "mock") await page.getByText("現在の状態：進行中：問題").waitFor();
  else await page.getByRole("button", { name: "発表を開始" }).waitFor({ state: "detached" });
  const startFinishedAt = performance.now();
  const startupRequestsEndedAt = Date.now();
  const startupRequests = classifiedRequestSequence(
    pendingRequests,
    startupRequestsStartedAt,
    startupRequestsEndedAt,
  );

  currentStage = "authenticated_admin_reload";
  activeAssetWindow = "authenticated_admin_reload_same_context";
  const reloadRequestsStartedAt = Date.now();
  const authenticatedReloadStartedAt = performance.now();
  await page.goto("/admin/presentation");
  if (mode === "mock") await page.getByText("現在の状態：進行中：問題").waitFor();
  else await page.getByRole("button", { name: "発表を開始" }).waitFor({ state: "detached" });
  const authenticatedStateReadyAt = performance.now();
  const reloadRequestsEndedAt = Date.now();
  await collectBrowserResourceTimings(page, "authenticated_admin_reload_same_context");
  activeAssetWindow = null;
  const authenticatedReloadRequests = classifiedRequestSequence(
    pendingRequests,
    reloadRequestsStartedAt,
    reloadRequestsEndedAt,
  );

  // Presenter navigation is kept outside the warm interaction samples.
  activeAssetWindow = "presenter_navigation_same_context";
  const presenterStartedAt = performance.now();
  let presenterDeckWait;
  const presenterDeckRequest = (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/admin/presentation/deck" && response.request().method() === "GET") {
      const requestRecord = pendingRequests.get(response.request());
      if (requestRecord?.startedAt !== undefined) {
        presenterDeckWait = Date.now() - requestRecord.startedAt;
      }
    }
  };
  page.on("response", presenterDeckRequest);
  currentStage = "presenter_navigation";
  await page.goto("/presentation?presenter=1");
  await page.getByTestId("presentation-canvas").waitFor();
  currentStage = "presenter_slide_ready";
  if (mode === "real") {
    await page.waitForFunction(() => document.body.innerText.includes("発表を開始しました"));
    await page.locator("main").press("ArrowRight");
  }
  await page
    .getByRole("heading", {
      name: mode === "real" ? realFixtureQuestionTitle : question.question,
      exact: true,
    })
    .waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  if (mode === "real") await assertRealStateSync(page, "question");
  await collectBrowserResourceTimings(page, "presenter_navigation_same_context");
  activeAssetWindow = null;
  page.off("response", presenterDeckRequest);
  addSample("cold_deck_load", "navigation_to_dom_2raf_ms", performance.now() - presenterStartedAt);
  if (presenterDeckWait !== undefined) {
    addSample("cold_deck_load", "deck_get_wait_ms", presenterDeckWait);
  }

  currentStage = "instrumentation_setup";
  const installBrowserInstrumentation = async () =>
    page.evaluate(() => {
      const root = document.querySelector('[data-testid="presentation-canvas"]');
      if (!root) return;
      const bench = {
        inputAt: null,
        lastInputAt: null,
        lastInputId: null,
        nextInputId: 0,
        inputs: [],
        releaseAt: null,
        gestureStartAt: null,
        projectionMs: null,
        projectionAt: null,
        posts: [],
        instrumentationError: null,
        onNextPostStart: null,
        busyBurstInputIds: [],
        burstDispatchInputIds: [],
        burstDispatchError: null,
        armed: false,
      };
      window.__presentationBench = bench;
      const nativeFetch = window.fetch;
      window.fetch = function (...args) {
        let record = null;
        try {
          if (bench.armed) {
            const [input, init] = args;
            const requestUrl =
              typeof input === "string" ? input : input instanceof Request ? input.url : null;
            if (requestUrl !== null) {
              const url = new URL(requestUrl, location.href);
              const baseMethod = input instanceof Request ? input.method : "GET";
              const initIsSupported =
                init === undefined ||
                init === null ||
                (typeof init === "object" && Object.getPrototypeOf(init) === Object.prototype);
              const methodDescriptor =
                init !== null && typeof init === "object"
                  ? Object.getOwnPropertyDescriptor(init, "method")
                  : null;
              const methodIsSupported = !methodDescriptor || "value" in methodDescriptor;
              const method = methodDescriptor?.value ?? baseMethod;
              if (url.pathname === "/api/admin/presentation" && method.toUpperCase() === "POST") {
                if (!initIsSupported || !methodIsSupported || typeof input !== "string") {
                  bench.instrumentationError = "unsupported_presentation_post_fetch_contract";
                } else {
                  record = {
                    inputId: bench.lastInputId,
                    inputAt: bench.lastInputAt,
                    startedAt: performance.now(),
                    endedAt: null,
                    status: null,
                    failure: null,
                  };
                  bench.posts.push(record);
                }
              }
            }
          }
        } catch {
          bench.instrumentationError = "fetch_instrumentation_unavailable";
        }
        let result;
        try {
          result = Reflect.apply(nativeFetch, this, args);
        } catch (error) {
          if (record) {
            try {
              record.endedAt = performance.now();
              record.failure = "sync_throw";
            } catch {
              bench.instrumentationError = "fetch_completion_instrumentation_unavailable";
            }
          }
          throw error;
        }
        if (record && bench.onNextPostStart) {
          const hook = bench.onNextPostStart;
          bench.onNextPostStart = null;
          try {
            hook(record);
          } catch {
            bench.instrumentationError = "post_start_burst_dispatch_failed";
          }
        }
        if (record) {
          try {
            const observed = result.then(
              (response) => {
                try {
                  record.endedAt = performance.now();
                  record.status = response.status;
                } catch {
                  bench.instrumentationError = "fetch_completion_instrumentation_unavailable";
                }
              },
              () => {
                try {
                  record.endedAt = performance.now();
                  record.failure = "promise_rejected";
                } catch {
                  bench.instrumentationError = "fetch_completion_instrumentation_unavailable";
                }
              },
            );
            if (observed && typeof observed.catch === "function") {
              observed.catch(() => {
                try {
                  record.endedAt ??= performance.now();
                  record.failure ??= "observation_rejected";
                } catch {
                  // Never let instrumentation create an unhandled rejection.
                }
              });
            }
          } catch {
            bench.instrumentationError = "fetch_completion_instrumentation_unavailable";
          }
        }
        return result;
      };
      const finish = () => {
        if (!bench.armed || bench.projectionMs !== null) return;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (bench.inputAt !== null) {
              bench.projectionAt = performance.now();
              bench.projectionMs = bench.projectionAt - bench.inputAt;
            }
          }),
        );
      };
      const input = (event) => {
        if (event.type === "keydown" && !["ArrowRight", "ArrowLeft", " "].includes(event.key))
          return;
        if (event.type === "pointerdown" && event.button !== 0) return;
        if (!bench.armed) return;
        const now = performance.now();
        if (event.type === "keydown" || event.type === "pointerdown") {
          const id = bench.nextInputId++;
          bench.inputs.push({ id, at: now, type: event.type });
          if (bench.inputAt === null) bench.inputAt = now;
          bench.lastInputAt = now;
          bench.lastInputId = id;
        }
        if (event.type === "pointerdown") bench.gestureStartAt = now;
        if (event.type === "pointerup") bench.releaseAt = now;
      };
      document.addEventListener("keydown", input, true);
      document.addEventListener("pointerdown", input, true);
      document.addEventListener("pointerup", input, true);
      new MutationObserver(finish).observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      window.__presentationBenchArm = () => {
        bench.inputAt = null;
        bench.lastInputAt = null;
        bench.lastInputId = null;
        bench.nextInputId = 0;
        bench.inputs = [];
        bench.releaseAt = null;
        bench.gestureStartAt = null;
        bench.projectionMs = null;
        bench.projectionAt = null;
        bench.posts = [];
        bench.instrumentationError = null;
        bench.onNextPostStart = null;
        bench.busyBurstInputIds = [];
        bench.burstDispatchInputIds = [];
        bench.burstDispatchError = null;
        bench.burstDispatchEventCount = 0;
        bench.burstDispatchRecords = [];
        bench.armed = true;
      };
    });
  await installBrowserInstrumentation();

  const mainRegion = page.locator("main");
  const bounds = await mainRegion.boundingBox();
  if (!bounds) throw new Error("measurement_invariant");
  const environmentMetadata = await collectEnvironmentMetadata(page, browser);
  visualArtifacts.before = await captureVisualArtifact(page, "before", visualArtifactQuestionTitle);

  currentStage = "measurement";
  for (let iteration = 0; iteration < sampleRepeats; iteration += 1) {
    for (const definition of definitions) {
      let failureDiagnostics = { stage: currentStage };
      let operation = null;
      try {
        currentStage = `warm_sample_${definition.name}`;
        if (mode === "real") {
          await resetRealFixtureToQuestion(page, `trial-${iteration}-${definition.name}`);
          await installBrowserInstrumentation();
        } else {
          await resetMockFixtureToQuestion(page, mockFixture, { reload: true });
          await installBrowserInstrumentation();
        }
        if (definition.action === "previous") {
          currentStage = "warm_sample_setup_answer_state";
          await performUnmeasuredKeyboardAction(page, "ArrowRight", (tracker) => {
            activeOperation = tracker;
          });
          await page
            .locator('[role="status"][aria-live="polite"]')
            .filter({ hasText: /^第1問の解説$/ })
            .waitFor({ timeout: 10_000 });
          currentStage = `warm_sample_${definition.name}`;
        }
        operation = createOperationTracker();
        activeOperation = operation;
        await page.evaluate(() => window.__presentationBenchArm());
        if (definition.input === "keyboard") {
          await mainRegion.press(definition.action === "advance" ? "ArrowRight" : "ArrowLeft");
        } else if (definition.input === "click") {
          await page.mouse.click(
            bounds.x + bounds.width * (definition.action === "advance" ? 0.8 : 0.2),
            bounds.y + bounds.height / 2,
          );
        } else {
          const startX = bounds.x + bounds.width * (definition.action === "advance" ? 0.8 : 0.2);
          const endX = bounds.x + bounds.width * (definition.action === "advance" ? 0.2 : 0.8);
          const y = bounds.y + bounds.height / 2;
          await page.mouse.move(startX, y);
          await page.mouse.down();
          await page.mouse.move(endX, y, { steps: 5 });
          await page.mouse.up();
        }

        await withTimeout(operation.firstPost, 10_000, "primary_action_not_started");
        const inputStartedAt = await page.evaluate(() => window.__presentationBench.inputAt);
        const gesture = await page.evaluate(() => ({
          start: window.__presentationBench.gestureStartAt,
          release: window.__presentationBench.releaseAt,
        }));
        if (!Number.isFinite(inputStartedAt)) {
          failureDiagnostics = await page.evaluate(() => ({
            stage: "primary_post_started_input_timestamp_missing",
            browser_inputs:
              window.__presentationBench?.inputs?.map(({ id, at, type }) => ({
                id,
                at,
                type,
              })) ?? [],
            browser_posts:
              window.__presentationBench?.posts?.map(
                ({ inputId, inputAt, startedAt, endedAt, status, failure }) => ({
                  input_id: inputId,
                  input_at: inputAt,
                  started_at: startedAt,
                  ended_at: endedAt,
                  status,
                  failure,
                }),
              ) ?? [],
            instrumentation_error: window.__presentationBench?.instrumentationError ?? null,
          }));
          failureDiagnostics.invariant_failures = ["input_timestamp_missing"];
          throw new Error("measurement_invariant:input_timestamp_missing");
        }
        currentStage = `freeze_primary_paint_${definition.name}`;
        await page.waitForFunction(() => window.__presentationBench?.projectionMs !== null, null, {
          timeout: 10_000,
        });
        const primaryPaint = await page.evaluate(() => ({
          projectionMs: window.__presentationBench.projectionMs,
          projectionAt: window.__presentationBench.projectionAt,
        }));
        const primaryRequestCount = operation.requests.length;
        const reverseKey = definition.action === "advance" ? "ArrowLeft" : "ArrowRight";
        currentStage = `next_save_probe_${definition.name}`;
        const nextInput = await dispatchSingleInverseInput(page, operation, reverseKey);
        await withTimeout(
          Promise.all([
            operation.secondPost,
            page.waitForFunction(
              (inputId) =>
                window.__presentationBench?.posts?.some((post) => post.inputId === inputId) ??
                false,
              nextInput.id,
              { timeout: 15_000 },
            ),
          ]),
          15_000,
          "next_save_not_dispatched",
        );
        await waitForOperationQuiet(operation);
        await page.waitForFunction(
          () => window.__presentationBench.posts.slice(0, 2).every((post) => post.endedAt !== null),
          null,
          { timeout: 5_000 },
        );
        const browserMetrics = await page.evaluate(() => ({
          projectionMs: window.__presentationBench.projectionMs,
          projectionAt: window.__presentationBench.projectionAt,
          posts: window.__presentationBench.posts,
          inputs: window.__presentationBench.inputs,
          instrumentationError: window.__presentationBench.instrumentationError,
        }));
        const nextSaveBrowserPost = browserMetrics.posts.find(
          (post) => post.inputId === nextInput.id,
        );
        failureDiagnostics = {
          stage: currentStage,
          browser_inputs: browserMetrics.inputs.map(({ id, at, type }) => ({ id, at, type })),
          browser_posts: browserMetrics.posts.map(
            ({ inputId, inputAt, startedAt, endedAt, status, failure }) => ({
              input_id: inputId,
              input_at: inputAt,
              started_at: startedAt,
              ended_at: endedAt,
              status,
              failure,
            }),
          ),
          instrumentation_error: browserMetrics.instrumentationError,
          node_requests: operation.requests.map((request) => ({
            kind: request.kind,
            order: request.order,
            status: request.status,
            failure: request.failure === null ? null : "request_failed",
            started_at: request.startedAt,
            response_at: request.responseAt,
            finished_at: request.finishedAt,
          })),
          probe_input_ids: operation.probeInputIds ?? [],
          probe_attempt_count: operation.probeAttempts ?? 0,
          next_input_id: nextInput.id,
          next_input_at: nextInput.at,
          input_started_at: inputStartedAt,
          projection_at: browserMetrics.projectionAt,
          projection_ms: browserMetrics.projectionMs,
          swipe_start_at: gesture.start,
          swipe_release_at: gesture.release,
        };
        const projectionMs = primaryPaint.projectionMs;
        const primaryPost = browserMetrics.posts[0];
        const acceptedPost = nextSaveBrowserPost;
        if (mode === "real") {
          const client = createIsolatedDbClient();
          let expectedState;
          try {
            const result = await client.execute(
              "SELECT state FROM presentation_sessions WHERE id = 1",
            );
            expectedState = result.rows[0]?.state;
          } finally {
            await client.close();
          }
          await assertRealStateSync(page, expectedState);
        }
        activeOperation = null;
        const primaryRequests = operation.requests.slice(0, primaryRequestCount);
        const invariantFailures = [];
        if (primaryRequests.filter((record) => record.kind === "post").length !== 1) {
          invariantFailures.push("primary_post_count");
        }
        if (operation.posts.length !== 2 || browserMetrics.posts.length !== 2) {
          invariantFailures.push("total_post_count");
        }
        if (
          primaryPost?.status !== 200 ||
          acceptedPost?.status !== 200 ||
          primaryPost?.failure !== null ||
          acceptedPost?.failure !== null
        )
          invariantFailures.push("response_status_or_failure");
        if (browserMetrics.instrumentationError !== null) {
          invariantFailures.push("fetch_instrumentation");
        }
        if (
          browserMetrics.projectionMs !== primaryPaint.projectionMs ||
          browserMetrics.projectionAt !== primaryPaint.projectionAt
        ) {
          invariantFailures.push("primary_paint_changed_after_inverse_input");
        }
        const expectedPrimaryInputType =
          definition.input === "keyboard" ? "keydown" : "pointerdown";
        if (
          browserMetrics.inputs.length !== 2 ||
          primaryPost?.inputId !== browserMetrics.inputs[0]?.id ||
          browserMetrics.inputs[0]?.type !== expectedPrimaryInputType ||
          browserMetrics.inputs[1]?.id !== nextInput.id ||
          browserMetrics.inputs[1]?.type !== "keydown" ||
          acceptedPost?.inputId !== nextInput.id ||
          !operation.probeInputIds?.includes(acceptedPost?.inputId)
        )
          invariantFailures.push("input_id_pairing");
        if (
          ![
            inputStartedAt,
            primaryPost?.inputAt,
            primaryPost?.startedAt,
            primaryPost?.endedAt,
            acceptedPost?.inputAt,
            acceptedPost?.startedAt,
            projectionMs,
            primaryPaint.projectionAt,
          ].every(Number.isFinite)
        )
          invariantFailures.push("timestamps");
        if (
          definition.input === "swipe" &&
          (!Number.isFinite(gesture.start) || !Number.isFinite(gesture.release))
        )
          invariantFailures.push("swipe_timing");
        if (definition.input === "click" && browserMetrics.inputs[0]?.type !== "pointerdown")
          invariantFailures.push("click_pointerdown_missing");
        if (invariantFailures.length > 0) {
          failureDiagnostics.invariant_failures = invariantFailures;
          throw new Error(`measurement_invariant:${invariantFailures.join(",")}`);
        }
        recordRequestCountSample(definition.name, primaryRequests);
        addSample(definition.name, "input_to_dom_2raf_ms", projectionMs);
        addSample(
          definition.name,
          "input_to_post_start_ms",
          primaryPost.startedAt - primaryPost.inputAt,
        );
        addSample(
          definition.name,
          "post_start_to_response_ms",
          primaryPost.endedAt - primaryPost.startedAt,
        );
        addSample(
          definition.name,
          "next_input_to_next_save_dispatch_ms",
          acceptedPost.startedAt - nextInput.at,
        );
        if (
          definition.input === "swipe" &&
          Number.isFinite(gesture.start) &&
          Number.isFinite(gesture.release)
        ) {
          addSample(definition.name, "swipe_start_to_release_ms", gesture.release - gesture.start);
          addSample(
            definition.name,
            "swipe_release_to_dom_2raf_ms",
            primaryPaint.projectionAt - gesture.release,
          );
        }
        addSample(
          definition.name,
          "max_window_http_request_duration_ms",
          Math.max(
            0,
            ...primaryRequests.map(
              (record) =>
                (record.finishedAt ?? record.responseAt ?? record.startedAt) - record.startedAt,
            ),
          ),
        );
        for (const kind of [
          "post",
          "window_session_get",
          "window_controls_get",
          "window_deck_get",
        ]) {
          const matches = primaryRequests.filter((record) => record.kind === kind);
          addSample(definition.name, `${kind}_count`, matches.length);
          addSample(
            definition.name,
            `${kind}_wait_ms`,
            matches.reduce(
              (sum, record) =>
                sum +
                ((record.responseAt ?? record.finishedAt ?? record.startedAt) - record.startedAt),
              0,
            ),
          );
        }
      } catch (error) {
        activeOperation = null;
        const reason = classifyFailure(error);
        const browserState = await page
          .evaluate(() => {
            const bench = window.__presentationBench;
            return bench
              ? {
                  inputs: bench.inputs.map(({ id, at, type }) => ({ id, at, type })),
                  posts: bench.posts.map(
                    ({ inputId, inputAt, startedAt, endedAt, status, failure }) => ({
                      input_id: inputId,
                      input_at: inputAt,
                      started_at: startedAt,
                      ended_at: endedAt,
                      status,
                      failure,
                    }),
                  ),
                  instrumentation_error: bench.instrumentationError,
                  projection_at: bench.projectionAt,
                  projection_ms: bench.projectionMs,
                }
              : null;
          })
          .catch(() => null);
        failureDiagnostics = {
          ...failureDiagnostics,
          stage: currentStage,
          browser: browserState,
          node_requests: (operation?.requests ?? []).map((request) => ({
            kind: request.kind,
            order: request.order,
            status: request.status,
            failure: request.failure === null ? null : "request_failed",
            started_at: request.startedAt,
            response_at: request.responseAt,
            finished_at: request.finishedAt,
          })),
          probe_input_ids: operation?.probeInputIds ?? [],
          probe_attempt_count: operation?.probeAttempts ?? 0,
        };
        operationFailures.get(definition.name).push(reason);
        process.stderr.write(
          `presentation sample failed operation=${definition.name} stage=${currentStage} reason=${reason}\n`,
        );
        operationFailureDetails.get(definition.name).push({
          reason,
          stage: currentStage,
          ...(failureDiagnostics.invariant_failures
            ? { invariant_failures: failureDiagnostics.invariant_failures }
            : {}),
          diagnostics: failureDiagnostics,
        });
      }
    }
  }

  const sanityScenarios = await runSanityScenarios(
    page,
    mockFixture,
    (value) => {
      activeOperation = value;
    },
    installBrowserInstrumentation,
  );
  const mockCoverageScenarios =
    mode === "mock"
      ? await runMockCoverageScenarios(
          page,
          mockFixture,
          (value) => {
            activeOperation = value;
          },
          installBrowserInstrumentation,
        )
      : {
          start_boundary: { status: "not_applicable", reason: "synthetic_mock_fixture_only" },
          end_boundary: { status: "not_applicable", reason: "synthetic_mock_fixture_only" },
          rank_boundaries: { status: "not_applicable", reason: "synthetic_mock_fixture_only" },
          empty_deck: { status: "not_applicable", reason: "synthetic_mock_fixture_only" },
          large_deck_long_text: { status: "not_applicable", reason: "synthetic_mock_fixture_only" },
          controlled_slow_poll_overlap: {
            status: "not_applicable",
            reason: "synthetic_mock_fixture_only",
          },
          controlled_failure: { status: "not_applicable", reason: "synthetic_mock_fixture_only" },
        };
  currentStage = "visual_artifact_core_operation";
  visualArtifacts.after = await captureCoreOperationAfterArtifact(page, mockFixture);
  currentStage = "summary_output";
  const output = {};
  output.run = {
    mode,
    source_fingerprint_sha256: sourceFingerprint,
    sample_repeats: sampleRepeats,
    primary_samples_per_operation: sampleRepeats,
    fixture: mode === "real" ? "isolated_local_sqlite_real_routes" : "mock_routes",
    environment: environmentMetadata,
    visual_artifacts: {
      screenshots: visualArtifacts,
      directory_persists_after_run: true,
      status:
        visualArtifacts.before.question_title === visualArtifacts.after.question_title
          ? "measured"
          : "failed",
      before_state: "question",
      after_state: "answer_after_core_advance",
      before_question_title: visualArtifacts.before.question_title,
      after_question_title: visualArtifacts.after.question_title,
      same_synthetic_question_title_verified:
        visualArtifacts.before.question_title === visualArtifacts.after.question_title,
      contents:
        "Actual heading text was captured before and after a core advance; titles are compared in the report.",
      latency_inference: "none; screenshots illustrate state only",
    },
    dom_metric: "DOM mutation plus two requestAnimationFrame callbacks (paint proxy)",
    next_action_probe: {
      status: "measured",
      method:
        "Freeze the primary DOM paint proxy, dispatch one inverse keyboard input, then await its inputId-correlated position save with a 15-second timeout.",
      metric: "next_input_to_next_save_dispatch_ms",
      interpretation:
        "Elapsed time from inverse input to the correlated save dispatch; includes local persistence queue wait and is not UI admission latency or pure queue delay.",
      legacy_metrics: {
        busy_window_probe_count: "not_applicable; repeated probes are no longer dispatched",
        lost_input_count: "not_applicable; this sample dispatches only one inverse input",
        input_to_next_accepted_action_ms:
          "not_applicable; local navigation is accepted before the position save",
        next_input_to_post_start_ms:
          "deprecated_noncomparable; use next_input_to_next_save_dispatch_ms",
      },
    },
    causality_note:
      "GET requests overlapping an interaction window can be periodic polling; their operation attribution is uncertain.",
    coverage_caveats: [
      "unmatched_busy_input_count is a synthetic busy-input proxy, not a complete lost-input measure.",
      "burst inputs are synthetic keyboard events, not physical user input.",
      "GET request attribution is uncertain when polling overlaps an operation.",
      "latency instrumentation observes fetch only and supports the current plain-string URL POST contract.",
      "successful primary sample counts can be below 30; inspect per-operation missing and failure counts.",
    ],
    old_output_format_changed: true,
  };
  output.sanity_scenarios = sanityScenarios;
  output.synthetic_mock_coverage_scenarios = mockCoverageScenarios;
  for (const [name, metrics] of samples) {
    const isPrimaryOperation = operationFailures.has(name);
    const successfulSamples = isPrimaryOperation
      ? (metrics.get("input_to_dom_2raf_ms")?.length ?? 0)
      : Math.max(0, ...[...metrics.values()].map((values) => values.length));
    output[name] = isPrimaryOperation
      ? {
          expected_samples: sampleRepeats,
          successful_samples: successfulSamples,
          failed_samples: operationFailures.get(name).length,
          missing_samples: Math.max(0, sampleRepeats - successfulSamples),
          failure_reasons: countReasons(operationFailures.get(name)),
          failure_details: operationFailureDetails.get(name),
        }
      : { sample_count: successfulSamples };
    for (const [metric, values] of metrics) {
      output[name][metric] = metric.endsWith("_count")
        ? countSummary(values)
        : summary(values, name === "cold_deck_load" ? 1 : sampleRepeats);
    }
    if (isPrimaryOperation) {
      output[name].request_counts = summarizeRequestCountSamples(
        requestCountSamples.get(name) ?? [],
      );
    }
  }
  for (const [name, failures] of operationFailures) {
    if (output[name]) continue;
    output[name] = {
      expected_samples: sampleRepeats,
      successful_samples: 0,
      failed_samples: failures.length,
      missing_samples: sampleRepeats,
      failure_reasons: countReasons(failures),
      failure_details: operationFailureDetails.get(name),
      request_counts: summarizeRequestCountSamples(requestCountSamples.get(name) ?? []),
    };
  }
  for (const name of operationFailures.keys()) {
    output[name].next_input_to_next_save_dispatch_ms ??= summary([], sampleRepeats);
    output[name].busy_window_probe_count = {
      ...countSummary([]),
      status: "not_applicable",
      reason: "The sample dispatches exactly one inverse input.",
    };
    output[name].lost_input_count = {
      ...countSummary([]),
      status: "not_applicable",
      reason: "The sample dispatches exactly one inverse input.",
    };
    output[name].input_to_next_accepted_action_ms = {
      ...summary([], sampleRepeats),
      status: "not_applicable",
      reason: "The app accepts navigation locally before the position save is dispatched.",
    };
    output[name].next_input_to_post_start_ms = {
      ...summary([], sampleRepeats),
      status: "deprecated_noncomparable",
      replaced_by: "next_input_to_next_save_dispatch_ms",
    };
  }
  output.startup_cold_sample = {
    sample_count: 1,
    timings_ms: {
      page_goto_to_pin_visible: pinVisibleAt - startupStartedAt,
      login_submit_to_authenticated_state: authenticatedStateAt - loginSubmitAt,
      start_click_to_started_state: startFinishedAt - startClickAt,
    },
    requests: startupRequests,
  };
  output.authenticated_admin_reload_sample = {
    sample_count: 1,
    timings_ms: {
      navigation_to_state_ready: authenticatedStateReadyAt - authenticatedReloadStartedAt,
    },
    requests: authenticatedReloadRequests,
    limitations: "Single same-context reload; cache state is warm/unknown, not a true cold load.",
  };
  output.browser_asset_responses = {
    byte_measurement:
      "Content-Length payload bytes when present; excludes response headers and TLS.",
    limitations:
      "Same-context reload and presenter navigation are cache-warm/unknown, not true cold loads. Responses without Content-Length are included in counts but not byte sums.",
    windows: summarizeAssetWindows(assetResponses),
    responses: assetResponses,
  };
  output.browser_resource_timing = {
    source:
      "PerformanceResourceTiming entries observed by this browser for script, stylesheet, and font resources; values are not production-wide asset totals.",
    transfer_size_note:
      "A transferSize of 0 can indicate cache reuse or unavailable transfer detail; it does not establish a zero-byte resource.",
    windows: browserResourceTimingWindows,
  };
  const totalFailedSamples = [...operationFailures.values()].reduce(
    (sum, failures) => sum + failures.length,
    0,
  );
  const incompleteSanityScenarios = [
    ...Object.values(sanityScenarios),
    ...Object.values(mockCoverageScenarios),
  ].filter((scenario) => !["measured", "not_applicable"].includes(scenario.status)).length;
  output.run.status =
    totalFailedSamples > 0 ||
    incompleteSanityScenarios > 0 ||
    visualArtifacts.before.question_title !== visualArtifacts.after.question_title
      ? "partial"
      : "complete";
  output.run.total_failed_samples = totalFailedSamples;
  output.run.incomplete_sanity_scenarios = incompleteSanityScenarios;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  await cleanupResources();
}

function recordRequestCountSample(name, requests) {
  let byName = requestCountSamples.get(name);
  if (!byName) {
    byName = [];
    requestCountSamples.set(name, byName);
  }
  const byMethodAndPathname = {};
  let postCount = 0;
  let getCount = 0;
  let deckGetCount = 0;
  let controlsGetCount = 0;
  for (const request of requests) {
    const key = `${request.method} ${request.pathname}`;
    byMethodAndPathname[key] = (byMethodAndPathname[key] ?? 0) + 1;
    if (request.method === "POST") postCount += 1;
    if (request.method === "GET") getCount += 1;
    if (request.method === "GET" && request.pathname === "/api/admin/presentation/deck") {
      deckGetCount += 1;
    }
    if (
      request.method === "GET" &&
      request.pathname === "/api/admin/presentation" &&
      request.kind === "window_controls_get"
    ) {
      controlsGetCount += 1;
    }
  }
  byName.push({
    total_requests: requests.length,
    post_count: postCount,
    get_count: getCount,
    deck_get_count: deckGetCount,
    controls_get_count: controlsGetCount,
    by_method_and_pathname: byMethodAndPathname,
  });
}

function summarizeRequestCountSamples(samplesForInteraction) {
  const metrics = [
    "total_requests",
    "post_count",
    "get_count",
    "deck_get_count",
    "controls_get_count",
  ];
  const keys = new Set(
    samplesForInteraction.flatMap((sample) => Object.keys(sample.by_method_and_pathname)),
  );
  const byMethodAndPathname = {};
  for (const key of [...keys].sort()) {
    byMethodAndPathname[key] = countSummary(
      samplesForInteraction.map((sample) => sample.by_method_and_pathname[key] ?? 0),
    );
  }
  return {
    sample_count: samplesForInteraction.length,
    ...Object.fromEntries(
      metrics.map((metric) => [
        metric,
        countSummary(samplesForInteraction.map((sample) => sample[metric])),
      ]),
    ),
    by_method_and_pathname: byMethodAndPathname,
    pathname_note:
      "Query strings are omitted. GET counts are action-window counts and may include overlapping polls; they do not establish operation causality.",
  };
}

function summarizeAssetWindows(responses) {
  const windows = {};
  for (const response of responses) {
    let window = windows[response.request_window];
    if (!window) {
      window = { resource_types: {} };
      windows[response.request_window] = window;
    }
    let type = window.resource_types[response.resource_type];
    if (!type) {
      type = { response_count: 0, content_length_bytes_sum: 0, content_length_present_count: 0 };
      window.resource_types[response.resource_type] = type;
    }
    type.response_count += 1;
    if (response.content_length_bytes !== null) {
      type.content_length_bytes_sum += response.content_length_bytes;
      type.content_length_present_count += 1;
    }
  }
  return windows;
}

function requestKind(url, method) {
  if (url.pathname === "/api/admin/presentation" && method === "POST") return "post";
  if (url.pathname === "/api/admin/session" && method === "POST") return "session_post";
  if (url.pathname === "/api/admin/session" && method === "GET") return "window_session_get";
  if (
    url.pathname === "/api/admin/presentation" &&
    method === "GET" &&
    url.searchParams.get("view") !== "controls"
  ) {
    return "state_get";
  }
  if (
    url.pathname === "/api/admin/presentation" &&
    method === "GET" &&
    url.searchParams.get("view") === "controls"
  ) {
    return "window_controls_get";
  }
  if (url.pathname === "/api/admin/presentation/deck" && method === "GET") {
    return "window_deck_get";
  }
  return null;
}

function classifiedRequestSequence(pendingRequests, startedAt, endedAt) {
  return [...pendingRequests.values()]
    .filter((record) => record.kind && record.startedAt >= startedAt && record.startedAt <= endedAt)
    .sort((a, b) => a.order - b.order)
    .map((record) => {
      const completedAt = record.finishedAt ?? record.responseAt;
      return {
        kind: record.kind,
        http_status: record.status,
        request_failure: record.failure,
        response_or_finish_wait_ms:
          completedAt === undefined ? null : completedAt - record.startedAt,
      };
    });
}

async function waitForOperationQuiet(operation) {
  const deadline = Date.now() + 15_000;
  let observedCount = -1;
  let lastActivity = Date.now();
  while (Date.now() < deadline) {
    const count = operation.requests.length;
    const latestFinished = operation.requests.reduce(
      (latest, request) =>
        Math.max(latest, request.finishedAt ?? request.responseAt ?? request.startedAt),
      lastActivity,
    );
    if (count !== observedCount || latestFinished > lastActivity) {
      observedCount = count;
      lastActivity = Math.max(Date.now(), latestFinished);
    }
    const allFinished = operation.requests.every((request) => request.finishedAt !== undefined);
    if (allFinished && Date.now() - latestFinished >= 50) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("measurement unavailable");
}

main().catch(async (error) => {
  const failureClass = classifyStageFailure(currentStage, error);
  const reason =
    currentStage === "browser_launch" && browserLaunchAttempted
      ? "browser_launch_failed"
      : classifyFailure(error);
  process.stderr.write(`presentation measurement failed stage=${currentStage} reason=${reason}\n`);
  process.stdout.write(
    `${JSON.stringify({
      run: {
        mode,
        source_fingerprint_sha256: sourceFingerprint,
        status: "failed",
        stage: currentStage,
        failure_reason: reason,
        failure_class: failureClass,
        sanitized_message: reason,
        failure_diagnostics: {
          runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
          },
          browser: {
            launch_attempted: browserLaunchAttempted,
            launched: browserInstance !== undefined,
            version: null,
            user_agent: null,
            unavailable_reason:
              browserLaunchAttempted && !browserInstance ? reason : "not_collected",
            failure_class:
              currentStage === "browser_launch" && browserLaunchAttempted
                ? classifyBrowserLaunchFailure(error)
                : null,
          },
          server: {
            expected_address: `${host}:${port}`,
            started: localServer !== undefined,
            readiness_confirmed: localServerReady,
            pid: localServer?.pid ?? null,
            exit_code: localServer?.exitCode ?? null,
            signal_code: localServer?.signalCode ?? null,
            failure_class:
              currentStage === "server_preflight" || currentStage === "server_startup"
                ? failureClass
                : null,
          },
          database: {
            mode:
              mode === "real"
                ? "isolated_disposable_sqlite_real_routes"
                : "isolated_disposable_sqlite_with_mocked_app_api_routes",
            temp_fixture_created: dbPath !== undefined,
            query_count: null,
            query_count_status: "not_instrumented",
            failure_class: currentStage === "database_seed" ? failureClass : null,
          },
        },
      },
      operations: Object.fromEntries(
        [...operationFailures].map(([name, failures]) => {
          const successfulSamples = samples.get(name)?.get("input_to_dom_2raf_ms")?.length ?? 0;
          return [
            name,
            {
              expected_samples: sampleRepeats,
              successful_samples: successfulSamples,
              failed_samples: failures.length,
              missing_samples: Math.max(0, sampleRepeats - successfulSamples),
              failure_reasons: countReasons(failures),
            },
          ];
        }),
      ),
    })}\n`,
  );
  await cleanupResources();
  process.exitCode = 1;
});
