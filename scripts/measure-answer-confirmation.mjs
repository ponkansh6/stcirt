/*
 * Measure the real /answer confirmation flow against a disposable SQLite DB.
 * Production is the default. Build first with `pnpm build`; use
 * ANSWER_CONFIRMATION_MODE=dev for a separate development StrictMode sample.
 * Set ANSWER_CONFIRMATION_API_LATENCY_MS to add equal latency to each browser
 * API response (milliseconds, default 0); set ANSWER_CONFIRMATION_FILMSTRIP_DIR
 * to choose where completion-state screenshots are retained. Set
 * ANSWER_CONFIRMATION_REPEAT_COUNT (default 0) to add that many focal cold/warm
 * submission and saved-owner-revisit samples; zero preserves the existing run.
 * Set ANSWER_CONFIRMATION_ASSERT_NO_INITIAL_LOOKUPS=1 to fail on results or
 * visibility GETs before completion; the default records the count for baseline.
 * The server binds only to 127.0.0.1:3001. This records response JSON bytes and
 * browser Resource Timing observations; neither is a remote wire-size measure.
 */
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@libsql/client";
import { chromium } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = 3001;
const BASE_URL = `http://${HOST}:${PORT}`;
const COOKIE_NAME = "stcirt_participant_session";
const SESSION_PURPOSE = "stcirt-participant-session-v1";
const PIN = "7316";
const SECRET = randomBytes(32).toString("hex");
const MODE = process.env.ANSWER_CONFIRMATION_MODE === "dev" ? "dev" : "production";
// Optional latency injection is applied once to each page API response. Use the
// same value for before/after runs; zero keeps the real local-server baseline.
const ARTIFICIAL_API_LATENCY_MS = Math.max(
  0,
  Math.min(10_000, Number.parseInt(process.env.ANSWER_CONFIRMATION_API_LATENCY_MS ?? "0", 10) || 0),
);
const REPEAT_COUNT = Math.max(
  0,
  Math.min(10, Number.parseInt(process.env.ANSWER_CONFIRMATION_REPEAT_COUNT ?? "0", 10) || 0),
);
const REPEAT_SAVED_OWNER_IDS = Array.from({ length: REPEAT_COUNT }, (_, index) => 800 + index);
const ASSERT_NO_INITIAL_LOOKUPS = process.env.ANSWER_CONFIRMATION_ASSERT_NO_INITIAL_LOOKUPS === "1";
const RESPONSE_BODY_TIMEOUT_MS = 1_500;
const root = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "stcirt-answer-confirmation-"));
const filmstripDir =
  process.env.ANSWER_CONFIRMATION_FILMSTRIP_DIR ??
  join(tmpdir(), `stcirt-answer-confirmation-filmstrip-${process.pid}`);
await mkdir(filmstripDir, { recursive: true });
const dbPath = join(tempDir, "fixture.db");
let db;
let server;
let browser;
let diagnosticVisit;
let serverLogs = "";

