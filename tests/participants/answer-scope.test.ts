import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";

vi.mock("@/lib/db/repository/assisted-participant-repository", () => ({
  getAssistedTargetId: vi.fn(),
}));

import { getAssistedTargetId } from "@/lib/db/repository/assisted-participant-repository";

beforeEach(() => vi.clearAllMocks());

describe("resolveAnswerScope", () => {
  it("uses the signed-in participant as the default owner scope", async () => {
    await expect(resolveAnswerScope(7, null)).resolves.toEqual({ participantId: 7 });
    expect(getAssistedTargetId).not.toHaveBeenCalled();
  });

  it("resolves an assisted scope only through the owner-to-target link", async () => {
    vi.mocked(getAssistedTargetId).mockResolvedValueOnce(18);
    await expect(resolveAnswerScope(7, "assisted")).resolves.toEqual({ participantId: 18 });
    expect(getAssistedTargetId).toHaveBeenCalledWith(7);
  });

  it("rejects unrecognized scopes and missing assisted links", async () => {
    await expect(resolveAnswerScope(7, "other")).resolves.toEqual({
      error: "Invalid answer scope",
      status: 400,
    });
    vi.mocked(getAssistedTargetId).mockResolvedValueOnce(null);
    await expect(resolveAnswerScope(7, "assisted")).resolves.toEqual({
      error: "Assisted participant not found",
      status: 404,
    });
  });
});
