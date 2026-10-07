#!/bin/sh
# Check that the production Turso DB schema matches schema.ts.
# Read-only — does not modify the database.
# Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... scripts/check-prod-schema.sh

set -e

if [ -z "$TURSO_DATABASE_URL" ] || [ -z "$TURSO_AUTH_TOKEN" ]; then
  echo "❌ Production schema check requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN" >&2
  exit 1
fi

echo "🔍 Checking production schema consistency..."

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SCHEMA_PROJECT_ROOT="$PROJECT_ROOT" node 2>&1 <<'NODE'
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

function extractTableColumnBlock(schemaContent, tableName) {
  const declarationRegex = new RegExp(
    'export const \\w+ = sqliteTable\\s*\\(\\s*"' + tableName + '"\\s*,\\s*\\{',
  );
  const declaration = declarationRegex.exec(schemaContent);
  if (!declaration) return null;

  const openingBrace = declaration.index + declaration[0].lastIndexOf('{');
  let depth = 0;
  for (let i = openingBrace; i < schemaContent.length; i += 1) {
    if (schemaContent[i] === '{') depth += 1;
    if (schemaContent[i] === '}') {
      depth -= 1;
      if (depth === 0) return schemaContent.slice(openingBrace + 1, i);
    }
  }

  // An incomplete declaration is ignored; the bounded scan above cannot loop forever.
  return null;
}

async function main() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const schemaPath = path.join(process.env.SCHEMA_PROJECT_ROOT, 'src/lib/db/schema.ts');
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

  // Extract all table names defined via sqliteTable in schema.ts
  const tableRegex = /export const \w+ = sqliteTable\s*\(\s*\"(\w+)\"/g;
  const expectedTables = [];
  let t;
  while ((t = tableRegex.exec(schemaContent)) !== null) {
    expectedTables.push(t[1]);
  }

  const tablesResult = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const actualTables = new Set(tablesResult.rows.map(r => r.name));

  const missingTables = expectedTables.filter(tt => !actualTables.has(tt));

  if (missingTables.length > 0) {
    console.log('');
    console.log('❌ Production database schema drift detected.');
    console.log('   Production is missing tables required by the current application schema.');
    console.log('   Missing tables:');
    missingTables.forEach(tt => console.log('   - ' + tt));
    console.log('');
    console.log('   Apply the project migrations to production with:');
    console.log('   pnpm db:migrate');
    console.log('');
    process.exit(1);
  }

  // Check column drift for each table
  for (const tableName of expectedTables) {
    const colBlock = extractTableColumnBlock(schemaContent, tableName);
    if (colBlock === null) continue;
    // Match the physical column name passed to a Drizzle column builder,
    // not string options such as { mode: "json" }.
    const colRegex = /\b\w+\s*:\s*\w+\s*\(\s*"(\w+)"/g;
    const expectedCols = new Set();
    let c;
    while ((c = colRegex.exec(colBlock)) !== null) {
      expectedCols.add(c[1]);
    }

    const colResult = await client.execute('PRAGMA table_info(' + tableName + ')');
    const actualCols = new Set(colResult.rows.map(r => r.name));

    const missingCols = [];
    for (const col of expectedCols) {
      if (!actualCols.has(col)) {
        missingCols.push(col);
      }
    }

    if (missingCols.length > 0) {
      console.log('');
      console.log('❌ Production database schema drift detected in table: ' + tableName);
      console.log('   Production is missing columns required by the current application schema.');
      console.log('   Missing columns:');
      missingCols.forEach(cc => console.log('   - ' + cc));
      console.log('');
      console.log('   Apply the project migrations to production with:');
      console.log('   pnpm db:migrate');
      console.log('');
      process.exit(1);
    }
  }

  console.log('✅ Production schema is up to date');
  client.close();
}

main().catch(err => {
  console.error('Schema check failed:', err.message);
  process.exit(1);
});
NODE
