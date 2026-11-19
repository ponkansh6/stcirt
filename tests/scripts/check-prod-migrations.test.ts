// @vitest-environment node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const checkerPath = join(root, "scripts/check-prod-migrations.mjs");
const temporaryDirectories: string[] = [];

type Migration = { tag: string; when: number; sql: string };

const migrations: Migration[] = [
  { tag: "0001_first", when: 1, sql: "CREATE TABLE first_table (id INTEGER);" },
  { tag: "0002_second", when: 2, sql: "CREATE TABLE second_table (id INTEGER);" },
  { tag: "0003_third", when: 3, sql: "CREATE TABLE third_table (id INTEGER);" },
];

type Fixture = {
  directory: string;
  databasePath: string;
  commit: string;
  migrations: Migration[];
  env: NodeJS.ProcessEnv;
};

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "stcirt-prod-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runGit(directory: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function makeFixture(fixtureMigrations: Migration[] = migrations): Promise<Fixture> {
  const directory = await temporaryDirectory();
  const databasePath = join(directory, "history.db");
  const migrationDirectory = join(directory, "src/lib/db/migrations");
  await mkdir(join(migrationDirectory, "meta"), { recursive: true });
  await writeFile(
    join(migrationDirectory, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: fixtureMigrations.map((migration, idx) => ({
        idx,
        version: "6",
        when: migration.when,
        tag: migration.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const migration of fixtureMigrations) {
    await writeFile(join(migrationDirectory, `${migration.tag}.sql`), migration.sql);
  }

  runGit(directory, ["init", "--quiet"]);
  runGit(directory, ["config", "user.name", "Migration checker tests"]);
  runGit(directory, ["config", "user.email", "migration-checker@example.invalid"]);
  runGit(directory, ["add", "src/lib/db/migrations"]);
  runGit(directory, ["commit", "--quiet", "-m", "fixture migrations"]);
  const commit = runGit(directory, ["rev-parse", "HEAD"]);

  return {
    directory,
    databasePath,
    commit,
    migrations: fixtureMigrations,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      TURSO_DATABASE_URL: `file:${databasePath}`,
      TURSO_AUTH_TOKEN: "local-test-token",
    },
  };
}

async function writeHistory(
  fixture: Fixture,
  appliedIndexes: number[],
  hashOverrides = new Map<number, string>(),
) {
  const client = createClient({ url: `file:${fixture.databasePath}` });
  try {
    await client.execute(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    for (const index of appliedIndexes) {
      const migration = fixture.migrations[index]!;
      const hash =
        hashOverrides.get(index) ?? createHash("sha256").update(migration.sql).digest("hex");
      await client.execute({
        sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        args: [hash, migration.when],
      });
    }
  } finally {
    await client.close();
  }
}

async function addMigrationCommit(fixture: Fixture) {
  const migrationDirectory = join(fixture.directory, "src/lib/db/migrations");
  const journalPath = join(migrationDirectory, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  const migration = {
    tag: "0004_pending",
    when: 4,
    sql: "CREATE TABLE pending_table (id INTEGER);",
  };
  journal.entries.push({
    idx: journal.entries.length,
    version: "6",
    when: migration.when,
    tag: migration.tag,
    breakpoints: true,
  });
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(migrationDirectory, `${migration.tag}.sql`), migration.sql);
  runGit(fixture.directory, ["add", "src/lib/db/migrations"]);
  runGit(fixture.directory, ["commit", "--quiet", "-m", "add pending migration"]);
  return runGit(fixture.directory, ["rev-parse", "HEAD"]);
}

function runChecker(
  fixture: Fixture,
  envOverrides: Partial<NodeJS.ProcessEnv> = {},
  revisions = [fixture.commit],
) {
  return spawnSync("node", [checkerPath, ...revisions], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...fixture.env, ...envOverrides, NODE_ENV: fixture.env.NODE_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production migration history checker", () => {
  it("accepts the pushed commit when every migration timestamp and hash is applied", async () => {
    const fixture = await makeFixture();
    await writeHistory(fixture, [0, 1, 2]);

    const result = runChecker(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("checks every pushed ref when the final ref is already fully applied", async () => {
    const fixture = await makeFixture();
    const commitWithPendingMigration = await addMigrationCommit(fixture);
    await writeHistory(fixture, [0, 1, 2]);

    const result = runChecker(fixture, {}, [commitWithPendingMigration, fixture.commit]);

    expect(result.status).toBe(1);
  });

  it("rejects a missing middle migration even when a later migration is recorded", async () => {
    const fixture = await makeFixture();
    await writeHistory(fixture, [0, 2]);

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
  });

  it("rejects a recorded timestamp whose SQL hash differs from the pushed commit", async () => {
    const fixture = await makeFixture();
    await writeHistory(fixture, [0, 1, 2], new Map([[1, "0".repeat(64)]]));

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
  });

  it("accepts the known legacy production hash for the tennis team meal migration", async () => {
    const migration: Migration = {
      tag: "0025_tennis_team_meal_q4",
      when: 1794718408195,
      sql: await readFile(join(root, "src/lib/db/migrations/0025_tennis_team_meal_q4.sql"), "utf8"),
    };
    const fixture = await makeFixture([migration]);
    await writeHistory(
      fixture,
      [0],
      new Map([[0, "51b790ccbaa23fefe7d885a97e1cfb9a768ed308678bf7c2bb4c62b5402c7571"]]),
    );

    const result = runChecker(fixture);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("reads migration files from the pushed commit instead of the dirty worktree", async () => {
    const fixture = await makeFixture();
    await writeHistory(fixture, [0, 1, 2]);
    await writeFile(
      join(fixture.directory, "src/lib/db/migrations/0002_second.sql"),
      "CREATE TABLE changed_after_commit (id INTEGER);",
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(0);
  });

  it("fails closed when the migration history table is absent", async () => {
    const fixture = await makeFixture();

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
  });

  it("fails closed when database credentials are missing", async () => {
    const fixture = await makeFixture();

    const result = runChecker(fixture, {
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
    });

    expect(result.status).toBe(1);
  });
});
