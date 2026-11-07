/*
 * Seed a disposable local SQLite database for the public /presentation page.
 * This creates only a synthetic presentation session and never loads .env files.
 *
 * Usage:
 *   node .hallmark/seed-presentation-first-prize.mjs /tmp/presentation-first-prize.db
 *   TURSO_DATABASE_URL=file:/tmp/presentation-first-prize.db node .hallmark/seed-presentation-first-prize.mjs
 */
import { createClient } from "@libsql/client";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isInside(directory, target) {
  const pathFromDirectory = relative(directory, target);
  return (
    pathFromDirectory === "" ||
    (pathFromDirectory !== ".." &&
      !pathFromDirectory.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromDirectory))
  );
}

async function resolveLocalDatabaseUrl() {
  if (process.argv.length > 3) {
    throw new Error("Usage: node .hallmark/seed-presentation-first-prize.mjs <sqlite-file-path>");
  }

  const argument = process.argv[2];
  const configuredUrl = process.env.TURSO_DATABASE_URL;
  if (configuredUrl && !configuredUrl.startsWith("file:")) {
    throw new Error("TURSO_DATABASE_URL must use file: for this local-only helper");
  }
  const input = argument ?? configuredUrl;
  if (!input) {
    throw new Error("Provide a SQLite file path or TURSO_DATABASE_URL=file:<path>");
  }

  let databasePath = input;
  if (input.startsWith("file:")) {
    databasePath = input.slice("file:".length);
    if (databasePath.startsWith("//") || /[?#]/.test(databasePath)) {
      throw new Error("Only a local SQLite file URL is allowed");
    }
    try {
      databasePath = decodeURIComponent(databasePath);
    } catch {
      throw new Error("Invalid SQLite file URL");
    }
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    throw new Error("Only a local SQLite file path is allowed");
  }

  if (!databasePath || databasePath === ":memory:") {
    throw new Error("Provide a path to a disposable SQLite file");
  }

  const requestedPath = resolve(databasePath);
  const temporaryRoot = await realpath(tmpdir());
  let targetInfo;
  try {
    targetInfo = await lstat(requestedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Could not inspect the SQLite file path");
  }
  if (targetInfo?.isSymbolicLink()) {
    throw new Error("Refusing to use a symbolic link as the SQLite database file");
  }

  let resolvedParent;
  try {
    resolvedParent = await realpath(dirname(requestedPath));
  } catch {
    throw new Error("The SQLite file parent directory must already exist");
  }
  const resolvedPath = resolve(resolvedParent, basename(requestedPath));
  if (!isInside(temporaryRoot, resolvedPath)) {
    throw new Error("The SQLite database file must be inside the system temporary directory");
  }
  return `file:${resolvedPath}`;
}

async function applyMigrations(client) {
  const migrationsPath = resolve(root, "src/lib/db/migrations");
  const journal = JSON.parse(await readFile(resolve(migrationsPath, "meta/_journal.json"), "utf8"));
  if (journal.dialect !== "sqlite" || !Array.isArray(journal.entries)) {
    throw new Error("Unexpected Drizzle migration journal");
  }

  for (const entry of journal.entries) {
    const migration = await readFile(resolve(migrationsPath, `${entry.tag}.sql`), "utf8");
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await client.execute(statement);
  }
}

async function seed() {
  const client = createClient({ url: await resolveLocalDatabaseUrl() });
  try {
    const existingTables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    );
    if (existingTables.rows.length > 0) {
      throw new Error("Refusing to seed a SQLite database that already contains tables");
    }

    await applyMigrations(client);
    await client.batch(
      [
        {
          sql: "INSERT INTO presentation_sessions (id, state, version, question_index, question_count, snapshot_revision, projection_hidden, presentation_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [1, "first_prize", 1, 0, 1, 1, 0, "full"],
        },
      ],
      "write",
    );
  } finally {
    await client.close();
  }
}

seed().then(
  () => console.log("Seeded synthetic first-prize presentation state in the local SQLite file."),
  () => {
    console.error("Could not seed the local SQLite file; check the path and migration files.");
    process.exitCode = 1;
  },
);