function makeCookie(participantId) {
  const key = createHmac("sha256", SECRET).update(`${SESSION_PURPOSE}\0${PIN}`).digest();
  const payload = Buffer.from(
    JSON.stringify({ id: participantId, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
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
  // Migrations seed the five production questions at IDs 1–5. Clear their
  // dependent logs and rows so these fixtures are the only rows selected by
  // the participant batch endpoint.
  await db.execute("DELETE FROM exam_answer_logs");
  await db.execute("DELETE FROM exam_questions");
  const savedSubmissionParticipants = [701, 702, 704, ...REPEAT_SAVED_OWNER_IDS];
  const seededSubmissions = savedSubmissionParticipants.map((participantId) => ({
    participantId,
    submissionId: `00000000-0000-4000-8000-${String(participantId).padStart(12, "0")}`,
  }));
  await db.batch(
    [
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [701, "Benchmark owner", "Benchmark owner"],
      },
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [702, "bench-assisted", "Benchmark assisted"],
      },
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [703, "bench-new", "Benchmark new"],
      },
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [704, "bench-assisted-new-owner", "Benchmark assisted new owner"],
      },
      {
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [705, "bench-assisted-new-target", "Benchmark assisted new target"],
      },
      ...Array.from({ length: REPEAT_COUNT * 2 }, (_, index) => {
        const participantId = 710 + index;
        const condition = index % 2 === 0 ? "cold" : "warm";
        return {
          sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
          args: [
            participantId,
            `bench-repeat-${participantId}`,
            `Benchmark repeat ${participantId} ${condition}`,
          ],
        };
      }),
      ...REPEAT_SAVED_OWNER_IDS.map((participantId) => ({
        sql: "INSERT INTO exam_participants (id, normalized_name, display_name) VALUES (?, ?, ?)",
        args: [
          participantId,
          `bench-saved-repeat-${participantId}`,
          `Benchmark saved repeat ${participantId}`,
        ],
      })),
      {
        sql: "INSERT INTO assisted_participants (owner_participant_id, target_participant_id) VALUES (?, ?)",
        args: [701, 702],
      },
      {
        sql: "INSERT INTO assisted_participants (owner_participant_id, target_participant_id) VALUES (?, ?)",
        args: [704, 705],
      },
      {
        sql: "INSERT INTO participant_result_settings (id, visible, ever_published) VALUES (?, ?, ?)",
        args: [1, 0, 1],
      },
      ...Array.from({ length: 5 }, (_, i) => ({
        sql: "INSERT INTO exam_questions (id, question_key, question_version, question, choices, correct_index) VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          101 + i,
          i === 4 ? "it-literacy-005" : `benchmark-${String(i + 1).padStart(3, "0")}`,
          `benchmark-v1-${i + 1}`,
          `Benchmark question ${i + 1}?`,
          JSON.stringify(i === 4 ? [] : ["A", "B", "C", "D"]),
          0,
        ],
      })),
      ...seededSubmissions.map(({ participantId, submissionId }) => ({
        sql: "INSERT INTO exam_answer_submissions (id, participant_id, question_ids, question_versions, revision) VALUES (?, ?, ?, ?, ?)",
        args: [
          submissionId,
          participantId,
          JSON.stringify([101, 102, 103, 104, 105]),
          JSON.stringify(
            Object.fromEntries(
              [101, 102, 103, 104, 105].map((id, i) => [id, `benchmark-v1-${i + 1}`]),
            ),
          ),
          1,
        ],
      })),
      ...seededSubmissions.flatMap(({ submissionId }) =>
        [101, 102, 103, 104, 105].map((questionId, i) => ({
          sql: "INSERT INTO exam_submission_answers (submission_id, question_id, answer_kind, selected_index, free_text) VALUES (?, ?, ?, ?, ?)",
          args: [
            submissionId,
            questionId,
            i === 4 ? "freeText" : "selected",
            i === 4 ? null : 0,
            i === 4 ? "A synthetic response" : null,
          ],
        })),
      ),
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
  const command = MODE === "dev" ? "dev" : "start";
  server = spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      command,
      ...(MODE === "dev" ? ["--turbopack"] : []),
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
        NODE_ENV: MODE === "dev" ? "development" : "production",
        NEXT_TELEMETRY_DISABLED: "1",
        TURSO_DATABASE_URL: `file:${dbPath}`,
        TURSO_AUTH_TOKEN: "",
        STCIRT_E2E_DB_ISOLATION: "1",
        PARTICIPANT_SESSION_SECRET: SECRET,
        PARTICIPANT_PIN: PIN,
        PARTICIPANT_SESSION_DAYS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collectServerLog = (chunk) => {
    serverLogs = `${serverLogs}${String(chunk)}`.slice(-12_000);
  };
  server.stdout.setEncoding("utf8").on("data", collectServerLog);
  server.stderr.setEncoding("utf8").on("data", collectServerLog);
  for (let i = 0; i < 180; i += 1) {
    if (server.exitCode !== null) throw new Error(`${MODE} server exited before becoming ready`);
    try {
      if ((await fetch(BASE_URL)).status) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for local ${MODE} server`);
}

async function openAnswer(
  participantId,
  scenario,
  initialMode = "owner",
  initialPhase = "initial_data",
) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
  if (initialMode === "assisted") {
    await context.addInitScript(() => {
      window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    });
  }
  if (participantId !== null) {
    await context.addCookies([
      { name: COOKIE_NAME, value: makeCookie(participantId), url: BASE_URL },
    ]);
  }
  const page = await context.newPage();
  const requests = [];
  const started = new Map();
  const requestRecords = new Map();
  const responseTasks = [];
  const externalRequests = [];
  const visitStarted = performance.now();
  const visitStartedAtEpoch = Date.now();
  const measurement = {
    phase: initialPhase,
    temperature: "cold",
    startedAt: performance.now(),
    startIndex: 0,
  };
  const browserEvents = [];
  await page.addInitScript(() => {
    window.__answerConfirmationEvents = [];
    const record = (type, detail = null) => {
      window.__answerConfirmationEvents.push({
        type,
        at: performance.now(),
        at_epoch_ms: Date.now(),
        detail,
      });
    };
    window.addEventListener("pageshow", () => record("pageshow"));
    window.addEventListener("pagehide", () => record("pagehide"));
    window.addEventListener("focus", () => record("focus"));
    document.addEventListener("visibilitychange", () =>
      record("visibilitychange", document.visibilityState),
    );
    document.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest?.("button");
        if (button) record("manual_action", button.innerText.trim().slice(0, 120));
      },
      true,
    );
    const capture = () => {
      const heading = [...document.querySelectorAll("h1, h2, h3")].find(
        (node) => node.textContent?.trim() === "回答済み",
      );
      if (!heading) return;
      const rect = (node) => {
        const box = node.getBoundingClientRect();
        return {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      };
      const region = heading.closest("section, article, [role=region]") ?? heading.parentElement;
      const buttons = [...(region?.querySelectorAll("button") ?? [])]
        .filter((node) => node.getClientRects().length)
        .map((node) => ({ text: node.innerText.trim(), bounds: rect(node) }));
      const snapshot = {
        at: performance.now(),
        at_epoch_ms: Date.now(),
        state: region?.innerText.trim().slice(0, 600) ?? heading.innerText.trim(),
        heading: { text: heading.innerText.trim(), bounds: rect(heading) },
        region: region ? rect(region) : null,
        buttons,
      };
      const fingerprint = JSON.stringify({
        state: snapshot.state,
        heading: snapshot.heading,
        region: snapshot.region,
        buttons: snapshot.buttons,
      });
      if (fingerprint !== lastCompletionFingerprint) {
        window.__answerConfirmationEvents.push({
          type: "completion_state",
          at: snapshot.at,
          at_epoch_ms: snapshot.at_epoch_ms,
          detail: snapshot,
        });
        lastCompletionFingerprint = fingerprint;
      }
    };
    let lastCompletionFingerprint = null;
    new MutationObserver(capture).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const sampleLayout = () => {
      capture();
      requestAnimationFrame(sampleLayout);
    };
    requestAnimationFrame(sampleLayout);
  });
  if (ARTIFICIAL_API_LATENCY_MS > 0) {
    await page.route("**/api/**", async (route) => {
      let response;
      try {
        // route.fetch sends exactly one upstream request. Copy the response
        // before the artificial wait; APIResponse may be disposed on navigation.
        response = await route.fetch();
      } catch (error) {
        if (isExpectedRouteCancellation(error)) return;
        throw error;
      }
      const status = response.status();
      const headers = response.headers();
      const body = await response.body();
      await delay(ARTIFICIAL_API_LATENCY_MS);
      try {
        await route.fulfill({ status, headers, body });
      } catch (error) {
        // A reload/close can cancel a response after its upstream result has
        // been read. Other fulfillment errors must still fail the measurement.
        if (isExpectedRouteCancellation(error)) return;
        throw error;
      }
    });
  }
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== BASE_URL) externalRequests.push(url.href);
    if (!url.pathname.startsWith("/api/")) return;
    const key = `${request.method()} ${url.pathname}${url.search}`;
    started.set(request, performance.now());
    const record = {
      method: request.method(),
      path: `${url.pathname}${url.search}`,
      started_ms: Number((performance.now() - visitStarted).toFixed(2)),
      endpoint_class: classifyEndpoint(url.pathname),
      request_category:
        url.pathname === "/api/answers/batch"
          ? "submission_mutation"
          : url.pathname === "/api/answers/bootstrap"
            ? "bootstrap_seed_source"
            : null,
      measurement_temperature: measurement.temperature,
      measurement_phase: measurement.phase,
      measurement_started_ms: Number((performance.now() - measurement.startedAt).toFixed(2)),
      lookup_history_key: `${measurement.phase}|${url.pathname}${url.search}`,
      key,
    };
    requests.push(record);
    requestRecords.set(request, record);
  });
  page.on("requestfailed", (request) => {
    const record = requestRecords.get(request);
    if (!record) return;
    record.request_failed = true;
    record.failure_kind = "network_error";
    record.failure_text = request.failure()?.errorText ?? null;
    record.elapsed_ms = Number(
      (performance.now() - (started.get(request) ?? performance.now())).toFixed(2),
    );
    record.response_body_read_status = "no_response";
  });
  page.on("response", (response) => {
    const request = response.request();
    if (!new URL(response.url()).pathname.startsWith("/api/")) return;
    responseTasks.push(
      (async () => {
        const record = requestRecords.get(request);
        if (!record) return;
        record.status = response.status();
        record.failure_kind = response.status() >= 400 ? "http_error" : null;
        record.elapsed_ms = Number(
          (performance.now() - (started.get(request) ?? performance.now())).toFixed(2),
        );
        record.content_length_header_bytes = Number(response.headers()["content-length"]) || null;
        record.response_body_read_status = "pending";
        try {
          const bodyResult = await Promise.race([
            response.body().then((body) => ({ body })),
            delay(RESPONSE_BODY_TIMEOUT_MS).then(() => ({ timedOut: true })),
          ]);
          if ("timedOut" in bodyResult) {
            record.response_body_read_status = "timeout";
            record.response_body_bytes = null;
            record.json_body_bytes = null;
            record.json_body_bytes_null_reason = "response_body_read_timeout";
            return;
          }
          const body = bodyResult.body;
          record.response_body_bytes = body.byteLength;
          record.response_body_read_status = "complete";
          const contentType = response.headers()["content-type"] ?? "";
          record.json_body_bytes = contentType.includes("json") ? body.byteLength : null;
          if (!contentType.includes("json"))
            record.json_body_bytes_null_reason = "non_json_response";
        } catch {
          record.response_body_read_status = "failed";
          record.response_body_bytes = null;
          record.json_body_bytes = null;
          record.json_body_bytes_null_reason = "response_body_read_failed";
        }
      })(),
    );
  });
  const elapsed = () => Number((performance.now() - visitStarted).toFixed(2));
  const checkpoints = [];
  const visit = {
    context,
    page,
    requests,
    responseTasks,
    externalRequests,
    scenario,
    initialMode,
    elapsed,
    checkpoints,
    measurement,
    initialMeasurements: [],
    browserEvents,
    visitStartedAtEpoch,
    completionStates: [],
    filmstrip: [],
  };
  diagnosticVisit = visit;
  await page.goto(`${BASE_URL}/answer`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(100);
  return visit;
}

function checkpoint(visit, name) {
  const counts = {};
  const previousRequestIndex =
    visit.checkpoints.at(-1)?.request_index ?? visit.measurement.startIndex;
  const requestsSincePreviousCheckpoint = visit.requests.slice(previousRequestIndex);
  for (const request of visit.requests) {
    const key = `${request.method} ${new URL(`http://localhost${request.path}`).pathname}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  visit.checkpoints.push({
    name,
    elapsed_ms: visit.elapsed(),
    request_index: visit.requests.length,
    request_counts_by_method_path: counts,
    saved_followup_requests_since_previous_checkpoint: summarizeSavedFollowupRequests(
      requestsSincePreviousCheckpoint,
    ),
  });
  if (
    name === "initial_data_ready" ||
    name === "pre_auth_probe_complete" ||
    name === "owner_session_prepared" ||
    name === "assisted_target_selection_ready" ||
    name === "assisted_edit_ready" ||
    name === "owner_return_ready"
  ) {
    const phaseRequests = visit.requests.slice(visit.measurement.startIndex, visit.requests.length);
    const requests = phaseRequests.filter(
      (request) => !isInitialMeasurementFollowupRequest(visit, request),
    );
    const bootstrap =
      name === "pre_auth_probe_complete"
        ? {
            mode: "owner",
            state: "unauthenticated",
            measurement_scope: "pre_auth_probe",
            protocol: "excluded_from_startup_counts",
            bootstrap_request_count: null,
            exclusion_reason:
              "Pre-auth 401 probe occurs before session login and is not startup recovery.",
            requests: phaseRequests,
          }
        : classifyBootstrapMeasurement(visit, phaseRequests);
    visit.initialMeasurements.push({
      phase: visit.measurement.phase,
      temperature: visit.measurement.temperature,
      ready_ms: Number((performance.now() - visit.measurement.startedAt).toFixed(2)),
      request_count: requests.length,
      request_counts_by_method_path: countRequestsByMethodPath(requests),
      bootstrap_measurement: bootstrap,
      requests,
    });
  }
  if (name === "owner_session_prepared") {
    const requests = visit.requests.slice(visit.measurement.startIndex, visit.requests.length);
    if (requests.some((request) => request.path.startsWith("/api/questions/batch"))) {
      throw new Error("Owner preparation checkpoint unexpectedly fetched questions");
    }
  }
}

function assertNoCompletionLookupsBeforeCheckpoint(visit) {
  const checkpoint = visit.checkpoints.at(-1);
  const submissionInterval = [...(visit.completionIntervals ?? [])]
    .reverse()
    .find((interval) => interval.endpoint === "answer_submission");
  const isSavedOwnerRevisit =
    visit.scenario === "saved_owner_revisit" ||
    visit.scenario.startsWith("saved_owner_revisit_repeat_");
  if (!submissionInterval && !isSavedOwnerRevisit) return;
  const lookups = submissionInterval
    ? visit.requests.filter(
        (request) =>
          (request.endpoint_class === "participant_results" ||
            request.endpoint_class === "submission_visibility") &&
          request.started_ms >= submissionInterval.request_started_ms &&
          request.started_ms <= submissionInterval.completion_confirmed_ms &&
          request.started_ms < (checkpoint.elapsed_ms ?? Number.POSITIVE_INFINITY),
      )
    : visit.requests
        .slice(visit.measurement.startIndex, checkpoint.request_index)
        .filter(
          (request) =>
            request.endpoint_class === "participant_results" ||
            request.endpoint_class === "submission_visibility",
        );
  const passed = lookups.length === 0;
  visit.measurementSelfChecks ??= [];
  visit.measurementSelfChecks.push({
    check: submissionInterval
      ? "zero_results_visibility_gets_during_submission_completion"
      : "zero_initial_completion_lookups",
    checkpoint: checkpoint.name,
    condition: submissionInterval?.sample_condition ?? visit.measurement.temperature,
    sample_iteration: visit.sampleIteration ?? null,
    interval_start_ms: submissionInterval?.request_started_ms ?? null,
    interval_end_ms: submissionInterval?.completion_confirmed_ms ?? null,
    expected_count: 0,
    actual_count: lookups.length,
    passed,
    enforcement: ASSERT_NO_INITIAL_LOOKUPS ? "strict" : "observe",
  });
  if (!passed && ASSERT_NO_INITIAL_LOOKUPS) {
    throw new Error(
      `${visit.scenario} expected zero results/visibility GETs before ${checkpoint.name}, found ${lookups.length}`,
    );
  }
}

function beginMeasurement(visit, phase, temperature) {
  visit.measurement.phase = phase;
  visit.measurement.temperature = temperature;
  visit.measurement.startedAt = performance.now();
  visit.measurement.startIndex = visit.requests.length;
}

async function enterAssistedTarget(visit, hasSubmission, temperature) {
  beginMeasurement(
    visit,
    hasSubmission ? "assisted_saved_edit" : "assisted_target_selection",
    temperature,
  );
  const buttonName = hasSubmission ? "代理回答を修正する" : "代理回答を行う";
  const startedAt = performance.now();
  const assistedBootstrapResponse = visit.page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/answers/bootstrap" && url.searchParams.get("mode") === "assisted";
  });
  await visit.page.getByRole("button", { name: buttonName, exact: true }).click();
  const bootstrapResponse = await assistedBootstrapResponse;
  assertSingleTransitionBootstrap(visit, "assisted", bootstrapResponse.status());
  if (hasSubmission) {
    const firstQuestion = visit.page.locator('section[aria-labelledby="question-title-101"]');
    await firstQuestion.waitFor({ state: "visible", timeout: 20_000 });
    const questionsIndex = visit.requests.findIndex(
      (request, index) =>
        index >= visit.measurement.startIndex && request.path.startsWith("/api/questions/batch"),
    );
    if (questionsIndex < visit.measurement.startIndex) {
      throw new Error("Saved assisted edit must fetch questions through its explicit edit flow");
    }
    const checkedCount = await firstQuestion.locator('input[type="radio"]:checked').count();
    if (checkedCount !== 1) {
      throw new Error(`Expected one restored assisted selection, found ${checkedCount}`);
    }
    const selectedChoiceText = await firstQuestion
      .locator('input[type="radio"]:checked')
      .evaluate((radio) => {
        const choiceText = radio.labels?.[0]?.querySelectorAll(":scope > span").item(1);
        return choiceText?.textContent?.trim() ?? null;
      });
    if (selectedChoiceText !== "A") {
      throw new Error(`Expected restored assisted choice A, found ${selectedChoiceText}`);
    }
    visit.editReadyMs = Number((performance.now() - startedAt).toFixed(2));
    checkpoint(visit, "assisted_edit_ready");
    return;
  }
  const firstQuestion = visit.page.locator('section[aria-labelledby="question-title-101"]');
  await firstQuestion.waitFor({ state: "visible", timeout: 20_000 });
  visit.firstQuestionReadyMs = Number((performance.now() - startedAt).toFixed(2));
  checkpoint(visit, "assisted_target_selection_ready");
}

