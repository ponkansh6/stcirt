import { vi } from "vitest";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub global fetch with a handler that returns either a Response or a body to wrap. */
export function mockFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const result = await handler(url, init);
    return result instanceof Response ? result : jsonResponse(result);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
