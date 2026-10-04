import { drizzle, LibSQLDatabase } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";

function createDbClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (url) {
    return createClient({ url, authToken });
  }

  if (process.env.NEXT_BUILD) {
    return createClient({ url: ":memory:" });
  }

  throw new Error(
    "TURSO_DATABASE_URL is required at runtime. Set it in your environment or .env.local.",
  );
}

let dbInstance: LibSQLDatabase<typeof schema> | null = null;

function getDb() {
  if (!dbInstance) {
    const client = createDbClient();
    dbInstance = drizzle({ client, schema });
  }
  return dbInstance;
}

export const db = new Proxy({} as LibSQLDatabase<typeof schema>, {
  get(_target, prop) {
    const actualDb = getDb();
    const value = Reflect.get(actualDb, prop);
    if (typeof value === "function") {
      return value.bind(actualDb);
    }
    return value;
  },
});