function assertDirectAssistedNewPath(visit, startIndex, endIndex) {
  const requests = visit.requests.slice(startIndex, endIndex);
  const bootstrapRequests = requests.filter((request) => {
    const url = new URL(`http://localhost${request.path}`);
    return url.pathname === "/api/answers/bootstrap";
  });
  if (bootstrapRequests.length === 1) {
    const request = bootstrapRequests[0];
    const url = new URL(`http://localhost${request.path}`);
    if (
      url.searchParams.get("mode") !== "assisted" ||
      !Number.isFinite(request.status) ||
      request.status < 200 ||
      request.status >= 300
    ) {
      throw new Error("Direct assisted-new bootstrap must be one successful mode=assisted request");
    }
    return;
  }
  if (bootstrapRequests.length > 0) {
    throw new Error(
      `Direct assisted-new expected one bootstrap request, found ${bootstrapRequests.length}`,
    );
  }
  const requiredInOrder = [
    "GET /api/participants/session",
    "GET /api/participants/assisted",
    "GET /api/answers/latest?scope=assisted",
    "GET /api/questions/batch",
  ];
  if (requests.length !== requiredInOrder.length) {
    throw new Error(
      `Direct assisted-new interval expected ${requiredInOrder.length} API requests, found ${requests.length}`,
    );
  }
  for (let index = 0; index < requiredInOrder.length; index += 1) {
    const actual = `${requests[index].method} ${requests[index].path}`;
    if (actual !== requiredInOrder[index]) {
      throw new Error(
        `Direct assisted-new request ${index + 1} expected ${requiredInOrder[index]}, found ${actual}`,
      );
    }
  }
  if (
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.path.startsWith("/api/answers/latest") &&
        request.path !== "/api/answers/latest?scope=assisted",
    )
  ) {
    throw new Error("Direct assisted-new path unexpectedly fetched the owner latest submission");
  }
}

