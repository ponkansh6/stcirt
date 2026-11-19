#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@libsql/client";

const JOURNAL_PATH = "src/lib/db/migrations/meta/_journal.json";

// Production previously recorded different hashes for these exact migration
// versions. Migration SQL is never executed or inserted into history here.
const KNOWN_PRODUCTION_HASH_VARIANTS = new Map([
  [
    "0011_reset_exam_submissions:1791388800004",
    {
      repositoryHash: "d26927e99364d0736cc5c11adc7ac013445e38ec867665c9db1fc5918ae0c8f2",
      productionHash: "8b4522bd9d548aa7015f22c1fa6089951a322b6dd883b7b45ef8ff4fcae20223",
    },
  ],
  [
    "0025_tennis_team_meal_q4:1794718408195",
    {
      repositoryHash: "f0ba77da54831d084b54c89bdeef1cc6c2f6f46d00d845ba08bdfce784d7053d",
      productionHash: "51b790ccbaa23fefe7d885a97e1cfb9a768ed308678bf7c2bb4c62b5402c7571",
    },
  ],
]);

function fail(message) {
  console.error(`[error] ${message}`);
  process.exitCode = 1;
}

function readGitObject(revision) {
  return execFileSync("git", ["show", revision], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function getCommitMigrations(revision) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
    throw new Error("push target is not a valid Git object ID");
  }

  const commit = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const journal = JSON.parse(readGitObject(`${commit}:${JOURNAL_PATH}`).toString("utf8"));

  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("migration journal is missing or empty");
  }

  let previousWhen = -Infinity;
  const migrations = [];
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index];
    if (
      entry.idx !== index ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousWhen ||
      typeof entry.tag !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(entry.tag)
    ) {
      throw new Error("migration journal entries are invalid or out of order");
    }

    previousWhen = entry.when;
    const sql = readGitObject(`${commit}:src/lib/db/migrations/${entry.tag}.sql`);
    const hash = createHash("sha256").update(sql).digest("hex");
    migrations.push({ tag: entry.tag, createdAt: String(entry.when), hash });
  }

  return migrations;
}

async function main() {
  const revisions = [...new Set(process.argv.slice(2))];
  if (revisions.length === 0) {
    fail("No push target commits were provided.");
    return;
  }

  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    fail(
      "Production migration history could not be checked because database credentials are missing.",
    );
    return;
  }

  let expected;
  try {
    const expectedMigrations = new Map();
    for (const revision of revisions) {
      for (const migration of getCommitMigrations(revision)) {
        const migrationKey = `${migration.createdAt}:${migration.tag}:${migration.hash}`;
        expectedMigrations.set(migrationKey, migration);
      }
    }
    expected = expectedMigrations;
  } catch {
    fail(
      "A push target has an invalid migration journal or is missing a referenced migration file.",
    );
    return;
  }

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    const result = await client.execute("SELECT hash, created_at FROM __drizzle_migrations");
    const appliedByTimestamp = new Map();
    for (const row of result.rows) {
      const timestamp = Number(row.created_at);
      const hash = String(row.hash).toLowerCase();
      if (!Number.isSafeInteger(timestamp) || !/^[0-9a-f]{64}$/.test(hash)) {
        fail("Production migration history contains an invalid record.");
        return;
      }
      const createdAt = String(timestamp);
      if (appliedByTimestamp.has(createdAt) && appliedByTimestamp.get(createdAt) !== hash) {
        fail(`Production migration history contains conflicting hashes at ${createdAt}.`);
        return;
      }
      appliedByTimestamp.set(createdAt, hash);
    }

    const latestAppliedAt = Math.max(...[...appliedByTimestamp.keys()].map(Number));
    const unapplied = [];
    for (const migration of expected.values()) {
      const { createdAt, tag } = migration;
      const appliedHash = appliedByTimestamp.get(createdAt);
      if (!appliedHash) {
        unapplied.push({ createdAt, tag });
        continue;
      }

      const knownVariant = KNOWN_PRODUCTION_HASH_VARIANTS.get(`${tag}:${createdAt}`);
      const acceptedHistoricalHash =
        knownVariant?.repositoryHash === migration.hash &&
        knownVariant.productionHash === appliedHash;

      if (migration.hash !== appliedHash && !acceptedHistoricalHash) {
        fail(
          `Production migration hash does not match the pushed migration ${tag} at ${createdAt}.`,
        );
        return;
      }

      if (acceptedHistoricalHash) {
        console.log(
          `[pre-push] Recognized historical hash variant for ${tag}; migration SQL was not rerun.`,
        );
      }
    }

    if (unapplied.length > 0) {
      const migrationNames = unapplied.map(({ tag }) => tag).join(", ");
      const skippedByDrizzle = unapplied.some(
        ({ createdAt }) => Number(createdAt) < latestAppliedAt,
      );
      if (skippedByDrizzle) {
        fail(
          `Production database has ${unapplied.length} unapplied migration(s) required by the push: ${migrationNames}. Drizzle resumes after the latest applied timestamp, so pnpm db:migrate alone will skip these missing migrations. Reconcile the missing migration(s) before pushing.`,
        );
      } else {
        fail(
          `Production database has ${unapplied.length} unapplied migration(s) required by the push: ${migrationNames}. Apply pending migrations with: pnpm db:migrate`,
        );
      }
      return;
    }

    console.log("[pre-push] Production migration history is up to date.");
  } catch {
    fail(
      "Production migration history could not be read. Check the database connection and apply pending migrations if needed.",
    );
  } finally {
    try {
      await client.close();
    } catch {
      // The read result determines whether the inspection succeeded.
    }
  }
}

main().catch(() => fail("Production migration history inspection failed unexpectedly."));
