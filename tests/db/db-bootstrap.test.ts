import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, drizzle } = vi.hoisted(() => ({
  createClient: vi.fn(),
  drizzle: vi.fn(),
}));

vi.mock("@libsql/client", () => ({ createClient }));
vi.mock("drizzle-orm/libsql", () => ({ drizzle }));

const fakeClient = { name: "fake-client" };
const read = vi.fn(function (this: unknown) {
  return this;
});
const fakeDb = {
  label: "fake-db",
  read,
};

const envKeys = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "NEXT_BUILD"] as const;
let originalEnv: Partial<Record<(typeof envKeys)[number], string>>;

async function loadDb() {
  return {
    db: (await import("../../src/lib/db/index")).db as unknown as Record<string, unknown>,
  };
}

describe("database bootstrap", () => {
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    vi.resetModules();
    vi.clearAllMocks();
    createClient.mockReturnValue(fakeClient);
    drizzle.mockReturnValue(fakeDb);
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  it("initializes lazily on first property access and caches the database", async () => {
    process.env.TURSO_DATABASE_URL = "libsql://example.test";
    const { db } = await loadDb();

    expect(createClient).not.toHaveBeenCalled();
    expect(drizzle).not.toHaveBeenCalled();

    expect(db.label).toBe("fake-db");
    expect(db.label).toBe("fake-db");
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(drizzle).toHaveBeenCalledTimes(1);
  });

  it("passes the configured URL and auth token to the client", async () => {
    process.env.TURSO_DATABASE_URL = "libsql://example.test";
    process.env.TURSO_AUTH_TOKEN = "test-token";

    const { db } = await loadDb();
    void db.label;

    expect(createClient).toHaveBeenCalledWith({
      url: "libsql://example.test",
      authToken: "test-token",
    });
  });

  it("passes the URL without an auth token when no token is configured", async () => {
    process.env.TURSO_DATABASE_URL = "libsql://example.test";

    const { db } = await loadDb();
    void db.label;

    expect(createClient).toHaveBeenCalledWith({
      url: "libsql://example.test",
      authToken: undefined,
    });
  });

  it("uses an in-memory client when the URL is missing during a Next build", async () => {
    process.env.NEXT_BUILD = "1";

    const { db } = await loadDb();
    void db.label;

    expect(createClient).toHaveBeenCalledWith({ url: ":memory:" });
  });

  it("throws when the URL is missing outside a Next build", async () => {
    const { db } = await loadDb();

    await expect(Promise.resolve().then(() => db.label)).rejects.toThrow(
      "TURSO_DATABASE_URL is required at runtime. Set it in your environment or .env.local.",
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(drizzle).not.toHaveBeenCalled();
  });

  it("forwards properties and binds database methods to the initialized database", async () => {
    process.env.TURSO_DATABASE_URL = "libsql://example.test";
    const { db } = await loadDb();

    expect(db.label).toBe("fake-db");
    expect((db.read as () => unknown)()).toBe(fakeDb);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
