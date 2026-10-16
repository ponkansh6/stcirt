import { beforeEach, describe, expect, it, vi } from "vitest";
import ResultsPage, { dynamic } from "@/app/results/page";
import { Suspense, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cookies } from "next/headers";
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

async function renderProtectedResult(element: ReactElement) {
  const boundary = element as ReactElement<{
    children: ReactElement<{ participantId: number; scope: "owner" | "assisted" }>;
    fallback: ReactElement;
  }>;
  expect(boundary.type).toBe(Suspense);
  const content = boundary.props.children;
  const render = content.type as (props: typeof content.props) => Promise<ReactElement>;
  // The unit renderer cannot exercise Next's React Server Component streaming protocol.
  return render(content.props);
}

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
    })) as ReactElement;

    expect(dynamic).toBe("force-dynamic");
    expect(getParticipantResult).not.toHaveBeenCalled();
    const fallback = (element.props as { fallback: ReactElement }).fallback;
    const markup = renderToStaticMarkup(fallback);
    expect(markup).toContain("代理回答者の結果");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("min-h-[56rem]");
    expect(markup).not.toContain("Question");
    expect(markup).not.toContain("Choice");
    expect(markup).not.toContain("4位");
    const panel = (await renderProtectedResult(element)) as ReactElement<{
      initial: unknown;
      scope: string;
    }>;

    expect(panel.props.scope).toBe("assisted");
    expect(panel.props.initial).toEqual({
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

  it("uses the owner scope when no assisted scope is requested", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({ state: "waiting" });

    const element = (await ResultsPage({
      searchParams: Promise.resolve({}),
    })) as ReactElement;
    const fallback = (element.props as { fallback: ReactElement }).fallback;
    const markup = renderToStaticMarkup(fallback);
    const panel = (await renderProtectedResult(element)) as ReactElement<{
      initial: unknown;
      scope: string;
    }>;

    expect(markup).toContain("あなたの結果");
    expect(markup).not.toContain("代理回答者の結果");
    expect(panel.props.scope).toBe("owner");
    expect(panel.props.initial).toEqual({ state: "waiting" });
    expect(resolveAnswerScope).toHaveBeenCalledWith(12, null);
    expect(getParticipantResult).toHaveBeenCalledWith(12);
  });

  it("returns neutral content when cookie verification throws", async () => {
    vi.mocked(cookies).mockRejectedValueOnce(new Error("cookie store unavailable"));

    const element = (await ResultsPage({
      searchParams: Promise.resolve({ scope: "assisted" }),
    })) as ReactElement<{ initial: unknown; scope: string }>;

    expect(element.props.scope).toBe("assisted");
    expect(element.props.initial).toEqual({ state: "waiting" });
    expect(findParticipantById).not.toHaveBeenCalled();
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

    const element = (await ResultsPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    const panel = (await renderProtectedResult(element)) as ReactElement<{ initial: unknown }>;

    expect(panel.props.initial).toEqual({
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

  it("keeps expected private states inline and propagates unexpected result retrieval errors", async () => {
    vi.mocked(getParticipantResult).mockResolvedValueOnce({ state: "waiting" });
    const waitingBoundary = (await ResultsPage({
      searchParams: Promise.resolve({}),
    })) as ReactElement;
    const waiting = (await renderProtectedResult(waitingBoundary)) as ReactElement<{
      initial: unknown;
    }>;
    expect(waiting.props.initial).toEqual({ state: "waiting" });

    vi.mocked(getParticipantResult).mockResolvedValueOnce({ state: "unavailable" });
    const unavailableBoundary = (await ResultsPage({
      searchParams: Promise.resolve({}),
    })) as ReactElement;
    const unavailable = (await renderProtectedResult(unavailableBoundary)) as ReactElement<{
      initial: unknown;
    }>;
    expect(unavailable.props.initial).toEqual({ state: "unavailable" });

    vi.mocked(getParticipantResult).mockRejectedValueOnce(new Error("database unavailable"));
    const errorBoundary = (await ResultsPage({
      searchParams: Promise.resolve({}),
    })) as ReactElement;
    await expect(renderProtectedResult(errorBoundary)).rejects.toThrow("database unavailable");
    expect(getParticipantResult).toHaveBeenCalledTimes(3);
  });
});
