#!/bin/sh
# Read-only comparison of a trusted/local schema file with the production DB.
# Exit codes: 0 = match, 1 = drift, 2 = missing credentials, 3 = inspection failure.
# Usage: SCHEMA_FILE=... TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... scripts/check-prod-schema.sh

set -eu

if [ -z "${TURSO_DATABASE_URL:-}" ] || [ -z "${TURSO_AUTH_TOKEN:-}" ]; then
  echo "::error::Production schema inspection could not run: database credentials are missing."
  exit 2
fi

if [ -z "${SCHEMA_FILE:-}" ] || [ ! -f "$SCHEMA_FILE" ]; then
  echo "::error::Production schema inspection failed: SCHEMA_FILE is missing or unreadable."
  exit 3
fi

echo "🔍 Checking production schema consistency (read-only)..."
SCHEMA_FILE="$SCHEMA_FILE" node 2>&1 <<'NODE'
function inspectionFailure(message) {
  console.error(`::error::Production schema inspection failed: ${message}`);
  process.exitCode = 3;
}

async function main() {
  let createClient;
  let parseExpectedSchema;
  let fs;
  try {
    ({ createClient } = require('@libsql/client'));
    ({ parseExpectedSchema } = require('./scripts/prod-schema-parser.cjs'));
    fs = require('node:fs');
  } catch (error) {
    inspectionFailure(`checker dependency could not be loaded (${error.message}).`);
    return;
  }

  let content;
  try {
    const bytes = fs.readFileSync(process.env.SCHEMA_FILE);
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    inspectionFailure(`schema file could not be read as UTF-8 (${error.message}).`);
    return;
  }

  let expectedSchema;
  try {
    expectedSchema = parseExpectedSchema(content);
  } catch (error) {
    inspectionFailure(error.message);
    return;
  }
  const expectedTables = expectedSchema.map(({ tableName }) => tableName);

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  try {
    const tablesResult = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const actualTables = new Set(tablesResult.rows.map((row) => row.name));
    const missingTables = expectedTables.filter((tableName) => !actualTables.has(tableName));
    const missingColumnsByTable = [];
    for (const { tableName, columns: expectedColumns } of expectedSchema) {
      if (!missingTables.includes(tableName)) {
        // The identifier has passed a strict ASCII allowlist before SQL use.
        const colResult = await client.execute(`PRAGMA table_info("${tableName}")`);
        const actualColumns = new Set(colResult.rows.map((row) => row.name));
        const missingColumns = expectedColumns.filter((columnName) => !actualColumns.has(columnName));
        if (missingColumns.length > 0) missingColumnsByTable.push({ tableName, columns: missingColumns });
      }
    }

    if (missingTables.length > 0 || missingColumnsByTable.length > 0) {
      console.error('::error::Production database schema drift detected.');
      for (const tableName of missingTables) console.error(`Missing table: ${tableName}`);
      for (const entry of missingColumnsByTable) {
        console.error(`Missing columns in ${entry.tableName}: ${entry.columns.join(', ')}`);
      }
      console.error('Apply the project migrations to production with: pnpm db:migrate');
      process.exitCode = 1;
      return;
    }
    console.log('✅ Production schema is up to date');
  } catch (error) {
    inspectionFailure(`database query failed (${error.message}).`);
  } finally {
    try {
      await client.close();
    } catch (error) {
      if (process.exitCode !== 1 && process.exitCode !== 3) {
        inspectionFailure(`database client close failed (${error.message}).`);
      }
    }
  }
}

main().catch((error) => inspectionFailure(`unexpected checker error (${error.message}).`));
NODE
