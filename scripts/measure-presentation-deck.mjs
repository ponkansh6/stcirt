/*
 * Local synthetic benchmark for the real admin presentation deck GET route.
 * It creates a disposable migration-backed file SQLite database, starts the
 * existing production build on 127.0.0.1:3001, and calls the route with a
 * synthetic signed admin cookie. The database/auth settings are supplied by
 * this script and override the corresponding child-process environment values,
 * so .env.local database/auth values are not used. No route mocking, remote
 * Turso, or external network is used. Requires an existing `pnpm build` output.
 *
 * Reported JSON byte counts use UTF-8(JSON.stringify(value)) consistently:
 * the whole decoded response body, then each slide projection grouped by its
 * stage. Content-Length/Content-Encoding are captured separately as response
 * headers. Fetch may transparently decode a compressed body, so decoded bytes
 * are not wire bytes; headers exclude TLS and local Next may send no compression.
 * Repeated/changed revisions show only this fixture's route behavior. They do
 * not prove production cache reuse. Presenter Next/Previous action request
 * counts are not measured by this route-only benchmark.
 */
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { setTimeout as delay } from "node:timers/promises";

const HOST = "127.0.0.1";
const PORT = 3001;
const BASE_URL = `http://${HOST}:${PORT}`;
const DECK_URL = `${BASE_URL}/api/admin/presentation/deck`;
const ADMIN_PIN = "7316";
const ADMIN_SECRET = randomBytes(32).toString("hex");
const ADMIN_COOKIE = "stcirt_admin_presentation";
const ADMIN_PURPOSE = "stcirt-admin-presentation-session-v1";
const QUESTION_COUNT = 5;
const EXPECTED_STAGES = [
  "opening",
  "question",
  "answer",
  "podium_preview",
  "third",
  "second",
  "first",
  "finished",
];
const root = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), "stcirt-presentation-deck-"));
const dbPath = join(tempDir, "fixture.db");
let client;
let server;