async function warmAssistedRevisit(visit, hasSubmission) {
  beginMeasurement(visit, "owner_return_transition", "warm");
  await visit.page.getByRole("button", { name: "自分の回答に戻る", exact: true }).click();
  await visit.page
    .getByRole("heading", { name: "回答済み", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  const returnBootstrap = visit.requests.slice(visit.measurement.startIndex).filter((request) => {
    const url = new URL(`http://localhost${request.path}`);
    return url.pathname === "/api/answers/bootstrap" && url.searchParams.get("mode") === "owner";
  });
  if (
    returnBootstrap.length !== 1 ||
    !Number.isFinite(returnBootstrap[0].status) ||
    returnBootstrap[0].status < 200 ||
    returnBootstrap[0].status >= 300
  ) {
    throw new Error(
      `Owner return expected one successful mode=owner bootstrap, found ${returnBootstrap.length}`,
    );
  }
  if (
    visit.requests
      .slice(visit.measurement.startIndex)
      .some((request) => request.path.startsWith("/api/answers/latest"))
  ) {
    throw new Error("Owner return unexpectedly fetched latest instead of using bootstrap");
  }
  checkpoint(visit, "owner_return_ready");
  beginMeasurement(visit, "owner_session_preparation", "warm");
  await visit.page.reload({ waitUntil: "domcontentloaded" });
  await visit.page
    .getByRole("heading", { name: "回答済み", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  checkpoint(visit, "owner_session_prepared");
  await enterAssistedTarget(visit, hasSubmission, "warm");
}

function assertSingleTransitionBootstrap(visit, mode, responseStatus) {
  const bootstraps = visit.requests.slice(visit.measurement.startIndex).filter((request) => {
    const url = new URL(`http://localhost${request.path}`);
    return url.pathname === "/api/answers/bootstrap" && url.searchParams.get("mode") === mode;
  });
  if (
    bootstraps.length !== 1 ||
    !Number.isFinite(responseStatus) ||
    responseStatus < 200 ||
    responseStatus >= 300
  ) {
    throw new Error(`${visit.measurement.phase} expected one successful mode=${mode} bootstrap`);
  }
}

function isInitialMeasurementFollowupRequest(visit, request) {
  const pathname = new URL(`http://localhost${request.path}`).pathname;
  if (pathname === "/api/participants/assisted") {
    return visit.initialMode !== "assisted" && isSavedScenario(visit.scenario);
  }
  return pathname === "/api/answers/visibility" || pathname === "/api/participants/results";
}

function isSavedScenario(scenario) {
  return scenario === "saved_owner_revisit" || scenario === "owner_assisted_cta";
}

function classifyBootstrapMeasurement(visit, requests) {
  const mode = visit.initialMode;
  if (visit.scenario === "unauthenticated_login_surface") {
    if (visit.measurement.phase === "pre_auth_probe") {
      return {
        mode: "owner",
        state: "unauthenticated",
        measurement_scope: "pre_auth_probe",
        protocol: "excluded_from_startup_counts",
        bootstrap_request_count: null,
        requests,
      };
    }
    if (visit.measurement.phase === "post_login_recovery") {
      const bootstrap = requests.filter((request) => {
        const url = new URL(`http://localhost${request.path}`);
        return (
          url.pathname === "/api/answers/bootstrap" &&
          url.searchParams.get("mode") === "owner" &&
          Number.isFinite(request.status) &&
          request.status >= 200 &&
          request.status < 300
        );
      });
      if (bootstrap.length !== 1) {
        throw new Error(
          `Post-login recovery expected one successful mode=owner bootstrap request, found ${bootstrap.length}`,
        );
      }
      return {
        mode: "owner",
        state: "saved",
        measurement_scope: "post_login_recovery",
        protocol: "bootstrap_route",
        bootstrap_request_count: 1,
        requests: bootstrap,
      };
    }
  }
  const directStartup =
    visit.measurement.phase === "initial_data" ||
    visit.measurement.phase === "assisted_new_initial_data";
  const ownerPreparation = visit.measurement.phase === "owner_session_preparation";
  const transition =
    visit.measurement.phase === "assisted_target_selection" ||
    visit.measurement.phase === "assisted_saved_edit" ||
    visit.measurement.phase === "owner_return_transition";
  if (transition) {
    const transitionMode =
      visit.measurement.phase === "owner_return_transition" ? "owner" : "assisted";
    const bootstrap = requests.filter((request) => {
      const url = new URL(`http://localhost${request.path}`);
      return (
        url.pathname === "/api/answers/bootstrap" &&
        url.searchParams.get("mode") === transitionMode &&
        Number.isFinite(request.status) &&
        request.status >= 200 &&
        request.status < 300
      );
    });
    if (bootstrap.length !== 1) {
      throw new Error(
        `${visit.measurement.phase} expected one successful mode=${transitionMode} bootstrap request, found ${bootstrap.length}`,
      );
    }
    return {
      mode: transitionMode,
      state:
        transitionMode === "owner" || visit.measurement.phase === "assisted_saved_edit"
          ? "saved"
          : "new",
      measurement_scope: "scope_transition",
      protocol: "bootstrap_route",
      bootstrap_request_count: 1,
      requests: bootstrap,
    };
  }
  const state =
    ownerPreparation || visit.scenario.includes("saved") || visit.scenario === "owner_assisted_cta"
      ? "saved"
      : "new";
  if (!directStartup && !ownerPreparation) {
    return {
      mode: visit.measurement.phase === "assisted_target_selection" ? "assisted" : mode,
      state: visit.measurement.phase === "assisted_target_selection" ? "new" : "saved",
      measurement_scope: "cta_or_edit_phase",
      protocol: "not_counted_as_startup",
      bootstrap_request_count: null,
      requests: requests.filter(isBootstrapCoreRequest),
    };
  }
  const successful = requests.filter(
    (request) => Number.isFinite(request.status) && request.status >= 200 && request.status < 300,
  );
  const bootstrapEndpoints = requests.filter((request) => {
    return new URL(`http://localhost${request.path}`).pathname === "/api/answers/bootstrap";
  });
  const bootstrap = successful.filter((request) => {
    const url = new URL(`http://localhost${request.path}`);
    return url.pathname === "/api/answers/bootstrap" && url.searchParams.get("mode") === mode;
  });
  if (bootstrapEndpoints.length && (bootstrap.length !== 1 || bootstrapEndpoints.length !== 1)) {
    throw new Error(
      `Expected exactly one successful mode=${mode} bootstrap request in ${visit.measurement.phase}`,
    );
  }
  if (bootstrap.length) {
    return {
      mode,
      state,
      measurement_scope: ownerPreparation ? "owner_preparation" : "direct_startup",
      protocol: "bootstrap_route",
      bootstrap_request_count: bootstrap.length,
      requests: bootstrap,
      saved_followup_requests: requests.filter(isAssistedStatusRequest),
    };
  }
  const core = successful.filter(
    (request) =>
      isBootstrapCoreRequest(request) ||
      (mode === "assisted" && directStartup && isAssistedStatusRequest(request)),
  );
  return {
    mode,
    state,
    measurement_scope: ownerPreparation ? "owner_preparation" : "direct_startup",
    protocol: "legacy_core_requests",
    bootstrap_request_count: core.length,
    requests: core,
    saved_followup_requests: requests.filter(isAssistedStatusRequest),
  };
}

function isBootstrapCoreRequest(request) {
  const pathname = new URL(`http://localhost${request.path}`).pathname;
  return (
    pathname === "/api/participants/session" ||
    pathname === "/api/answers/latest" ||
    pathname === "/api/questions/batch"
  );
}

function isAssistedStatusRequest(request) {
  return new URL(`http://localhost${request.path}`).pathname === "/api/participants/assisted";
}

function countRequestsByMethodPath(requests) {
  const counts = {};
  for (const request of requests) {
    const pathname = new URL(`http://localhost${request.path}`).pathname;
    const key = `${request.method} ${pathname}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function summarizeSavedFollowupRequests(requests) {
  const assistedStatus = requests.filter(isAssistedStatusRequest);
  const visibility = requests.filter((request) => {
    return new URL(`http://localhost${request.path}`).pathname === "/api/answers/visibility";
  });
  const results = requests.filter((request) => {
    return new URL(`http://localhost${request.path}`).pathname === "/api/participants/results";
  });
  return {
    assisted_status: { request_count: assistedStatus.length, requests: assistedStatus },
    visibility: { request_count: visibility.length, requests: visibility },
    results: { request_count: results.length, requests: results },
  };
}

async function warmRevisit(visit, waitForReady) {
  visit.measurement.temperature = "warm";
  visit.measurement.startedAt = performance.now();
  visit.measurement.startIndex = visit.requests.length;
  const warmStartIndex = visit.requests.length;
  await visit.page.evaluate(() => performance.clearResourceTimings());
  await visit.page.reload({ waitUntil: "domcontentloaded" });
  await waitForReady();
  checkpoint(visit, "initial_data_ready");
  assertNoCompletionLookupsBeforeCheckpoint(visit);
  if (visit.scenario === "assisted_new_direct_startup") {
    assertDirectAssistedNewPath(visit, warmStartIndex, visit.checkpoints.at(-1).request_index);
  }
}

async function settle(visit) {
  await Promise.race([
    Promise.allSettled(visit.responseTasks),
    delay(RESPONSE_BODY_TIMEOUT_MS + 100),
  ]);
  const api = await visit.page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.startsWith("/api/"))
      .map((entry) => ({
        path: new URL(entry.name).pathname,
        transfer_size_bytes: entry.transferSize || null,
        encoded_body_size_bytes: entry.encodedBodySize || null,
      })),
  );
  const eventTrace = await visit.page.evaluate(() => window.__answerConfirmationEvents ?? []);
  visit.browserEvents = eventTrace
    .filter((event) => event.type !== "completion_state")
    .map((event) => ({
      ...event,
      at_ms: Number((event.at_epoch_ms - visit.visitStartedAtEpoch).toFixed(2)),
    }));
  visit.completionStates = eventTrace
    .filter((event) => event.type === "completion_state")
    .map((event) => ({
      ...event,
      at_ms: Number((event.at_epoch_ms - visit.visitStartedAtEpoch).toFixed(2)),
    }));
  classifyVisibilityRequests(visit);
  if (visit.externalRequests.length)
    throw new Error(`Observed non-local request: ${visit.externalRequests[0]}`);
  const requestGroups = new Map();
  for (const request of visit.requests) {
    const groupKey = `${request.method} ${request.path} ${request.status ?? "failed"} ${request.failure_kind ?? "none"} ${request.request_category ?? "uncategorized"}`;
    const group = requestGroups.get(groupKey) ?? {
      method: request.method,
      path: request.path,
      status: request.status ?? null,
      failure_kind: request.failure_kind ?? null,
      request_category: request.request_category ?? null,
      count: 0,
      known_json_body_bytes: 0,
      unknown_json_body_count: 0,
      elapsed_ms: [],
    };
    group.count += 1;
    if (Number.isFinite(request.json_body_bytes)) {
      group.known_json_body_bytes += request.json_body_bytes;
    } else if (request.json_body_bytes_null_reason !== "non_json_response") {
      group.unknown_json_body_count += 1;
    }
    if (Number.isFinite(request.elapsed_ms)) group.elapsed_ms.push(request.elapsed_ms);
    requestGroups.set(groupKey, group);
  }
  for (const group of requestGroups.values()) {
    group.total_json_body_bytes =
      group.unknown_json_body_count > 0 ? null : group.known_json_body_bytes;
    delete group.elapsed_ms;
  }
  const result = {
    scenario: visit.scenario,
    metric_scenario: visit.metricScenario ?? visit.scenario,
    sample_iteration: visit.sampleIteration ?? null,
    sample_condition: visit.sampleCondition ?? null,
    first_question_ready_ms: visit.firstQuestionReadyMs ?? null,
    completion_ready_ms: visit.completionReadyMs ?? null,
    completion_intervals: visit.completionIntervals ?? [],
    completion_confirmations: visit.completionConfirmations ?? [],
    completion_states: visit.completionStates,
    browser_events: visit.browserEvents,
    filmstrip: visit.filmstrip,
    measurement_self_checks: visit.measurementSelfChecks ?? [],
    artificial_api_latency_ms: ARTIFICIAL_API_LATENCY_MS,
    edit_ready_ms: visit.editReadyMs ?? null,
    checkpoints: visit.checkpoints,
    initial_data_measurements: visit.initialMeasurements,
    bootstrap_measurements: visit.initialMeasurements.map((measurement) => ({
      phase: measurement.phase,
      temperature: measurement.temperature,
      ...measurement.bootstrap_measurement,
    })),
    saved_followup_requests: summarizeSavedFollowupRequests(visit.requests),
    request_counts_by_method_path_status: [...requestGroups.values()],
    requests: visit.requests,
    pending_response_body_reads: visit.requests.filter(
      (request) => request.response_body_read_status === "pending",
    ).length,
    api_resource_timing: api,
  };
  await visit.context.close();
  return result;
}

function classifyEndpoint(pathname) {
  if (pathname === "/api/answers/batch") return "answer_submission";
  if (pathname === "/api/answers/bootstrap") return "answer_bootstrap";
  if (pathname === "/api/participants/results") return "participant_results";
  if (pathname === "/api/answers/visibility") return "submission_visibility";
  return "other_api";
}

function isExpectedRouteCancellation(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /net::ERR_ABORTED|request (?:was )?canceled|target (?:page, context or browser|closed)/i.test(
    message,
  );
}

function classifyVisibilityRequests(visit) {
  for (const request of visit.requests) {
    if (
      request.endpoint_class !== "participant_results" &&
      request.endpoint_class !== "submission_visibility"
    )
      continue;
    const priorFailedLookup = visit.requests.some(
      (candidate) =>
        candidate !== request &&
        candidate.endpoint_class === request.endpoint_class &&
        candidate.lookup_history_key === request.lookup_history_key &&
        candidate.started_ms < request.started_ms &&
        (candidate.request_failed ||
          (Number.isFinite(candidate.status) && candidate.status >= 400)),
    );
    const priorLookupInPhase = visit.requests.some(
      (candidate) =>
        candidate !== request &&
        candidate.endpoint_class === request.endpoint_class &&
        candidate.lookup_history_key === request.lookup_history_key &&
        candidate.started_ms < request.started_ms,
    );
    const event = [...visit.browserEvents]
      .reverse()
      .find(
        (candidate) =>
          ["manual_action", "visibilitychange", "pageshow", "focus"].includes(candidate.type) &&
          candidate.at_ms <= request.started_ms &&
          request.started_ms - candidate.at_ms <= 1_500,
      );
    const requestFailed =
      request.request_failed || (Number.isFinite(request.status) && request.status >= 400);
    request.request_category = requestFailed
      ? request.request_failed
        ? "lookup_network_failure"
        : "lookup_http_failure"
      : priorFailedLookup
        ? "failure_recovery"
        : event?.type === "manual_action"
          ? "manual_action_refresh"
          : event
            ? "resume_or_focus_refresh"
            : priorLookupInPhase
              ? "followup_poll_or_refresh"
              : "initial_completion_lookup";
  }
}

function classifyCompletionInterval(visit, request, completionAt) {
  const endpoint = request.endpoint_class;
  if (endpoint !== "answer_submission" && endpoint !== "answer_bootstrap") return null;
  return {
    endpoint,
    request_started_ms: request.started_ms,
    completion_confirmed_ms: completionAt,
    elapsed_ms: Number((completionAt - request.started_ms).toFixed(2)),
    measurement_temperature: request.measurement_temperature,
    measurement_phase: request.measurement_phase,
    sample_iteration: visit.sampleIteration ?? null,
    sample_condition: visit.sampleCondition ?? request.measurement_temperature,
  };
}

async function confirmCompletion(visit, phase) {
  const confirmation = await waitForCompletionState(visit);
  visit.completionConfirmations ??= [];
  visit.completionConfirmations.push({
    phase,
    condition: visit.sampleCondition ?? visit.measurement.temperature,
    sample_iteration: visit.sampleIteration ?? null,
    ...confirmation,
  });
  const states = await visit.page.evaluate(() => window.__answerConfirmationEvents ?? []);
  visit.browserEvents = states
    .filter((event) => event.type !== "completion_state")
    .map((event) => ({
      ...event,
      at_ms: Number((event.at_epoch_ms - visit.visitStartedAtEpoch).toFixed(2)),
    }));
  visit.completionStates = states
    .filter((event) => event.type === "completion_state")
    .map((event) => ({
      ...event,
      at_ms: Number((event.at_epoch_ms - visit.visitStartedAtEpoch).toFixed(2)),
    }));
  const confirmedAt = visit.elapsed();
  const triggerRequest = [...visit.requests]
    .reverse()
    .find(
      (request) =>
        request.endpoint_class === "answer_submission" ||
        request.endpoint_class === "answer_bootstrap",
    );
  visit.completionIntervals ??= [];
  if (triggerRequest) {
    const interval = classifyCompletionInterval(visit, triggerRequest, confirmedAt);
    if (interval) visit.completionIntervals.push({ phase, ...interval });
  }
  classifyVisibilityRequests(visit);
  let previousOffsetMs = 0;
  for (const offsetMs of [0, 100, 300]) {
    if (offsetMs > previousOffsetMs) await delay(offsetMs - previousOffsetMs);
    const index = visit.filmstrip.length + 1;
    const path = join(filmstripDir, `${visit.scenario}-${phase}-${index}.png`);
    await visit.page.screenshot({ path, fullPage: true });
    visit.filmstrip.push({ phase, offset_ms: offsetMs, path, captured_at_ms: visit.elapsed() });
    previousOffsetMs = offsetMs;
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)].toFixed(2));
}

