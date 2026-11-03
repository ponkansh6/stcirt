import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessState, Phase } from "@/app/answer/use-quiz-session";
import {
  makeSubmissionVisibilityKey,
  useSubmissionVisibility,
  type SubmissionVisibilitySnapshot,
} from "@/app/answer/use-submission-visibility";

const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");

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

function readySnapshot({
  scope = "owner",
  ownerParticipantId = 7,
  participantId = 7,
  submissionId = "submission-1",
  revision = 1,
  resultsVisible = false,
}: {
  scope?: "owner" | "assisted";
  ownerParticipantId?: number;
  participantId?: number;
  submissionId?: string;
  revision?: number;
  resultsVisible?: boolean;
} = {}) {
  return {
    status: "ready" as const,
    identity: { scope, ownerParticipantId, participantId, submissionId, revision },
    resultsState: resultsVisible ? ("visible" as const) : ("waiting" as const),
    resultsVisible,
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
  if (visibilityStateDescriptor) {
    Object.defineProperty(document, "visibilityState", visibilityStateDescriptor);
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

describe("useSubmissionVisibility live snapshot", () => {
  it("seeds an exact completion snapshot and suppresses only the initial visibility GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(visibilityResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps));

    expect(result.current.status).toBe("unlocked");
    expect(result.current.lookupStatus).toBe("settled");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("locked");
  });

  it("seeds the owner and assisted target as distinct identities", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const completionSnapshot = readySnapshot({
      scope: "assisted",
      participantId: 8,
      resultsVisible: true,
    });
    const hookProps = {
      ...props(),
      answerMode: "assisted" as const,
      assistedParticipantId: 8,
      phase: { kind: "complete", completionSnapshot } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps));

    expect(result.current.status).toBe("locked");
    expect(result.current.lookupStatus).toBe("settled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies a fresh same-key bootstrap snapshot over older live visibility state", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const initialProps = {
      ...props(),
      phase: {
        kind: "complete",
        completionSnapshot: readySnapshot({ resultsVisible: true }),
      } as Phase,
    };
    const { result, rerender } = renderHook(({ hookProps }) => useSubmissionVisibility(hookProps), {
      initialProps: { hookProps: initialProps },
    });

    expect(result.current.status).toBe("locked");
    expect(fetchMock).not.toHaveBeenCalled();

    const refreshedProps = {
      ...props(),
      phase: {
        kind: "complete",
        completionSnapshot: readySnapshot({ resultsVisible: false }),
      } as Phase,
    };
    rerender({ hookProps: refreshedProps });

    expect(result.current.status).toBe("unlocked");
    expect(result.current.lookupStatus).toBe("settled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not repeat the owner visibility GET when assisted target data arrives", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const initialProps: Parameters<typeof useSubmissionVisibility>[0] = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const { result, rerender } = renderHook(({ hookProps }) => useSubmissionVisibility(hookProps), {
      initialProps: { hookProps: initialProps },
    });

    expect(result.current.status).toBe("unlocked");
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ hookProps: { ...initialProps, assistedParticipantId: 702 } });

    expect(result.current.status).toBe("unlocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears a same-key ready seed and recovers when a new snapshot failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(visibilityResponse(false));
    vi.stubGlobal("fetch", fetchMock);
    const readyProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const { result, rerender } = renderHook(({ hookProps }) => useSubmissionVisibility(hookProps), {
      initialProps: { hookProps: readyProps },
    });

    expect(result.current.status).toBe("unlocked");
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({
      hookProps: {
        ...props(),
        phase: {
          kind: "complete",
          completionSnapshot: {
            status: "failed",
            identity: readySnapshot().identity,
            resultsState: null,
            resultsVisible: null,
          },
        } as Phase,
      },
    });

    expect(result.current.status).toBe("unknown");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toBe("unlocked"));
  });

  it("rechecks the current visibility identity and returns only confirmed unlocked state", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps));

    expect(fetchMock).not.toHaveBeenCalled();
    let recheckPromise!: Promise<boolean>;
    await act(async () => {
      recheckPromise = result.current.recheck();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("unknown");
    expect(result.current.lookupStatus).toBe("pending");

    let canEdit = false;
    await act(async () => {
      response.resolve(visibilityResponse(false));
      canEdit = await recheckPromise;
    });
    expect(canEdit).toBe(true);
    expect(result.current.status).toBe("unlocked");
    expect(result.current.lookupStatus).toBe("settled");
  });

  it("returns false when a saved-submission recheck is inactive", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSubmissionVisibility({ ...props(), revision: 0 }));

    let canEdit = true;
    await act(async () => {
      canEdit = await result.current.recheck();
    });

    expect(canEdit).toBe(false);
    expect(result.current.lookupStatus).toBe("inactive");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not refresh when a queued visibility interval runs after unmount", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const view = renderHook(() => useSubmissionVisibility(hookProps));
    const intervalCallback = setIntervalSpy.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    expect(typeof intervalCallback).toBe("function");

    view.unmount();
    await act(async () => {
      (intervalCallback as () => void)();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces recheck with the current identity's initial visibility GET", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSubmissionVisibility(props()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    let canEdit = false;
    await act(async () => {
      const recheckPromise = result.current.recheck();
      response.resolve(visibilityResponse(false));
      canEdit = await recheckPromise;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(canEdit).toBe(true);
    expect(result.current.status).toBe("unlocked");
    expect(result.current.lookupStatus).toBe("settled");
  });

  it("refreshes on persisted pageshow and coalesces the resume visibility event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(visibilityResponse(false));
    vi.stubGlobal("fetch", fetchMock);
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps));

    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      const nonPersistedPageShow = new Event("pageshow");
      Object.defineProperty(nonPersistedPageShow, "persisted", { value: false });
      window.dispatchEvent(nonPersistedPageShow);
      document.dispatchEvent(new Event("visibilitychange"));
      const persistedPageShow = new Event("pageshow");
      Object.defineProperty(persistedPageShow, "persisted", { value: true });
      window.dispatchEvent(persistedPageShow);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("unlocked");
  });

  it("returns false from a fresh recheck when the submission is locked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(visibilityResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps));

    let canEdit = true;
    await act(async () => {
      canEdit = await result.current.recheck();
    });

    expect(canEdit).toBe(false);
    expect(result.current.status).toBe("locked");
    expect(result.current.lookupStatus).toBe("settled");
  });

  it("fails closed when a later visibility refresh fails after a seed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const liveSnapshotRef: { current: SubmissionVisibilitySnapshot | null } = { current: null };
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps, liveSnapshotRef));

    expect(result.current.status).toBe("unlocked");
    expect(result.current.lookupStatus).toBe("settled");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.status).toBe("unknown"));
    expect(result.current.lookupStatus).toBe("error");
    expect(liveSnapshotRef.current).toEqual({
      key: makeSubmissionVisibilityKey({
        participantId: 7,
        answerMode: "owner",
        assistedParticipantId: undefined,
        submissionId: "submission-1",
        revision: 1,
      }),
      status: "unknown",
    });
  });

  it.each([
    ["revision", { revision: 2 }],
    ["scope", { scope: "assisted" as const }],
    ["owner", { ownerParticipantId: 9 }],
    ["target", { participantId: 9 }],
    ["submission", { submissionId: "another-submission" }],
  ])("does not seed when snapshot %s does not match", async (_label, identity) => {
    const fetchMock = vi.fn().mockResolvedValue(visibilityResponse(false));
    vi.stubGlobal("fetch", fetchMock);
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot(identity) } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps));

    expect(result.current.status).toBe("unknown");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toBe("unlocked"));
  });

  it("uses GET-only recovery when the matching snapshot read failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(visibilityResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    const failedSnapshot = {
      status: "failed" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: 7,
        participantId: 7,
        submissionId: "submission-1",
        revision: 1,
      },
      resultsState: null,
      resultsVisible: null,
    };
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: failedSnapshot } as Phase,
    };
    const { result } = renderHook(() => useSubmissionVisibility(hookProps));

    expect(result.current.status).toBe("unknown");
    expect(result.current.lookupStatus).toBe("pending");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toBe("locked"));
    expect(result.current.lookupStatus).toBe("settled");
  });

  it("keeps unknown state for callers that do not pass a synchronous snapshot ref", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(visibilityResponse(true)));
    const initialProps: Parameters<typeof useSubmissionVisibility>[0] = {
      ...props(),
      submissionId: null,
    };
    const { result, rerender } = renderHook(({ hookProps }) => useSubmissionVisibility(hookProps), {
      initialProps: { hookProps: initialProps },
    });

    expect(result.current.status).toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();

    rerender({ hookProps: props() });
    await waitFor(() => expect(result.current.status).toBe("locked"));
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

  it("replaces a same-key live ref with its matching ready seed", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const key = makeSubmissionVisibilityKey({
      participantId: 7,
      answerMode: "owner",
      assistedParticipantId: undefined,
      submissionId: "submission-1",
      revision: 1,
    });
    const liveSnapshotRef: { current: SubmissionVisibilitySnapshot | null } = {
      current: { key, status: "locked" },
    };
    const hookProps = {
      ...props(),
      phase: { kind: "complete", completionSnapshot: readySnapshot() } as Phase,
    };

    renderHook(() => useSubmissionVisibility(hookProps, liveSnapshotRef));

    expect(liveSnapshotRef.current).toEqual({ key, status: "unlocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalidates a same-key live ref when the new completion snapshot is malformed", async () => {
    const fetchResponse = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(fetchResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const key = makeSubmissionVisibilityKey({
      participantId: 7,
      answerMode: "owner",
      assistedParticipantId: undefined,
      submissionId: "submission-1",
      revision: 1,
    });
    const liveSnapshotRef: { current: SubmissionVisibilitySnapshot | null } = {
      current: { key, status: "locked" },
    };
    const failedSnapshot = {
      status: "failed" as const,
      identity: readySnapshot().identity,
      resultsState: null,
      resultsVisible: null,
    };
    const { result } = renderHook(() =>
      useSubmissionVisibility(
        { ...props(), phase: { kind: "complete", completionSnapshot: failedSnapshot } as Phase },
        liveSnapshotRef,
      ),
    );

    expect(liveSnapshotRef.current).toEqual({ key, status: "unknown" });
    expect(result.current.lookupStatus).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fetchResponse.resolve(visibilityResponse(false));
      await fetchResponse.promise;
    });
    expect(liveSnapshotRef.current).toEqual({ key, status: "unlocked" });
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
    const { result } = renderHook(() => useSubmissionVisibility(hookProps, liveSnapshotRef));
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
    await waitFor(() => expect(result.current.lookupStatus).toBe("error"));
  });
});
