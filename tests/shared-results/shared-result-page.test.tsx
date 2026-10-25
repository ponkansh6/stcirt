import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import SharedResultPage from "@/app/shared-results/[token]/page";
import { readRateLimitedSharedParticipantResult } from "@/lib/participants/assisted-result-sharing";

const notFoundError = vi.hoisted(() => new Error("not found"));
const validToken = `v1.${"a".repeat(43)}.${"b".repeat(43)}`;
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw notFoundError;
  }),
}));
vi.mock("@/lib/participants/assisted-result-sharing", () => ({
  readRateLimitedSharedParticipantResult: vi.fn(),
}));

describe("/shared-results/[token] server entry", () => {
  it("uses the public per-share limiter and hides a rejected token", async () => {
    vi.mocked(readRateLimitedSharedParticipantResult).mockResolvedValueOnce({
      state: "not_found",
    });
    await expect(
      SharedResultPage({
        params: Promise.resolve({ token: validToken }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toBe(notFoundError);
    expect(readRateLimitedSharedParticipantResult).toHaveBeenCalledWith(validToken);
  });

  it("uses the same per-share reader for its server-rendered result", async () => {
    vi.mocked(readRateLimitedSharedParticipantResult).mockResolvedValueOnce({
      state: "ok",
      result: { state: "waiting" },
    });
    const result = await SharedResultPage({
      params: Promise.resolve({ token: validToken }),
      searchParams: Promise.resolve({}),
    });
    expect(readRateLimitedSharedParticipantResult).toHaveBeenCalledWith(validToken);
    expect(result).toBeTruthy();
  });

  it("renders a retryable message when the initial share read fails", async () => {
    vi.mocked(readRateLimitedSharedParticipantResult).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const result = await SharedResultPage({
      params: Promise.resolve({ token: validToken }),
      searchParams: Promise.resolve({}),
    });
    expect(result).toBeTruthy();
    expect(renderToStaticMarkup(result as ReactElement)).toContain("結果を確認できません");
  });
});
