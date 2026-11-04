import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/admin/presentation/reference-participants/route";
import {
  createAdminPresentationSession,
  ADMIN_PRESENTATION_COOKIE,
} from "@/lib/presentation/admin-auth";

vi.mock("@/lib/db/repository/presentation-repository", () => ({
  getPresentationReferenceNames: vi.fn(),
  setPresentationReferenceNames: vi.fn(),
}));

import {
  getPresentationReferenceNames,
  setPresentationReferenceNames,
} from "@/lib/db/repository/presentation-repository";

const envKeys = ["ADMIN_PRESENTATION_PIN", "ADMIN_PRESENTATION_SESSION_SECRET"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function authenticate() {
  const session = createAdminPresentationSession();
  if (!session) throw new Error("Test admin session was not created");
  return `${ADMIN_PRESENTATION_COOKIE}=${session.value}`;
}

function request(
  method: "GET" | "PUT",
  options: { cookie?: string; origin?: string; body?: unknown } = {},
) {
  return new Request("http://localhost/api/admin/presentation/reference-participants", {
    method,
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
      Host: "localhost",
      "Content-Type": "application/json",
    },
    ...(method === "PUT" ? { body: JSON.stringify(options.body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_PRESENTATION_PIN = "admin-pin";
  process.env.ADMIN_PRESENTATION_SESSION_SECRET =
    "admin-test-session-secret-with-at-least-32-bytes";
  vi.mocked(getPresentationReferenceNames).mockResolvedValue([]);
  vi.mocked(setPresentationReferenceNames).mockImplementation(async (names) => names);
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("/api/admin/presentation/reference-participants", () => {
  it("requires admin authentication for reading and same-origin admin mutation for saving", async () => {
    expect((await GET(request("GET"))).status).toBe(401);
    const cookie = authenticate();
    expect(
      (
        await PUT(
          request("PUT", { cookie, origin: "https://attacker.example", body: { namesText: "A" } }),
        )
      ).status,
    ).toBe(403);
    expect(setPresentationReferenceNames).not.toHaveBeenCalled();
  });

  it("returns uncached saved names to an authenticated administrator", async () => {
    const response = await GET(request("GET", { cookie: authenticate() }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ names: [] });
  });

  it("returns unavailable when admin auth is not configured", async () => {
    const getRequest = request("GET");
    const putRequest = request("PUT", {
      origin: "http://localhost",
      body: { namesText: "A" },
    });
    delete process.env.ADMIN_PRESENTATION_PIN;
    delete process.env.ADMIN_PRESENTATION_SESSION_SECRET;

    const getResponse = await GET(getRequest);
    expect(getResponse.status).toBe(503);
    expect(getResponse.headers.get("Cache-Control")).toBe("no-store, private");
    const putResponse = await PUT(putRequest);
    expect(putResponse.status).toBe(503);
    expect(setPresentationReferenceNames).not.toHaveBeenCalled();
  });

  it("returns unavailable when reading or saving settings fails", async () => {
    vi.mocked(getPresentationReferenceNames).mockRejectedValueOnce(new Error("read failed"));
    const getResponse = await GET(request("GET", { cookie: authenticate() }));
    expect(getResponse.status).toBe(503);

    vi.mocked(setPresentationReferenceNames).mockRejectedValueOnce(new Error("write failed"));
    const putResponse = await PUT(
      request("PUT", {
        cookie: authenticate(),
        origin: "http://localhost",
        body: { namesText: "A" },
      }),
    );
    expect(putResponse.status).toBe(503);
    expect(putResponse.headers.get("Cache-Control")).toBe("no-store, private");
  });

  it("saves only exact nonblank lines and ignores empty or whitespace-only lines", async () => {
    const response = await PUT(
      request("PUT", {
        cookie: authenticate(),
        origin: "http://localhost",
        body: { namesText: "\r\n Alice \r\n\t\nBob\nAlice " },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ names: [" Alice ", "Bob", "Alice "] });
    expect(setPresentationReferenceNames).toHaveBeenCalledWith([" Alice ", "Bob", "Alice "]);
  });

  it.each([
    null,
    [],
    {},
    "not an object",
    { namesText: 3 },
    { namesText: "A", isReference: true },
    { namesText: "A".repeat(121) },
    { namesText: "A".repeat(500 * (120 + 2) + 1) },
  ])("rejects invalid payloads without writing settings", async (body) => {
    const response = await PUT(
      request("PUT", { cookie: authenticate(), origin: "http://localhost", body }),
    );
    expect(response.status).toBe(400);
    expect(setPresentationReferenceNames).not.toHaveBeenCalled();
  });

  it("rejects more than 500 nonblank names", async () => {
    const namesText = Array.from({ length: 501 }, () => "A").join("\n");
    const response = await PUT(
      request("PUT", { cookie: authenticate(), origin: "http://localhost", body: { namesText } }),
    );
    expect(response.status).toBe(400);
    expect(setPresentationReferenceNames).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await PUT(
      new Request("http://localhost/api/admin/presentation/reference-participants", {
        method: "PUT",
        headers: {
          Cookie: authenticate(),
          Origin: "http://localhost",
          Host: "localhost",
          "Content-Type": "application/json",
        },
        body: "{broken",
      }),
    );
    expect(response.status).toBe(400);
    expect(setPresentationReferenceNames).not.toHaveBeenCalled();
  });
});