function makeAdminCookie() {
  const key = createHmac("sha256", ADMIN_SECRET).update(ADMIN_PURPOSE).digest();
  const encoded = Buffer.from(
    JSON.stringify({ role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 }),
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
        sql: "INSERT INTO presentation_sessions (id, state, version, question_index, question_count, snapshot_revision) VALUES (?, ?, ?, ?, ?, ?)",
        args: [1, "finished", 1, QUESTION_COUNT - 1, QUESTION_COUNT, 1],
      },
      ...Array.from({ length: QUESTION_COUNT }, (_, index) => ({
        sql: "INSERT INTO presentation_questions (session_id, position, source_question_id, question, choices, correct_index, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          1,
          index,
          index + 1,
          `合成質問 ${index + 1}`,
          JSON.stringify(index === QUESTION_COUNT - 1 ? [] : ["選択肢A", "選択肢B"]),
          0,
          `合成解説 ${index + 1}`,
        ],
      })),
      ...[
        { id: 1, name: "合成参加者1", score: 5, rank: 1 },
        { id: 2, name: "合成参加者2", score: 4, rank: 2 },
        { id: 3, name: "合成参加者3", score: 3, rank: 3 },
      ].map(({ id, name, score, rank }) => ({
        sql: "INSERT INTO presentation_entries (session_id, participant_id, display_name, score, rank, answers) VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          1,
          id,
          name,
          score,
          rank,
          JSON.stringify(
            Array.from({ length: QUESTION_COUNT }, (_, index) => ({
              questionId: index + 1,
              answerKind: index === QUESTION_COUNT - 1 ? "freeText" : "selected",
              selectedIndex: index === QUESTION_COUNT - 1 ? null : 0,
              freeText: index === QUESTION_COUNT - 1 ? `合成自由記述 ${id}` : null,
              rawScore: index === QUESTION_COUNT - 1 ? 0.8 : null,
              normalizedScore: index === QUESTION_COUNT - 1 ? 0.8 : null,
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
        ...process.env,
        NODE_ENV: "production",
        TURSO_DATABASE_URL: `file:${dbPath}`,
        TURSO_AUTH_TOKEN: "local-synthetic-no-auth-token",
        ADMIN_PRESENTATION_PIN: ADMIN_PIN,
        ADMIN_PRESENTATION_SESSION_SECRET: ADMIN_SECRET,
      },
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
      const response = await fetch(`${BASE_URL}/api/admin/presentation?view=controls`, {
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      });
      if (response.status > 0) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for production server:\n${logs}`);
}

function stageByteCounts(deck) {
  const grouped = new Map();
  for (const slide of deck.slides) {
    const current = grouped.get(slide.state) ?? [];
    current.push(slide.projection);
    grouped.set(slide.state, current);
  }
  return Object.fromEntries(
    [...grouped].map(([state, projections]) => [
      state,
      {
        slide_count: projections.length,
        projection_json_utf8_bytes: Buffer.byteLength(JSON.stringify(projections), "utf8"),
      },
    ]),
  );
}

async function fetchDeck(label, expectedFirstQuestion = "合成質問 1") {
  const response = await fetch(DECK_URL, {
    headers: { cookie: `${ADMIN_COOKIE}=${makeAdminCookie()}` },
    cache: "no-store",
  });
  const decodedBody = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200) {
    throw new Error(
      `${label}: expected HTTP 200, got ${response.status}: ${decodedBody.toString("utf8")}`,
    );
  }
  const deck = JSON.parse(decodedBody.toString("utf8"));
  if (!Array.isArray(deck.slides) || !Number.isInteger(deck.snapshotRevision)) {
    throw new Error(`${label}: deck response did not contain slides and snapshotRevision`);
  }
  if (deck.slides.length !== 16) {
    throw new Error(`${label}: expected 16 synthetic deck slides, got ${deck.slides.length}`);
  }
  const stages = [...new Set(deck.slides.map((slide) => slide.state))].sort();
  if (JSON.stringify(stages) !== JSON.stringify([...EXPECTED_STAGES].sort())) {
    throw new Error(`${label}: unexpected synthetic deck stages: ${stages.join(", ")}`);
  }
  const questionSlide = deck.slides.find(
    (slide) => slide.state === "question" && slide.questionIndex === 0,
  );
  const answerSlide = deck.slides.find(
    (slide) => slide.state === "answer" && slide.questionIndex === 0,
  );
  const freeTextAnswerSlide = deck.slides.find(
    (slide) => slide.state === "answer" && slide.questionIndex === QUESTION_COUNT - 1,
  );
  const firstWinnerSlide = deck.slides.find((slide) => slide.state === "first");
  const firstWinnerQuestionResults = firstWinnerSlide?.projection?.winners?.[0]?.questionResults;
  if (
    questionSlide?.projection?.question?.question !== expectedFirstQuestion ||
    questionSlide.projection.question.answerType !== "selected" ||
    answerSlide?.projection?.question?.correctAnswer !== "選択肢A" ||
    answerSlide.projection.question.question !== expectedFirstQuestion ||
    firstWinnerQuestionResults?.[0]?.answer?.kind !== "selected" ||
    firstWinnerQuestionResults[0].answer.value !== "選択肢A" ||
    firstWinnerQuestionResults[0].correctness !== "correct" ||
    freeTextAnswerSlide?.projection?.question?.answerType !== "freeText" ||
    freeTextAnswerSlide.projection.question.expectedAnswer !== "合成解説 5" ||
    !Array.isArray(firstWinnerQuestionResults) ||
    firstWinnerQuestionResults.length !== QUESTION_COUNT ||
    firstWinnerQuestionResults[QUESTION_COUNT - 1]?.answer?.kind !== "freeText" ||
    firstWinnerQuestionResults[QUESTION_COUNT - 1].answer.value !== "合成自由記述 1" ||
    firstWinnerQuestionResults[QUESTION_COUNT - 1].normalizedScore !== 0.8
  ) {
    throw new Error(
      `${label}: representative synthetic question/answer projection data is missing`,
    );
  }
  return {
    label,
    status: response.status,
    content_length_header: response.headers.get("content-length"),
    content_encoding_header: response.headers.get("content-encoding"),
    decoded_response_json_utf8_bytes: decodedBody.byteLength,
    decoded_response_json: deck,
    decoded_response_body: decodedBody.toString("utf8"),
    snapshot_revision: deck.snapshotRevision,
    slide_count: deck.slides.length,
    stage_bytes: stageByteCounts(deck),
  };
}

async function measure() {
  await seedDatabase();
  await startServer();
  const first = await fetchDeck("initial");
  const repeated = await fetchDeck("repeated_same_revision");
  if (repeated.snapshot_revision !== first.snapshot_revision) {
    throw new Error("Repeated deck GET unexpectedly changed snapshotRevision");
  }
  if (
    repeated.decoded_response_body !== first.decoded_response_body ||
    JSON.stringify(repeated.decoded_response_json) !== JSON.stringify(first.decoded_response_json)
  ) {
    throw new Error("Repeated same-revision deck GET returned different decoded body/JSON");
  }

  client = createClient({ url: `file:${dbPath}` });
  await client.batch(
    [
      {
        sql: "UPDATE presentation_questions SET question = ? WHERE session_id = ? AND position = ?",
        args: ["合成質問 変更後", 1, 0],
      },
      {
        sql: "UPDATE presentation_sessions SET snapshot_revision = snapshot_revision + 1 WHERE id = ?",
        args: [1],
      },
    ],
    "write",
  );
  await client.close();
  client = undefined;

  const changed = await fetchDeck(
    "changed_revision_after_synthetic_question_update",
    "合成質問 変更後",
  );
  if (changed.snapshot_revision !== first.snapshot_revision + 1) {
    throw new Error("Synthetic question update did not advance the deck snapshotRevision");
  }
  const changedQuestionSlide = changed.decoded_response_json.slides.find(
    (slide) => slide.state === "question" && slide.questionIndex === 0,
  );
  const changedAnswerSlide = changed.decoded_response_json.slides.find(
    (slide) => slide.state === "answer" && slide.questionIndex === 0,
  );
  const changedWinnerSlide = changed.decoded_response_json.slides.find(
    (slide) => slide.state === "first",
  );
  if (
    changedQuestionSlide?.projection?.question?.question !== "合成質問 変更後" ||
    changedAnswerSlide?.projection?.question?.question !== "合成質問 変更後" ||
    changedWinnerSlide?.projection?.winners?.[0]?.questionResults?.[0]?.question !==
      "合成質問 変更後"
  ) {
    throw new Error(
      "Synthetic update was not reflected in question, answer, and questionResults projections",
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        measurement: "local_synthetic_real_admin_presentation_deck_get",
        base_url: BASE_URL,
        database: "disposable_file_backed_sqlite",
        fixture: `${QUESTION_COUNT} synthetic questions, three synthetic participants with ranks 1/2/3, canonical fifth freeText question, finished presentation`,
        bytes_definition:
          "Decoded JSON bytes are UTF-8 bytes of the exact response body consumed by fetch; stage bytes are UTF-8 JSON.stringify bytes of each state's slide projection array.",
        limits: [
          "Content-Length and Content-Encoding are reported as received; fetch may decode the body before it is read.",
          "Headers exclude TLS framing; local Next may not compress this response.",
          "Repeated and changed snapshot revisions describe this synthetic local fixture and do not prove production cache reuse.",
          "Presenter browser Next/Previous action request counts are not measured by this route-only benchmark.",
          "No production data, .env.local database, remote Turso, route mocks, or external network is used.",
        ],
        samples: [first, repeated, changed].map(
          ({ decoded_response_body: _body, decoded_response_json: _json, ...sample }) => sample,
        ),
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
