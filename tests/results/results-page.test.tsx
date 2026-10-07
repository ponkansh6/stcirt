import { beforeEach, describe, expect, it, vi } from "vitest";
import ResultsPage, { dynamic } from "@/app/results/page";
import type { ReactElement } from "react";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";

const cookieState = vi.hoisted(() => ({ token: "valid-session" as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => (cookieState.token ? { value: cookieState.token } : undefined),
  })),
}));
vi.mock("@/lib/db/repository/participant-repository", () => ({ findParticipantById: vi.fn() }));
vi.mock("@/lib/db/repository/presentation-repository", () => ({ getParticipantResult: vi.fn() }));
vi.mock("@/lib/participants/security", () => ({
  PARTICIPANT_COOKIE: "stcirt_participant_session",
  verifyParticipantSession: vi.fn((token?: string) =>
    token === "valid-session" ? { id: 12, expiresAt: new Date() } : null,
  ),
}));

beforeEach(() => {
  cookieState.token = "valid-session";
  vi.clearAllMocks();
  vi.mocked(findParticipantById).mockResolvedValue({ id: 12, name: "Participant" });
});

describe("/results server entry", () => {
  it("is dynamic and passes only the current participant's published result to the client panel", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({
      state: "visible",
      rank: 4,
      score: 2.25,
      questions: [
        {
          position: 0,
          question: "Question",
          answer: { kind: "unanswered" },
        },
      ],
    });

    const element = (await ResultsPage()) as ReactElement<{ initial: unknown }>;

    expect(dynamic).toBe("force-dynamic");
    expect(element.props.initial).toEqual({
      state: "visible",
      rank: 4,
      score: 2.25,
      questions: [{ position: 0, question: "Question", answer: { kind: "unanswered" } }],
    });
    expect(findParticipantById).toHaveBeenCalledWith(12);
    expect(getParticipantResult).toHaveBeenCalledWith(12);
  });

  it("does not query results for an unauthenticated visitor", async () => {
    cookieState.token = undefined;

    const element = (await ResultsPage()) as ReactElement<{ initial: unknown }>;

    expect(element.props.initial).toEqual({ state: "unauthenticated" });
    expect(findParticipantById).not.toHaveBeenCalled();
    expect(getParticipantResult).not.toHaveBeenCalled();
  });
});
