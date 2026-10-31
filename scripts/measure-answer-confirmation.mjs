/*
 * Measure the real /answer confirmation flow against a disposable SQLite DB.
 * Production is the default. Build first with `pnpm build`; use
 * ANSWER_CONFIRMATION_MODE=dev for a separate development StrictMode sample.
 * The server binds only to 127.0.0.1:3001. This records response JSON bytes and
 * browser Resource Timing observations; neither is a remote wire-size measure.
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
const COOKIE_NAME = "stcirt_participant_session";
const SESSION_PURPOSE = "stcirt-participant-session-v1";
const PIN = "7316";
const SECRET = randomBytes(32).toString("hex");
const MODE = process.env.ANSWER_CONFIRMATION_MODE === "dev" ? "dev" : "production";
const RESPONSE_BODY_TIMEOUT_MS = 1_500;
const root = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "stcirt-answer-confirmation-"));
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
        sql: "INSERT INTO assisted_participants (owner_participant_id, target_participant_id) VALUES (?, ?)",
        args: [701, 702],
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
      ...[701, 702].map((participantId, index) => ({
        sql: "INSERT INTO exam_answer_submissions (id, participant_id, question_ids, question_versions, revision) VALUES (?, ?, ?, ?, ?)",
        args: [
          `00000000-0000-4000-8000-00000000070${index + 1}`,
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
      ...[701, 702].flatMap((participantId) =>
        [101, 102, 103, 104, 105].map((questionId, i) => ({
          sql: "INSERT INTO exam_submission_answers (submission_id, question_id, answer_kind, selected_index, free_text) VALUES (?, ?, ?, ?, ?)",
          args: [
            `00000000-0000-4000-8000-00000000070${participantId === 701 ? 1 : 2}`,
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

async function openAnswer(participantId, scenario) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
  if (participantId !== null) {
    await context.addCookies([
      { name: COOKIE_NAME, value: makeCookie(participantId), url: BASE_URL },
    ]);
  }
  const page = await context.newPage();
  const requests = [];
  const started = new Map();
  const responseTasks = [];
  const externalRequests = [];
  const visitStarted = performance.now();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== BASE_URL) externalRequests.push(url.href);
    if (!url.pathname.startsWith("/api/")) return;
    const key = `${request.method()} ${url.pathname}${url.search}`;
    started.set(request, performance.now());
    requests.push({
      method: request.method(),
      path: `${url.pathname}${url.search}`,
      started_ms: Number((performance.now() - visitStarted).toFixed(2)),
      key,
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    if (!new URL(response.url()).pathname.startsWith("/api/")) return;
    responseTasks.push(
      (async () => {
        const record = [...requests]
          .reverse()
          .find(
            (entry) =>
              entry.key ===
                `${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search}` &&
              entry.status === undefined,
          );
        if (!record) return;
        record.status = response.status();
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
    elapsed,
    checkpoints,
  };
  diagnosticVisit = visit;
  await page.goto(`${BASE_URL}/answer`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(100);
  return visit;
}

function checkpoint(visit, name) {
  const counts = {};
  for (const request of visit.requests) {
    const key = `${request.method} ${new URL(`http://localhost${request.path}`).pathname}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  visit.checkpoints.push({
    name,
    elapsed_ms: visit.elapsed(),
    request_index: visit.requests.length,
    request_counts_by_method_path: counts,
  });
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
  if (visit.externalRequests.length)
    throw new Error(`Observed non-local request: ${visit.externalRequests[0]}`);
  const requestGroups = new Map();
  for (const request of visit.requests) {
    const groupKey = `${request.method} ${request.path} ${request.status ?? "failed"}`;
    const group = requestGroups.get(groupKey) ?? {
      method: request.method,
      path: request.path,
      status: request.status ?? null,
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
    first_question_ready_ms: visit.firstQuestionReadyMs ?? null,
    completion_ready_ms: visit.completionReadyMs ?? null,
    edit_ready_ms: visit.editReadyMs ?? null,
    checkpoints: visit.checkpoints,
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
  await fresh.page
    .getByRole("heading", { name: "回答済み" })
    .waitFor({ state: "visible", timeout: 20_000 });
  fresh.completionReadyMs = Number((performance.now() - submitStart).toFixed(2));
  checkpoint(fresh, "post_success_completion");
  results.push(await settle(fresh));

  const saved = await openAnswer(701, "saved_owner_revisit");
  await saved.page
    .getByRole("heading", { name: "回答済み" })
    .waitFor({ state: "visible", timeout: 20_000 });
  saved.completionReadyMs = saved.elapsed();
  checkpoint(saved, "saved_revisit_completion");
  await saved.page
    .getByRole("button", { name: "回答を修正する", exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const editStart = performance.now();
  await saved.page.getByRole("button", { name: "回答を修正する", exact: true }).click();
  await saved.page
    .locator('section[aria-labelledby="question-title-101"]')
    .waitFor({ state: "visible", timeout: 20_000 });
  saved.editReadyMs = Number((performance.now() - editStart).toFixed(2));
  checkpoint(saved, "first_edit_ready");
  await saved.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await saved.page.waitForTimeout(150);
  checkpoint(saved, "tab_visible_refresh");
  results.push(await settle(saved));

  const assisted = await openAnswer(701, "owner_assisted_cta");
  await assisted.page
    .getByRole("heading", { name: "回答済み" })
    .waitFor({ state: "visible", timeout: 20_000 });
  assisted.completionReadyMs = assisted.elapsed();
  checkpoint(assisted, "owner_assisted_completion");
  await assisted.page
    .getByRole("button", { name: /^(代理回答を修正する|代理回答を行う)$/ })
    .waitFor({ state: "visible", timeout: 20_000 });
  const assistedEditStart = performance.now();
  await assisted.page.getByRole("button", { name: "代理回答を修正する", exact: true }).click();
  await assisted.page
    .locator('section[aria-labelledby="question-title-101"]')
    .waitFor({ state: "visible", timeout: 20_000 });
  assisted.editReadyMs = Number((performance.now() - assistedEditStart).toFixed(2));
  checkpoint(assisted, "owner_assisted_edit_ready");
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
  await unauthenticated.page
    .getByRole("textbox", { name: "受験者氏名", exact: true })
    .fill("Benchmark owner");
  await unauthenticated.page.getByRole("textbox", { name: "受験コード", exact: true }).fill(PIN);
  await unauthenticated.page.getByRole("button", { name: "はじめる", exact: true }).click();
  checkpoint(unauthenticated, "reauthentication_submitted");
  await unauthenticated.page
    .getByRole("heading", { name: "回答済み" })
    .waitFor({ state: "visible", timeout: 20_000 });
  unauthenticated.completionReadyMs = unauthenticated.elapsed();
  checkpoint(unauthenticated, "reauthenticated_saved_completion");
  results.push(await settle(unauthenticated));

  process.stdout.write(
    `${JSON.stringify({ measurement: "answer_confirmation_real_http_local_sqlite", mode: MODE, base_url: BASE_URL, fixture: "disposable migration-backed SQLite, synthetic participants 701-703 and five synthetic questions", metric_notes: ["API response_body_bytes/json_body_bytes are decoded HTTP response bodies, not transport framing.", "json_body_bytes is null with json_body_bytes_null_reason when the response is non-JSON, its body read fails, or its body read times out.", "Grouped total_json_body_bytes is null when any JSON response body is unavailable; known_json_body_bytes excludes unknown bodies, and unknown_json_body_count reports them.", "content_length_header_bytes is reported only when the local server supplies that header.", "Resource Timing transfer_size_bytes and encoded_body_size_bytes are browser observations; zero or null may mean cache or unavailable data.", "This browser harness does not count SQL statements; use tests/db/answer-routes-latency.bench.ts for isolated real route SQL counts.", "Owner assisted edit timing runs from the edit CTA click until the first question becomes visible."], scenarios: results }, null, 2)}\n`,
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
