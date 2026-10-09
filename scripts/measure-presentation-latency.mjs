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

async function performUnmeasuredKeyboardAction(page, key, setActiveOperation) {
  const tracker = createOperationTracker();
  setActiveOperation(tracker);
  await page.locator("main").press(key);
  await withTimeout(tracker.firstPost, 10_000, "primary_action_not_started");
  await waitForOperationQuiet(tracker);
  setActiveOperation(null);
}

function makeControls(state, version, hidden = false) {
  return {
    state,
    version,
    questionIndex: 0,
    questionCount: 1,
    projectionHidden: hidden,
  };
}

function makeDeck() {
  const slides = ["question", "answer", "podium_preview", "third", "second", "first", "finished"];
  return {
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
  let snapshotRevision = 0;

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
      authenticated = body.pin === pin;
      await delay();
      await route.fallback();
    } else if (request.method() === "DELETE") {
      authenticated = false;
      await fulfill(route, { authenticated });
    } else {
      await fulfill(route, { error: "Method not allowed" }, 405);
    }
  });

  await context.route("**/api/admin/presentation/deck", async (route) => {
    await fulfill(route, makeDeck());
  });

  await context.route(
    (url) => url.pathname === "/api/admin/presentation",
    async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        const url = new URL(request.url());
        if (url.searchParams.get("view") === "controls") {
          await fulfill(route, makeControls(state, version, hidden));
        } else {
          await fulfill(route, {
            ...makeControls(state, version, hidden),
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
      await fulfill(route, makeControls(state, version, hidden));
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
  const pendingRequests = new Map();
  let requestOrder = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    const kind = requestKind(url, request.method());
    const record = { kind, startedAt: Date.now(), responseAt: null, order: requestOrder++ };
    pendingRequests.set(request, record);
    if (activeOperation && kind) {
      activeOperation.recordRequest(record);
    }
  });
  page.on("response", (response) => {
    const record = pendingRequests.get(response.request());
    if (record) record.responseAt = Date.now();
  });
  page.on("requestfinished", (request) => {
    const record = pendingRequests.get(request);
    if (record) record.finishedAt = Date.now();
  });
  page.on("requestfailed", (request) => {
    const record = pendingRequests.get(request);
    if (record) record.finishedAt = Date.now();
  });

  currentStage = "admin_navigation";
  await page.goto("/admin/presentation");
  currentStage = "admin_login";
  await page.getByLabel("管理者 PIN").fill(pin);
  await page.getByRole("button", { name: "管理ページにログイン" }).click();
  await page.getByText(/現在の状態：/).waitFor();
  currentStage = "start_presentation";
  await page.getByRole("button", { name: "発表を開始" }).click();
  await page.getByText("現在の状態：進行中：問題").waitFor();

  // Cold/deck-load sample is intentionally kept outside the warm interaction samples.
  const coldStartedAt = Date.now();
  let coldDeckWait;
  const coldDeckRequest = (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/admin/presentation/deck" && response.request().method() === "GET") {
      const requestRecord = pendingRequests.get(response.request());
      if (requestRecord?.startedAt !== undefined) {
        coldDeckWait = Date.now() - requestRecord.startedAt;
      }
    }
  };
  page.on("response", coldDeckRequest);
  currentStage = "cold_presenter_navigation";
  await page.goto("/presentation?presenter=1");
  await page.getByTestId("presentation-canvas").waitFor();
  currentStage = "cold_presenter_slide_ready";
  await page.getByRole("heading", { name: question.question }).waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  page.off("response", coldDeckRequest);
  addSample("cold_deck_load", "navigation_to_dom_2raf_ms", Date.now() - coldStartedAt);
  if (coldDeckWait !== undefined) addSample("cold_deck_load", "deck_get_wait_ms", coldDeckWait);

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
    for (const [metric, values] of metrics) output[name][metric] = summary(values);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  await browser.close();
}

function requestKind(url, method) {
  if (url.pathname === "/api/admin/presentation" && method === "POST") return "post";
  if (url.pathname === "/api/admin/session" && method === "GET") return "window_session_get";
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