function summarizeCompletionMetrics(results) {
  const groups = new Map();
  const add = (result, condition, metric, value, sampleIteration) => {
    if (!Number.isFinite(value)) return;
    const scenario = result.metric_scenario ?? result.scenario;
    const cohort = sampleIteration === null || sampleIteration === undefined ? "legacy" : "repeat";
    const key = `${scenario}|${condition}|${cohort}`;
    const group = groups.get(key) ?? {
      scenario,
      condition,
      cohort,
      samples: { post_to_completion_ms: [], bootstrap_to_completion_ms: [], post_duration_ms: [] },
      sample_iterations: new Set(),
    };
    group.samples[metric].push(value);
    if (sampleIteration !== null && sampleIteration !== undefined)
      group.sample_iterations.add(sampleIteration);
    groups.set(key, group);
  };
  for (const result of results) {
    for (const interval of result.completion_intervals ?? []) {
      const metric =
        interval.endpoint === "answer_submission"
          ? "post_to_completion_ms"
          : interval.endpoint === "answer_bootstrap"
            ? "bootstrap_to_completion_ms"
            : null;
      if (metric) {
        add(
          result,
          interval.sample_condition ?? interval.measurement_temperature,
          metric,
          interval.elapsed_ms,
          interval.sample_iteration,
        );
      }
    }
    for (const request of result.requests ?? []) {
      if (request.endpoint_class === "answer_submission") {
        add(
          result,
          request.measurement_temperature,
          "post_duration_ms",
          request.elapsed_ms,
          result.sample_iteration,
        );
      }
    }
  }
  return [...groups.values()].map((group) => ({
    scenario: group.scenario,
    condition: group.condition,
    cohort: group.cohort,
    sample_count: Math.max(...Object.values(group.samples).map((values) => values.length)),
    sample_iterations: [...group.sample_iterations].sort((a, b) => a - b),
    metrics: Object.fromEntries(
      Object.entries(group.samples).map(([metric, values]) => [
        metric,
        { p50: percentile(values, 0.5), p95: percentile(values, 0.95), samples: values.length },
      ]),
    ),
  }));
}

