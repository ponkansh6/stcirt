import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessState, Phase } from "@/app/answer/use-quiz-session";
import {
  makeSubmissionVisibilityKey,
  useSubmissionVisibility,
  type SubmissionVisibilitySnapshot,
} from "@/app/answer/use-submission-visibility";

function props(revision = 1) {
  return {
    access: { kind: "ready", participant: { id: 7, name: "参加者" } } as AccessState,
    answerMode: "owner" as const,
    assistedParticipantId: undefined,
    submissionId: "submission-1",
    revision,
    phase: { kind: "complete" } as Phase,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function visibilityResponse(resultsVisible: boolean) {
  return new Response(JSON.stringify({ resultsVisible }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSubmissionVisibility live snapshot", () => {
  it("keeps unknown state for callers that do not pass a synchronous snapshot ref", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(visibilityResponse(true)));
    const initialProps: Parameters<typeof useSubmissionVisibility>[0] = {
      ...props(),
      submissionId: null,
    };
    const { result, rerender } = renderHook(({ hookProps }) => useSubmissionVisibility(hookProps), {
      initialProps: { hookProps: initialProps },
    });

    expect(result.current).toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();

    rerender({ hookProps: props() });
    await waitFor(() => expect(result.current).toBe("locked"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the synchronous publication snapshot through a same-key render", async () => {
    const firstResponse = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(firstResponse.promise));
    const liveSnapshotRef: { current: SubmissionVisibilitySnapshot | null } = { current: null };
    const initialProps = props();
    const { rerender } = renderHook(
      ({ hookProps }) => useSubmissionVisibility(hookProps, liveSnapshotRef),
      { initialProps: { hookProps: initialProps } },
    );
    const key = makeSubmissionVisibilityKey({
      participantId: 7,
      answerMode: "owner",
      assistedParticipantId: undefined,
      submissionId: "submission-1",
      revision: 1,
    });

    await act(async () => {
      firstResponse.resolve(visibilityResponse(false));
      await firstResponse.promise;
    });
    await waitFor(() => expect(liveSnapshotRef.current).toEqual({ key, status: "unlocked" }));

    // Model the synchronous write performed by a newer publication response just
    // before React commits its matching state update. A render for another change
    // can happen in that window, but must not restore an older unlocked snapshot.
    liveSnapshotRef.current = { key, status: "locked" };
    rerender({ hookProps: initialProps });

    expect(liveSnapshotRef.current).toEqual({ key, status: "locked" });
  });

  it("invalidates a prior revision snapshot before a stale response can be applied", async () => {
    const oldResponse = deferred<Response>();
    const currentResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise),
    );
    const liveSnapshotRef: { current: SubmissionVisibilitySnapshot | null } = { current: null };
    const firstProps = props(1);
    const { rerender } = renderHook(
      ({ hookProps }) => useSubmissionVisibility(hookProps, liveSnapshotRef),
      { initialProps: { hookProps: firstProps } },
    );

    const nextProps = props(2);
    rerender({ hookProps: nextProps });
    const currentKey = makeSubmissionVisibilityKey({
      participantId: 7,
      answerMode: "owner",
      assistedParticipantId: undefined,
      submissionId: "submission-1",
      revision: 2,
    });
    expect(liveSnapshotRef.current).toEqual({ key: currentKey, status: "unknown" });

    await act(async () => {
      oldResponse.resolve(visibilityResponse(false));
      await oldResponse.promise;
    });
    expect(liveSnapshotRef.current).toEqual({ key: currentKey, status: "unknown" });

    await act(async () => {
      currentResponse.resolve(visibilityResponse(true));
      await currentResponse.promise;
    });
    await waitFor(() =>
      expect(liveSnapshotRef.current).toEqual({ key: currentKey, status: "locked" }),
    );
  });

  it.each([
    ["malformed", new Response(JSON.stringify({ resultsVisible: "false" }), { status: 200 })],
    ["failed", new Response(null, { status: 503 })],
  ])("writes unknown synchronously for a %s response", async (_label, response) => {
    const responsePromise = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(responsePromise.promise));
    const liveSnapshotRef: { current: SubmissionVisibilitySnapshot | null } = { current: null };
    const hookProps = props();
    renderHook(() => useSubmissionVisibility(hookProps, liveSnapshotRef));
    const key = makeSubmissionVisibilityKey({
      participantId: 7,
      answerMode: "owner",
      assistedParticipantId: undefined,
      submissionId: "submission-1",
      revision: 1,
    });

    await act(async () => {
      responsePromise.resolve(response);
      await responsePromise.promise;
    });

    expect(liveSnapshotRef.current).toEqual({ key, status: "unknown" });
  });
});
