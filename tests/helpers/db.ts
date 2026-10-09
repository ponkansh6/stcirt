import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Logger } from "drizzle-orm/logger";
import * as schema from "@/lib/db/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates an isolated, file-backed test database with migrations applied.
 *
 * NOTE: we intentionally use a file-backed DB (not `:memory:`) because libsql
 * opens a *new* connection for `db.transaction()`. With `:memory:` each
 * connection is a separate empty database, so writes inside a transaction
 * would not be visible to subsequent reads on the original connection.
 */
export async function createTestDb(options: { logger?: Logger } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "study-test-"));
  const client = createClient({ url: `file:${dir}/test.db` });
  const db = drizzle({ client, schema, logger: options.logger });
  await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });
  return {
    db,
    client,
    cleanup: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;
