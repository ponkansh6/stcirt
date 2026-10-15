/*
 * Reproducible comparison:
 * Start the selected old HEAD or current app server with its usual PIN/session
 * secret configuration and set BASE_URL to it. Keep E2E_ADMIN_PRESENTATION_PIN
 * equal to that server's admin PIN (default 7316); the secret remains server-side.
 * Fixture data and mock delay are identical across revisions; hold
 * PRESENTATION_BENCH_DELAY_MS and PRESENTATION_BENCH_SAMPLES constant. The login
 * session POST falls through to the real app route. Session reads, admin
 * presentation GET/POST, deck GET, and public projection GET are mocked here.
 * DOM mutation plus two rAF callbacks is only a paint approximation. Each warm
 * sample probes the inverse keyboard action at short intervals. The start of the
 * second POST is the observable proxy for next-action acceptance;
 * that action also restores the prior stage. HTTP completion remains a separate
 * proxy, not direct mutation-unlock timing. GETs
 * inside an interaction window are labeled window GETs because a periodic poll
 * can overlap; those counts do not establish operation causality or zero extra GETs.
 * Presenter click always advances in the current UI. Previous is measured by
 * keyboard and swipe; no click-to-previous gesture is invented.
 * Run with: BASE_URL=http://localhost:3000 node scripts/measure-presentation-latency.mjs
 */
import { chromium } from "@playwright/test";

const baseUrl = process.env.BASE_URL;
const pin = process.env.E2E_ADMIN_PRESENTATION_PIN ?? "7316";
const sampleRepeats = positiveInteger(process.env.PRESENTATION_BENCH_SAMPLES, 5);
const mockDelayMs = nonNegativeInteger(process.env.PRESENTATION_BENCH_DELAY_MS, 50);

if (!baseUrl) {
  process.stderr.write("BASE_URL is required\n");
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
let currentStage = "browser_launch";

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
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function summary(values) {
  return { p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) };
}

function countSummary(values) {
  return { p50_count: percentile(values, 0.5), p95_count: percentile(values, 0.95) };
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function probeUntilNextActionAccepted(page, tracker, key) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.evaluate((probeKey) => {
      const target = document.querySelector("main");
      if (!target) return;
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: probeKey, bubbles: true, cancelable: true }),
      );
    }, key);
    const accepted = await Promise.race([
      tracker.secondPost.then((record) => record),
      delay(12).then(() => null),
    ]);
    if (accepted) return accepted;
  }
  throw new Error("next_action_not_accepted");
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

async function performUnmeasuredKeyboardAction(page, key, setActiveOperation) {
  const tracker = createOperationTracker();
  setActiveOperation(tracker);
  await page.locator("main").press(key);
  await withTimeout(tracker.firstPost, 10_000, "primary_action_not_started");
  await waitForOperationQuiet(tracker);
  setActiveOperation(null);
}

function makeControls(state, version, hidden, snapshotRevision) {
  return {
    state,
    version,
    snapshotRevision,
    questionIndex: 0,
    questionCount: 1,
    projectionHidden: hidden,
  };
}