async function waitForCompletionState(visit) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await visit.page.evaluate(() => {
      const heading = [...document.querySelectorAll("h1")].find(
        (node) => node.textContent?.trim() === "回答済み",
      );
      if (!heading) return "pending";
      const card = heading.closest("section");
      if (!card) return "pending";
      const cardText = card.innerText;
      const lookupFailed =
        cardText.includes("結果の公開状況を確認できませんでした") &&
        [...card.querySelectorAll("button")].some(
          (node) => node.innerText.trim() === "もう一度確認する" && node.getClientRects().length,
        );
      if (lookupFailed) return "lookup_failed";
      const nameField = [...card.querySelectorAll("dt")].find(
        (node) => node.textContent?.trim() === "氏名",
      );
      const name = nameField?.nextElementSibling?.textContent?.trim();
      const lookupPending =
        cardText.includes("結果の公開状況を確認しています") ||
        cardText.includes("回答の公開状態を確認しています");
      return name ? (lookupPending ? "lookup_pending_with_name" : "settled_card") : "pending";
    });
    const requestsInMeasurement = visit.requests.slice(visit.measurement.startIndex);
    const lookupFailureRequest = requestsInMeasurement.find(
      (request) =>
        (request.endpoint_class === "participant_results" ||
          request.endpoint_class === "submission_visibility") &&
        (request.request_failed || (Number.isFinite(request.status) && request.status >= 400)),
    );
    const completionSourceConfirmed = requestsInMeasurement.some(
      (request) =>
        (request.endpoint_class === "answer_submission" ||
          request.endpoint_class === "answer_bootstrap") &&
        Number.isFinite(request.status) &&
        request.status >= 200 &&
        request.status < 300,
    );
    if (
      lookupFailureRequest &&
      completionSourceConfirmed &&
      (state === "lookup_failed" || state === "lookup_pending_with_name")
    ) {
      return {
        card_state:
          state === "lookup_failed"
            ? "lookup_failed_recovery_available"
            : "settled_with_lookup_failure",
        lookup_state:
          lookupFailureRequest.endpoint_class === "participant_results"
            ? "participant_results_failed"
            : "submission_visibility_failed",
        failure_kind: lookupFailureRequest.failure_kind,
        lookup_status: lookupFailureRequest.status ?? null,
      };
    }
    if (state === "settled_card" && completionSourceConfirmed) {
      const resultsRequest = [...visit.requests]
        .reverse()
        .find(
          (request) =>
            request.endpoint_class === "participant_results" && Number.isFinite(request.status),
        );
      return {
        card_state: "settled_completion_card",
        lookup_state:
          resultsRequest && resultsRequest.status >= 200 && resultsRequest.status < 300
            ? "participant_results_confirmed"
            : "completion_snapshot_confirmed",
        lookup_status: resultsRequest?.status ?? null,
      };
    }
    await visit.page.waitForTimeout(50);
  }
  throw new Error(`Completion card did not settle for ${visit.scenario}`);
}

