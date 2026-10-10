import { beforeEach, describe, expect, it, vi } from "vitest";
import ResultsPage, { dynamic } from "@/app/results/page";
import type { ReactElement } from "react";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";

const cookieState = vi.hoisted(() => ({ token: "valid-session" as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => (cookieState.token ? { value: cookieState.token } : undefined),
  })),
}));
vi.mock("@/lib/db/repository/participant-repository", () => ({ findParticipantById: vi.fn() }));
vi.mock("@/lib/db/repository/presentation-repository", () => ({ getParticipantResult: vi.fn() }));
vi.mock("@/lib/participants/answer-scope", () => ({ resolveAnswerScope: vi.fn() }));
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
  vi.mocked(resolveAnswerScope).mockResolvedValue({ participantId: 12 });
});

describe("/results server entry", () => {
  it("resolves the assisted participant and passes their published result to the client panel", async () => {
    vi.mocked(resolveAnswerScope).mockResolvedValueOnce({ participantId: 18 });
    vi.mocked(getParticipantResult).mockResolvedValueOnce(
      Object.assign(
        { state: "visible" as const, rank: 4, score: 0.5 },
        {
          questions: [
            {
              position: 0,
              question: "Question",
              answer: {
                kind: "selected" as const,
                value: "Choice",
                correctness: "correct" as const,
              },
            },
          ],
        },
      ),
    );

    const element = (await ResultsPage({
      searchParams: Promise.resolve({ scope: "assisted" }),
    })) as ReactElement<{ initial: unknown; scope: string }>;

    expect(dynamic).toBe("force-dynamic");
    expect(element.props.scope).toBe("assisted");
    expect(element.props.initial).toEqual({
      state: "visible",
      rank: 4,
      score: 0.5,
      questions: [
        {
          position: 0,
          question: "Question",
          answer: { kind: "selected", value: "Choice", correctness: "correct" },
        },
      ],
    });
    expect(findParticipantById).toHaveBeenCalledWith(12);
    expect(resolveAnswerScope).toHaveBeenCalledWith(12, "assisted");
    expect(getParticipantResult).toHaveBeenCalledWith(18);
  });

  it("fails closed for an invalid scope without resolving or querying a result", async () => {
    const element = (await ResultsPage({
      searchParams: Promise.resolve({ scope: "other" }),
    })) as ReactElement<{ initial: unknown; scope: string | null }>;

    expect(element.props.scope).toBeNull();
    expect(element.props.initial).toEqual({ state: "unavailable" });
    expect(resolveAnswerScope).not.toHaveBeenCalled();
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("shows unavailable when the assisted participant cannot be resolved", async () => {
    vi.mocked(resolveAnswerScope).mockResolvedValueOnce({
      error: "Assisted participant not found",
      status: 404,
    });

    const element = (await ResultsPage({
      searchParams: Promise.resolve({ scope: "assisted" }),
    })) as ReactElement<{ initial: unknown; scope: string }>;

    expect(element.props.scope).toBe("assisted");
    expect(element.props.initial).toEqual({ state: "unavailable" });
    expect(resolveAnswerScope).toHaveBeenCalledWith(12, "assisted");
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("does not query results for an unauthenticated visitor", async () => {
    cookieState.token = undefined;

    const element = (await ResultsPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
      initial: unknown;
    }>;

    expect(element.props.initial).toEqual({ state: "unauthenticated" });
    expect(findParticipantById).not.toHaveBeenCalled();
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("fails closed when the authenticated participant no longer exists", async () => {
    vi.mocked(findParticipantById).mockResolvedValueOnce(null);

    const element = (await ResultsPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
      initial: unknown;
    }>;

    expect(element.props.initial).toEqual({ state: "unauthenticated" });
    expect(findParticipantById).toHaveBeenCalledWith(12);
    expect(getParticipantResult).not.toHaveBeenCalled();
  });

  it("passes free-text and legacy answer shapes through without adding selected-answer fields", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({
      state: "visible",
      rank: 1,
      score: 1,
      questions: [
        {
          position: 0,
          question: "自由記述",
          answer: { kind: "freeText", value: "回答", score: null },
        },
        {
          position: 1,
          question: "以前の回答",
          answer: { kind: "legacy" },
        },
        {
          position: 2,
          question: "未回答",
          answer: { kind: "unanswered" },
        },
      ],
    });

    const element = (await ResultsPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
      initial: unknown;
    }>;

    expect(element.props.initial).toEqual({
      state: "visible",
      rank: 1,
      score: 1,
      questions: [
        {
          position: 0,
          question: "自由記述",
          answer: { kind: "freeText", value: "回答", score: null },
        },
        { position: 1, question: "以前の回答", answer: { kind: "legacy" } },
        { position: 2, question: "未回答", answer: { kind: "unanswered" } },
      ],
    });
  });

  it("passes through a private result state and keeps waiting when server verification throws", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({ state: "unavailable" });
    const unavailable = (await ResultsPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
      initial: unknown;
    }>;
    expect(unavailable.props.initial).toEqual({ state: "unavailable" });

    vi.mocked(findParticipantById).mockRejectedValueOnce(new Error("database unavailable"));
    const waiting = (await ResultsPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
      initial: unknown;
    }>;
    expect(waiting.props.initial).toEqual({ state: "waiting" });
    expect(getParticipantResult).toHaveBeenCalledTimes(1);
  });
});