function makeDeck(snapshotRevision) {
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
  let version = 0;
  let hidden = false;
  let snapshotRevision = 1;

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
    await fulfill(route, makeDeck(snapshotRevision));
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
          await fulfill(route, makeControls(state, version, hidden, snapshotRevision));
        } else {
          await fulfill(route, {
            ...makeControls(state, version, hidden, snapshotRevision),
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
      if (body.action === "start" && state === "not_started") {
        snapshotRevision += 1;
        cursor = 1;
        state = states[cursor];
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
      await fulfill(route, makeControls(state, version, hidden, snapshotRevision));
    },
  );

  await context.route("**/api/presentation", async (route) => {
    const projection = hidden ? { state: "standby" } : projectionForState(state, snapshotRevision);
    await fulfill(route, projection);
  });
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
  const browser = await chromium.launch({ headless: true });
  currentStage = "context_and_routes";
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  await installMock(context);

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
  const startupStartedAt = Date.now();
  await page.goto("/admin/presentation");
  await page.getByLabel("管理者 PIN").waitFor({ state: "visible" });
  const pinVisibleAt = Date.now();
  await collectBrowserResourceTimings(page, "initial_admin_navigation");
  activeAssetWindow = null;
  currentStage = "admin_login";
  await page.getByLabel("管理者 PIN").fill(pin);
  const loginSubmitAt = Date.now();
  await page.getByRole("button", { name: "管理ページにログイン" }).click();
  await page.getByText(/現在の状態：/).waitFor();
  const authenticatedStateAt = Date.now();
  currentStage = "start_presentation";
  const startClickAt = Date.now();
  await page.getByRole("button", { name: "発表を開始" }).click();
  await page.getByText("現在の状態：進行中：問題").waitFor();
  const firstQuestionAt = Date.now();
  const startupRequests = classifiedRequestSequence(
    pendingRequests,
    startupStartedAt,
    firstQuestionAt,
  );

  currentStage = "authenticated_admin_reload";
  activeAssetWindow = "authenticated_admin_reload_same_context";
  const authenticatedReloadStartedAt = Date.now();
  await page.goto("/admin/presentation");
  await page.getByText("現在の状態：進行中：問題").waitFor();
  const authenticatedStateReadyAt = Date.now();
  await collectBrowserResourceTimings(page, "authenticated_admin_reload_same_context");
  activeAssetWindow = null;
  const authenticatedReloadRequests = classifiedRequestSequence(
    pendingRequests,
    authenticatedReloadStartedAt,
    authenticatedStateReadyAt,
  );

  // Presenter navigation is kept outside the warm interaction samples.
  activeAssetWindow = "presenter_navigation_same_context";
  const presenterStartedAt = Date.now();
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
  await page.getByRole("heading", { name: question.question }).waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await collectBrowserResourceTimings(page, "presenter_navigation_same_context");
  activeAssetWindow = null;
  page.off("response", presenterDeckRequest);
  addSample("cold_deck_load", "navigation_to_dom_2raf_ms", Date.now() - presenterStartedAt);
  if (presenterDeckWait !== undefined) {
    addSample("cold_deck_load", "deck_get_wait_ms", presenterDeckWait);
  }

  currentStage = "instrumentation_setup";
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="presentation-canvas"]');
    if (!root) return;
    const bench = { inputAt: null, projectionMs: null, armed: false };
    window.__presentationBench = bench;
    const finish = () => {
      if (!bench.armed || bench.projectionMs !== null) return;
      bench.armed = false;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (bench.inputAt !== null) {
            bench.projectionMs = performance.timeOrigin + performance.now() - bench.inputAt;
          }
        }),
      );
    };
    const input = (event) => {
      if (event.type === "keydown" && !["ArrowRight", "ArrowLeft", " "].includes(event.key)) return;
      if (event.type === "pointerdown" && event.button !== 0) return;
      if (bench.armed) bench.inputAt = performance.timeOrigin + performance.now();
    };
    document.addEventListener("keydown", input, true);
    document.addEventListener("pointerdown", input, true);
    new MutationObserver(finish).observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    window.__presentationBenchArm = () => {
      bench.inputAt = null;
      bench.projectionMs = null;
      bench.armed = true;
    };
  });

  const mainRegion = page.locator("main");
  const bounds = await mainRegion.boundingBox();
  if (!bounds) throw new Error("measurement_invariant");

  currentStage = "warm_samples";
  for (let iteration = 0; iteration < sampleRepeats; iteration += 1) {
    for (const definition of definitions) {
      currentStage = `warm_sample_${definition.name}`;
      if (definition.action === "previous" && definition.name === "keyboard_previous") {
        currentStage = "warm_sample_setup_answer_state";
        await performUnmeasuredKeyboardAction(page, "ArrowRight", (tracker) => {
          activeOperation = tracker;
        });
        currentStage = `warm_sample_${definition.name}`;
      }
      const operation = createOperationTracker();
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
      if (!Number.isFinite(inputStartedAt)) throw new Error("measurement_invariant");
      const reverseKey = definition.action === "advance" ? "ArrowLeft" : "ArrowRight";
      currentStage = `next_action_probe_${definition.name}`;
      const acceptedNextPost = await probeUntilNextActionAccepted(page, operation, reverseKey);
      await page.waitForFunction(() => window.__presentationBench?.projectionMs !== null, null, {
        timeout: 10_000,
      });
      const projectionMs = await page.evaluate(() => window.__presentationBench.projectionMs);
      await waitForOperationQuiet(operation);
      activeOperation = null;
      const primaryRequests = operation.requests.filter(
        (record) => record.order < acceptedNextPost.order,
      );
      recordRequestCountSample(definition.name, primaryRequests);
      const finishedAt = primaryRequests.reduce(
        (latest, record) => Math.max(latest, record.finishedAt ?? Date.now()),
        inputStartedAt,
      );

      addSample(definition.name, "input_to_dom_2raf_ms", projectionMs);
      addSample(
        definition.name,
        "input_to_last_window_http_completion_proxy_ms",
        finishedAt - inputStartedAt,
      );
      addSample(
        definition.name,
        "input_to_next_accepted_action_ms",
        acceptedNextPost.startedAt - inputStartedAt,
      );
      for (const kind of ["post", "window_session_get", "window_controls_get", "window_deck_get"]) {
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
      // Guard the benchmark contract without exposing page or response contents.
      if (
        primaryRequests.filter((record) => record.kind === "post").length !== 1 ||
        operation.posts.length !== 2
      ) {
        throw new Error("measurement_invariant");
      }
    }

    // The last inverse action leaves the presenter at answer. Return to question
    // outside the samples so every repeat starts from the same warm state.
    currentStage = "warm_cycle_reset";
    await performUnmeasuredKeyboardAction(page, "ArrowLeft", (tracker) => {
      activeOperation = tracker;
    });
  }

  currentStage = "summary_output";
  const output = {};
  for (const [name, metrics] of samples) {
    output[name] = {};
    for (const [metric, values] of metrics) {
      output[name][metric] = metric.endsWith("_count") ? countSummary(values) : summary(values);
    }
    output[name].request_counts = summarizeRequestCountSamples(requestCountSamples.get(name) ?? []);
  }
  output.startup_cold_sample = {
    sample_count: 1,
    timings_ms: {
      page_goto_to_pin_visible: pinVisibleAt - startupStartedAt,
      login_submit_to_authenticated_state: authenticatedStateAt - loginSubmitAt,
      start_click_to_first_question_state: firstQuestionAt - startClickAt,
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
  process.stdout.write(`${JSON.stringify(output)}\n`);
  await browser.close();
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
      "Query strings are omitted; counts use API requests recorded in this action window.",
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

main().catch((error) => {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "";
  let reason = "unexpected_error";
  if (/timeout/i.test(name) || /timeout/i.test(message)) reason = "timeout";
  else if (/measurement_invariant/.test(message)) reason = "measurement_invariant";
  else if (/primary_action_not_started|next_action_not_accepted/.test(message)) {
    reason = "action_not_accepted";
  } else if (/measurement unavailable/.test(message)) reason = "measurement_timeout";
  else if (/strict mode violation|not found|no element/i.test(message)) {
    reason = "page_element_unavailable";
  } else if (/net::ERR_|navigation failed/i.test(message)) {
    reason = "navigation_or_request_failed";
  } else if (currentStage === "browser_launch") reason = "browser_launch_failed";
  process.stderr.write(`presentation measurement failed stage=${currentStage} reason=${reason}\n`);
  process.exit(1);
});