async function runSubmissionSample(participantId, iteration, condition) {
  const visit = await openAnswer(
    participantId,
    `answer_submission_repeat_${iteration}_${condition}`,
  );
  visit.metricScenario = "answer_submission";
  visit.sampleIteration = iteration;
  visit.sampleCondition = condition;
  const firstQuestion = visit.page.locator('section[aria-labelledby="question-title-101"]');
  await firstQuestion.waitFor({ state: "visible", timeout: 20_000 });
  if (condition === "warm") {
    await warmRevisit(visit, () => firstQuestion.waitFor({ state: "visible", timeout: 20_000 }));
  }
  for (let index = 1; index <= 4; index += 1) {
    await visit.page
      .locator(`section[aria-labelledby="question-title-${100 + index}"]`)
      .getByRole("radio")
      .first()
      .check({ force: true });
  }
  await visit.page
    .getByRole("textbox", { name: "回答", exact: true })
    .fill("Synthetic free response");
  const submitStart = performance.now();
  await visit.page.getByRole("button", { name: "5問の回答を確定する", exact: true }).click();
  await waitForCompletionState(visit);
  visit.completionReadyMs = Number((performance.now() - submitStart).toFixed(2));
  await confirmCompletion(visit, "post_success_completion");
  checkpoint(visit, "post_success_completion");
  assertNoCompletionLookupsBeforeCheckpoint(visit);
  return settle(visit);
}

async function runSavedOwnerRevisitSample(participantId, iteration, condition) {
  const visit = await openAnswer(
    participantId,
    `saved_owner_revisit_repeat_${iteration}_${condition}`,
  );
  visit.metricScenario = "saved_owner_revisit";
  visit.sampleIteration = iteration;
  visit.sampleCondition = condition;
  await waitForCompletionState(visit);
  if (condition === "warm") {
    await warmRevisit(visit, () => waitForCompletionState(visit));
  }
  await confirmCompletion(visit, `${condition}_saved_owner_revisit`);
  checkpoint(visit, `${condition}_saved_revisit_completion`);
  assertNoCompletionLookupsBeforeCheckpoint(visit);
  return settle(visit);
}

try {
  await seed();
  await startServer();
  browser = await chromium.launch({
    headless: true,
    args: [
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--proxy-server=http://127.0.0.1:3001",
      "--proxy-bypass-list=127.0.0.1:3001",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
    ],
  });
  const results = [];

  const fresh = await openAnswer(703, "new_attempt");
  await fresh.page
    .locator('section[aria-labelledby="question-title-101"]')
    .waitFor({ state: "visible", timeout: 20_000 });
  fresh.firstQuestionReadyMs = fresh.elapsed();
  checkpoint(fresh, "initial_data_ready");
  await warmRevisit(fresh, () =>
    fresh.page
      .locator('section[aria-labelledby="question-title-101"]')
      .waitFor({ state: "visible", timeout: 20_000 }),
  );
  for (let index = 1; index <= 4; index += 1) {
    await fresh.page
      .locator(`section[aria-labelledby="question-title-${100 + index}"]`)
      .getByRole("radio")
      .first()
      .check({ force: true });
  }
  await fresh.page
    .getByRole("textbox", { name: "回答", exact: true })
    .fill("Synthetic free response");
  const submitStart = performance.now();
  await fresh.page.getByRole("button", { name: "5問の回答を確定する", exact: true }).click();
  await waitForCompletionState(fresh);
  fresh.completionReadyMs = Number((performance.now() - submitStart).toFixed(2));
  await confirmCompletion(fresh, "post_success_completion");
  checkpoint(fresh, "post_success_completion");
  assertNoCompletionLookupsBeforeCheckpoint(fresh);
  results.push(await settle(fresh));

  const assistedNew = await openAnswer(
    704,
    "assisted_new_attempt",
    "owner",
    "owner_session_preparation",
  );
  await assistedNew.page
    .getByRole("heading", { name: "回答済み", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  checkpoint(assistedNew, "owner_session_prepared");
  await enterAssistedTarget(assistedNew, false, "cold");
  await warmAssistedRevisit(assistedNew, false);
  results.push(await settle(assistedNew));

  const assistedNewDirect = await openAnswer(
    704,
    "assisted_new_direct_startup",
    "assisted",
    "assisted_new_initial_data",
  );
  const directFirstQuestion = assistedNewDirect.page.locator(
    'section[aria-labelledby="question-title-101"]',
  );
  await directFirstQuestion.waitFor({ state: "visible", timeout: 20_000 });
  if (
    await assistedNewDirect.page.getByRole("heading", { name: "回答済み", exact: true }).count()
  ) {
    throw new Error("Direct assisted-new startup unexpectedly rendered saved completion");
  }
  assistedNewDirect.firstQuestionReadyMs = assistedNewDirect.elapsed();
  checkpoint(assistedNewDirect, "initial_data_ready");
  assertDirectAssistedNewPath(
    assistedNewDirect,
    assistedNewDirect.measurement.startIndex,
    assistedNewDirect.checkpoints.at(-1).request_index,
  );
  await warmRevisit(assistedNewDirect, () =>
    directFirstQuestion.waitFor({ state: "visible", timeout: 20_000 }),
  );
  results.push(await settle(assistedNewDirect));

  const saved = await openAnswer(701, "saved_owner_revisit");
  await waitForCompletionState(saved);
  saved.completionReadyMs = saved.elapsed();
  await confirmCompletion(saved, "initial_saved_revisit");
  checkpoint(saved, "initial_data_ready");
  assertNoCompletionLookupsBeforeCheckpoint(saved);
  await warmRevisit(saved, () => waitForCompletionState(saved));
  await confirmCompletion(saved, "warm_saved_revisit");
  checkpoint(saved, "saved_revisit_completion");
  assertNoCompletionLookupsBeforeCheckpoint(saved);
  await saved.page
    .getByRole("button", { name: "回答を修正する", exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const savedEditRequestStartIndex = saved.requests.length;
  const savedEditStartedAtMs = saved.elapsed();
  const editStart = performance.now();
  await saved.page.getByRole("button", { name: "回答を修正する", exact: true }).click();
  await saved.page
    .locator('section[aria-labelledby="question-title-101"]')
    .waitFor({ state: "visible", timeout: 20_000 });
  saved.editReadyMs = Number((performance.now() - editStart).toFixed(2));
  checkpoint(saved, "first_edit_ready");
  const visibilityRefreshStartedAtMs = saved.elapsed();
  await saved.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await saved.page.waitForTimeout(150);
  checkpoint(saved, "tab_visible_refresh");
  const savedResult = await settle(saved);
  const savedEditRequests = savedResult.requests.slice(savedEditRequestStartIndex);
  const actionTimeVisibilityRequest = savedEditRequests.find(
    (request) =>
      request.endpoint_class === "submission_visibility" &&
      request.started_ms >= savedEditStartedAtMs &&
      request.started_ms < visibilityRefreshStartedAtMs,
  );
  if (actionTimeVisibilityRequest?.request_category !== "manual_action_refresh") {
    throw new Error(
      `Edit action visibility GET expected manual_action_refresh, found ${actionTimeVisibilityRequest?.request_category ?? "none"}`,
    );
  }
  const resumedVisibilityRequest = savedEditRequests.find(
    (request) =>
      request.endpoint_class === "submission_visibility" &&
      request.started_ms >= visibilityRefreshStartedAtMs,
  );
  if (resumedVisibilityRequest?.request_category !== "resume_or_focus_refresh") {
    throw new Error(
      `visibilitychange visibility GET expected resume_or_focus_refresh, found ${resumedVisibilityRequest?.request_category ?? "none"}`,
    );
  }
  savedResult.measurement_self_checks.push({
    action_time_visibility_get_category: actionTimeVisibilityRequest.request_category,
    visibilitychange_get_category: resumedVisibilityRequest.request_category,
  });
  results.push(savedResult);

  for (let iteration = 1; iteration <= REPEAT_COUNT; iteration += 1) {
    const coldParticipantId = 710 + (iteration - 1) * 2;
    const savedOwnerId = REPEAT_SAVED_OWNER_IDS[iteration - 1];
    results.push(await runSubmissionSample(coldParticipantId, iteration, "cold"));
    results.push(await runSubmissionSample(coldParticipantId + 1, iteration, "warm"));
    results.push(await runSavedOwnerRevisitSample(savedOwnerId, iteration, "cold"));
    results.push(await runSavedOwnerRevisitSample(savedOwnerId, iteration, "warm"));
  }

  const assisted = await openAnswer(
    701,
    "owner_assisted_cta",
    "owner",
    "owner_session_preparation",
  );
  await assisted.page
    .getByRole("heading", { name: "回答済み", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  assisted.completionReadyMs = assisted.elapsed();
  checkpoint(assisted, "owner_session_prepared");
  await enterAssistedTarget(assisted, true, "cold");
  await warmAssistedRevisit(assisted, true);
  results.push(await settle(assisted));

  const unauthenticated = await openAnswer(null, "unauthenticated_login_surface");
  await unauthenticated.page
    .getByRole("textbox", { name: "受験者氏名", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  const unauthenticatedStatus = await unauthenticated.page.evaluate(
    async () => (await fetch("/api/answers/latest")).status,
  );
  if (unauthenticatedStatus !== 401)
    throw new Error(
      `Expected unauthenticated latest endpoint to return 401, got ${unauthenticatedStatus}`,
    );
  unauthenticated.measurement.phase = "pre_auth_probe";
  checkpoint(unauthenticated, "pre_auth_probe_complete");
  await unauthenticated.page
    .getByRole("textbox", { name: "受験者氏名", exact: true })
    .fill("Benchmark owner");
  await unauthenticated.page.getByRole("textbox", { name: "受験コード", exact: true }).fill(PIN);
  beginMeasurement(unauthenticated, "post_login_recovery", "cold");
  await unauthenticated.page.getByRole("button", { name: "はじめる", exact: true }).click();
  checkpoint(unauthenticated, "reauthentication_submitted");
  await waitForCompletionState(unauthenticated);
  unauthenticated.completionReadyMs = unauthenticated.elapsed();
  await confirmCompletion(unauthenticated, "post_login_recovery");
  checkpoint(unauthenticated, "initial_data_ready");
  checkpoint(unauthenticated, "reauthenticated_saved_completion");
  results.push(await settle(unauthenticated));

  process.stdout.write(
    `${JSON.stringify({ measurement: "answer_confirmation_real_http_local_sqlite", mode: MODE, base_url: BASE_URL, repeat_count: REPEAT_COUNT, completion_metrics: summarizeCompletionMetrics(results), fixture: "disposable migration-backed SQLite, synthetic participants 701-705 and five synthetic questions", measurement_boundaries: { unauthenticated_login_surface: "pre_auth_probe ends before the login form is submitted; post_login_recovery starts immediately before the login button click and includes the session POST and subsequent owner bootstrap. Only one successful mode=owner bootstrap in that post-login interval contributes a count of 1. The initial unauthenticated 401 remains in its separate pre-auth interval and the full raw requests trace." }, metric_notes: ["bootstrap_measurements counts successful core API requests in each named interval. Direct assisted-new startup means opening /answer directly in assisted mode; its legacy session → assisted status → assisted latest → questions sequence has 4 requests, while one successful /api/answers/bootstrap?mode=assisted request counts as 1. Owner-to-target CTA activation and return-to-owner are separate scope_transition measurements, each asserting one scoped bootstrap. The raw requests trace retains every request, including failures and follow-ups.", "For owner-saved intervals, /api/participants/assisted is classified as saved follow-up and excluded from owner core counts. It remains part of direct assisted-new startup counts. Readiness probes and requests outside the named measurement interval are excluded.", "Owner-to-CTA scenarios report owner_session_preparation separately, then report assisted target activation and owner return as separate scope_transition measurements with one successful bootstrap each. Saved assisted edit still fetches its questions through the explicit legacy edit flow.", "For owner scenarios, cold is the first /answer navigation in a fresh Playwright browser context after the local Next server readiness probe; warm is an immediate reload in that same context. Owner-to-CTA assisted scenarios measure owner_session_preparation separately from assisted_saved_edit or assisted target selection; the saved edit phase begins immediately before its CTA and runs through the assisted bootstrap, explicit edit questions request, and restored choice readiness. Warm first returns to owner through the UI, then reloads the saved owner state before repeating the assisted CTA transition.", "The supported owner return clears assisted mode. Any saved assisted draft remains in session storage but is ignored in owner mode; re-entering the saved target verifies that the first saved choice is restored.", "Assisted new uses eligible saved owner 704 with linked target 705, which has no submission; both owner-to-CTA and direct assisted-mode startup are measured. Direct startup accepts either the legacy ordered request sequence or exactly one successful mode=assisted bootstrap request. Legacy direct startup has no owner latest lookup. Assisted saved uses saved owner 701 with linked saved target 702. The owner preparation checkpoint before the CTA asserts that questions were not fetched. The saved assisted CTA is itself the edit action; its assisted_saved_edit phase asserts one assisted bootstrap, the explicit edit questions request, and restored canonical choice A.", "initial_data_measurements reports separate phase/temperature request order, count, elapsed time, response status, and response body bytes through each readiness checkpoint; bootstrap_measurements adds mode, state, measurement scope, protocol, comparable count, core requests, and assisted-status follow-ups.", "Saved follow-up assisted-status, visibility, and results requests are split by endpoint and checkpoint phase; follow-ups are excluded from applicable owner-saved initial request counts.", "API response_body_bytes/json_body_bytes are decoded HTTP response bodies, not transport framing.", "json_body_bytes is null with json_body_bytes_null_reason when the response is non-JSON, its body read fails, or its body read times out.", "Grouped total_json_body_bytes is null when any JSON response body is unavailable; known_json_body_bytes excludes unknown bodies, and unknown_json_body_count reports them.", "content_length_header_bytes is reported only when the local server supplies that header.", "Resource Timing transfer_size_bytes and encoded_body_size_bytes are browser observations; zero or null may mean cache or unavailable data.", "This browser harness does not count SQL statements; use tests/db/answer-routes-latency.bench.ts for isolated real route SQL counts.", "Owner assisted edit timing runs from the edit CTA click until the first question becomes visible.", "completion_metrics summarizes POST-to-completion and bootstrap-to-completion intervals plus POST duration per scenario and cold/warm condition using nearest-rank p50/p95. Optional repeat samples are disabled by default to preserve the previous runtime; configure ANSWER_CONFIRMATION_REPEAT_COUNT to add equivalent focal samples."], scenarios: results }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (diagnosticVisit) {
    const { page, requests, scenario } = diagnosticVisit;
    const screenshotPath = join(tmpdir(), `stcirt-answer-confirmation-${process.pid}.png`);
    try {
      await Promise.race([Promise.allSettled(diagnosticVisit.responseTasks), delay(1_500)]);
      const [url, title, bodyText] = await Promise.all([
        page.url(),
        page.title().catch(() => "<unavailable>"),
        page
          .locator("body")
          .innerText({ timeout: 2_000 })
          .catch(() => "<unavailable>"),
      ]);
      process.stderr.write(
        `${JSON.stringify(
          {
            diagnostic: true,
            scenario,
            url,
            title,
            synthetic_page_text: bodyText.slice(0, 2_000),
            checkpoints: diagnosticVisit.checkpoints,
            measurement_self_checks: diagnosticVisit.measurementSelfChecks ?? [],
            pending_response_body_reads: requests.filter(
              (request) => request.response_body_read_status === "pending",
            ).length,
            api_requests: requests.map(
              ({
                method,
                path,
                status,
                json_body_bytes,
                json_body_bytes_null_reason,
                response_body_read_status,
              }) => ({
                method,
                path,
                status: status ?? null,
                json_body_bytes: json_body_bytes ?? null,
                json_body_bytes_null_reason: json_body_bytes_null_reason ?? null,
                response_body_read_status: response_body_read_status ?? "no_response",
              }),
            ),
            screenshot: screenshotPath,
            server_logs: serverLogs,
          },
          null,
          2,
        )}\n`,
      );
      await Promise.race([
        page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {}),
        delay(3_000),
      ]);
    } catch {}
  } else if (serverLogs) {
    process.stderr.write(
      `${JSON.stringify({ diagnostic: true, server_logs: serverLogs }, null, 2)}\n`,
    );
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (db) {
    try {
      await db.close();
    } catch {}
  }
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await rm(tempDir, { recursive: true, force: true });
}
