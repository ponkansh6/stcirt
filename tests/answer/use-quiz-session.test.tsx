import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useQuizSession } from "@/app/answer/use-quiz-session";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    fetchLatestAnswerSubmission: vi.fn(async () => null),
    fetchAnswerBootstrap: vi.fn(),
  };
});
import { ApiError, fetchAnswerBootstrap, fetchLatestAnswerSubmission } from "@/lib/api/client";

describe("useQuizSession hook", () => {
  const participant = { id: 7, name: "参加者" };
  const assistedParticipant = { id: 8, name: "代理参加者" };
  const question = (id: number) => ({
    id,
    question: `Question ${id}?`,
    choices: ["A", "B", "C", "D"],
    answerType: "selected" as const,
  });
  const batchQuestions = (freeTextFifth = false) =>
    [1, 2, 3, 4, 5].map((id) =>
      id === 5 && freeTextFifth
        ? { ...question(id), choices: [], answerType: "freeText" as const }
        : question(id),
    );
  const submissionId = "00000000-0000-4000-8000-000000000001";
  const restoreIntegrity = (freeTextFifth = false) => ({
    status: "complete" as const,
    questions: [1, 2, 3, 4, 5].map((id) => ({
      id,
      answerType: id === 5 && freeTextFifth ? ("freeText" as const) : ("selected" as const),
      choiceCount: id === 5 && freeTextFifth ? 0 : 4,
    })),
  });
  const failedCompletionSnapshot = (id: string, revision: number) => ({
    status: "failed" as const,
    identity: {
      scope: "owner" as const,
      ownerParticipantId: participant.id,
      participantId: participant.id,
      submissionId: id,
      revision,
    },
    resultsState: null,
    resultsVisible: null,
  });
  const makeBootstrap = (
    mode: "owner" | "assisted" = "owner",
    submission: NonNullable<Awaited<ReturnType<typeof fetchLatestAnswerSubmission>>> | null = null,
    freeTextFifth = false,
  ) =>
    ({
      mode,
      owner: participant,
      participant: mode === "assisted" ? assistedParticipant : participant,
      submission,
      completionSnapshot:
        submission === null
          ? null
          : {
              status: "failed",
              identity: {
                scope: mode,
                ownerParticipantId: participant.id,
                participantId: mode === "assisted" ? assistedParticipant.id : participant.id,
                submissionId: submission.submissionId,
                revision: submission.revision,
              },
              resultsState: null,
              resultsVisible: null,
            },
      ...(submission === null ? { questions: batchQuestions(freeTextFifth) } : {}),
    }) as Awaited<ReturnType<typeof fetchAnswerBootstrap>>;

  beforeEach(() => {
    vi.mocked(fetchLatestAnswerSubmission).mockClear();
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValue(null);
    vi.mocked(fetchAnswerBootstrap).mockReset();
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap());
    window.sessionStorage.clear();
    let uuidSequence = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
    );
  });

  function setupFetch(
    overrides: {
      batch?: (body: Record<string, unknown>) => unknown | Promise<unknown>;
      getSubmission?: () => unknown | Promise<unknown>;
      freeTextFifth?: boolean;
    } = {},
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session") {
        return { ok: true, json: async () => ({ participant }) };
      }
      if (url === "/api/participants/assisted" && !init?.method) {
        return {
          ok: true,
          json: async () => ({
            participant: assistedParticipant,
            hasSubmission: false,
            eligible: false,
          }),
        };
      }
      if (url === "/api/questions/batch") {
        return {
          ok: true,
          json: async () => ({ questions: batchQuestions(overrides.freeTextFifth) }),
        };
      }
      if (url.startsWith("/api/answers/batch") && !init?.method) {
        const result = await overrides.getSubmission?.();
        return { ok: true, json: async () => result };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const rawResult = await overrides.batch?.(body);
        const result =
          rawResult && typeof rawResult === "object"
            ? (rawResult as Record<string, unknown>)
            : { submissionId, revision: 1 };
        const resultSubmissionId =
          typeof result.submissionId === "string" ? result.submissionId : submissionId;
        const resultRevision = typeof result.revision === "number" ? result.revision : 1;
        const scope = url.includes("scope=assisted") ? "assisted" : "owner";
        return {
          ok: true,
          json: async () => ({
            ...result,
            completionSnapshot: result.completionSnapshot ?? {
              status: "failed",
              identity: {
                scope,
                ownerParticipantId: participant.id,
                participantId: scope === "assisted" ? assistedParticipant.id : participant.id,
                submissionId: resultSubmissionId,
                revision: resultRevision,
              },
              resultsState: null,
              resultsVisible: null,
            },
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function start() {
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("ready"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    return hook;
  }

  async function startWithExpiredOwnerSession() {
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(
      new ApiError({ status: 401, message: "Expired", code: null, retryAt: null }),
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      }
      if (url === "/api/participants/session") {
        return { ok: true, json: async () => ({ participant }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));
    return { ...hook, fetchMock };
  }

  async function createAssistedDraft() {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("assisted"));
    const hook = await start();
    act(() => hook.result.current.select(1, 0));
    const raw = window.sessionStorage.getItem("stcirt-assisted-answer-draft");
    expect(raw).not.toBeNull();
    hook.unmount();
    return JSON.parse(raw!) as Record<string, unknown>;
  }

  async function startAssistedReauthWithMismatchedDraft(
    options: {
      bootstrap?: Awaited<ReturnType<typeof fetchAnswerBootstrap>>;
      preserveLocalSubmissionIdentity?: boolean;
    } = {},
  ) {
    const draft = await createAssistedDraft();
    const originalSubmission = {
      submissionId: draft.submissionId as string,
      revision: draft.revision as number,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 0,
        freeText: null,
      })),
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(
      makeBootstrap("assisted", originalSubmission),
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      }
      if (url === "/api/participants/session") {
        return { ok: true, json: async () => ({ participant }) };
      }
      if (url.startsWith("/api/answers/batch") && init?.method === "POST") {
        return { ok: false, status: 401, json: async () => ({ message: "Expired" }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));
    for (const quiz of hook.result.current.quizzes) {
      act(() => hook.result.current.select(quiz.question.id, 1));
    }
    await act(async () => hook.result.current.saveAnswers());
    await waitFor(() => expect(hook.result.current.access.kind).toBe("reauthentication"));

    const persistedDraft = JSON.parse(
      window.sessionStorage.getItem("stcirt-assisted-answer-draft")!,
    ) as Record<string, unknown>;
    const canonicalSubmissionId = options.preserveLocalSubmissionIdentity
      ? (draft.submissionId as string)
      : "00000000-0000-4000-8000-000000000099";
    const canonicalRevision = options.preserveLocalSubmissionIdentity
      ? (draft.revision as number)
      : 3;
    if (!options.preserveLocalSubmissionIdentity) {
      window.sessionStorage.setItem(
        "stcirt-assisted-answer-draft",
        JSON.stringify({
          ...persistedDraft,
          submissionId: canonicalSubmissionId,
          revision: canonicalRevision,
        }),
      );
    }
    const canonicalSubmission = {
      submissionId: canonicalSubmissionId,
      revision: canonicalRevision,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 1,
        freeText: null,
      })),
    };
    const bootstrapCallsBeforeLogin = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(
      options.bootstrap ?? makeBootstrap("assisted", canonicalSubmission),
    );
    return { ...hook, draft, fetchMock, bootstrapCallsBeforeLogin };
  }

  async function startAssistedReauthWithStoredDraft() {
    const draft = await createAssistedDraft();
    const hook = await startWithExpiredOwnerSession();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    return {
      ...hook,
      draft,
      bootstrapCallsBeforeLogin: vi.mocked(fetchAnswerBootstrap).mock.calls.length,
    };
  }

  async function answerAll(result: { current: ReturnType<typeof useQuizSession> }) {
    for (const quiz of result.current.quizzes) {
      act(() => result.current.select(quiz.question.id, 2));
    }
  }

  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries a failed saved-answer edit without rechecking status", async () => {
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(
      makeBootstrap("owner", {
        submissionId,
        revision: 2,
        restoreIntegrity: restoreIntegrity(),
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 1,
          freeText: null,
        })),
      }),
    );
    let attempts = 0;
    const requested: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/questions/batch") {
        attempts += 1;
        requested.push(url);
      }
      if (url === "/api/questions/batch" && attempts === 1) {
        return { ok: false, status: 500, json: async () => ({ message: "temporary failure" }) };
      }
      if (url !== "/api/questions/batch") throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => ({ questions: batchQuestions() }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    await act(async () => hook.result.current.editAnswers(() => true));
    await waitFor(() => expect(hook.result.current.editLoadError).not.toBeNull());
    const bootstrapCallsBeforeRetry = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    const latestCallsBeforeRetry = vi.mocked(fetchLatestAnswerSubmission).mock.calls.length;
    const questionCallsBeforeRetry = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/questions/batch",
    ).length;
    act(() => hook.result.current.retryEdit(() => true));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("answering"));

    expect(requested).toEqual(["/api/questions/batch", "/api/questions/batch"]);
    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCallsBeforeRetry);
    expect(fetchLatestAnswerSubmission).toHaveBeenCalledTimes(latestCallsBeforeRetry);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(
      questionCallsBeforeRetry + 1,
    );
    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
    expect(fetchAnswerBootstrap).toHaveBeenCalledWith("owner");
    expect(fetchLatestAnswerSubmission).toHaveBeenCalledTimes(latestCallsBeforeRetry);
    expect(hook.result.current.quizzes.map(({ question: item }) => item.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("retries questions only after a submission check finds no saved answer", async () => {
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(new Error("temporary bootstrap failure"));
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValueOnce(null);
    let questionAttempts = 0;
    const fetchMock = setupFetch();
    const originalFetch = fetchMock.getMockImplementation();
    if (!originalFetch) throw new Error("Expected fetch mock implementation");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/questions/batch") {
        questionAttempts += 1;
        if (questionAttempts === 1) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ message: "temporary question failure" }),
          };
        }
      }
      return originalFetch(url, init);
    });
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("submission-error"));

    act(() => result.current.retrySubmissionCheck());
    await waitFor(() => expect(result.current.phase.kind).toBe("load-error"));
    const bootstrapCallsBeforeRetry = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    const latestCallsBeforeRetry = vi.mocked(fetchLatestAnswerSubmission).mock.calls.length;
    const questionCallsBeforeRetry = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/questions/batch",
    ).length;

    act(() => result.current.retryLoad());
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCallsBeforeRetry);
    expect(fetchLatestAnswerSubmission).toHaveBeenCalledTimes(latestCallsBeforeRetry);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(
      questionCallsBeforeRetry + 1,
    );
    expect(fetchLatestAnswerSubmission).toHaveBeenCalledWith("owner");
    expect(result.current.quizzes.map(({ question: item }) => item.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("loads five questions, keeps selections local, blocks incomplete submit, then posts one batch", async () => {
    const fetchMock = setupFetch();
    const observedStates: Array<{
      phase: ReturnType<typeof useQuizSession>["phase"];
      saveConfirmed: boolean;
    }> = [];
    const { result } = renderHook(() => {
      const session = useQuizSession();
      useEffect(() => {
        observedStates.push({ phase: session.phase, saveConfirmed: session.saveConfirmed });
      }, [session.phase, session.saveConfirmed]);
      return session;
    });
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(result.current.quizzes.map(({ question: item }) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
    expect(fetchAnswerBootstrap).toHaveBeenCalledWith("owner");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();

    act(() => result.current.select(1, 2));
    act(() => void result.current.saveAnswers());
    expect(result.current.selections[1]).toBe(2);
    expect(result.current.answeredCount).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/answers/batch")).toBe(false);

    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(result.current.saveConfirmed).toBe(true);
    expect(
      observedStates.some(
        ({ phase, saveConfirmed }) => phase.kind === "complete" && !saveConfirmed,
      ),
    ).toBe(false);
    expect(result.current.answeredCount).toBe(5);
    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]?.[1]?.body));
    expect(body).toMatchObject({ submissionId, expectedRevision: 0 });
    expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.answers).toHaveLength(5);
    expect(body.answers.map((answer: { questionId: number }) => answer.questionId)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(body.answers.map((answer: { selectedIndex: number }) => answer.selectedIndex)).toEqual(
      result.current.quizzes.map(({ shuffled }) => shuffled.choiceIndices[2]),
    );
  });

  it("stores a POST completion snapshot atomically with the complete phase", async () => {
    const completionSnapshot = {
      status: "ready" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: participant.id,
        participantId: participant.id,
        submissionId,
        revision: 1,
      },
      resultsState: "waiting" as const,
      resultsVisible: false,
    };
    setupFetch({ batch: () => ({ submissionId, revision: 1, completionSnapshot }) });
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());

    expect(result.current.phase).toEqual({ kind: "complete", completionSnapshot });
  });

  it("seeds only an integrity-checked saved bootstrap phase with its exact snapshot", async () => {
    const savedSubmission = {
      submissionId,
      revision: 3,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 1,
        freeText: null,
      })),
    };
    const completionSnapshot = {
      status: "ready" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: participant.id,
        participantId: participant.id,
        submissionId,
        revision: 3,
      },
      resultsState: "unavailable" as const,
      resultsVisible: true,
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue({
      ...makeBootstrap("owner", savedSubmission),
      completionSnapshot,
    });
    const { result } = renderHook(() => useQuizSession());

    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.phase).toEqual({ kind: "complete", completionSnapshot });
  });

  it("does not seed a saved bootstrap whose restore integrity is invalid", async () => {
    const savedSubmission = {
      submissionId,
      revision: 3,
      restoreIntegrity: { status: "invalid" as const },
      answers: [],
    };
    const completionSnapshot = {
      status: "ready" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: participant.id,
        participantId: participant.id,
        submissionId,
        revision: 3,
      },
      resultsState: "waiting" as const,
      resultsVisible: false,
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue({
      ...makeBootstrap("owner", savedSubmission as never),
      completionSnapshot,
    });
    const { result } = renderHook(() => useQuizSession());

    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.restoreError).toBeTruthy();
    expect(result.current.phase).toEqual({ kind: "complete" });
  });

  it("uses one assisted bootstrap for a direct assisted-mode startup", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("assisted"));
    const { result } = renderHook(() => useQuizSession());

    await waitFor(() => expect(result.current.access.kind).toBe("ready"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
    expect(fetchAnswerBootstrap).toHaveBeenCalledWith("assisted");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.assistedParticipant?.participant).toEqual(assistedParticipant);
    expect(result.current.quizzes.map(({ question: item }) => item.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("uses scoped bootstraps for assisted activation and return to owner", async () => {
    const savedOwnerSubmission = {
      submissionId,
      revision: 1,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 1,
        freeText: null,
      })),
    };
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("owner", savedOwnerSubmission))
      .mockResolvedValueOnce(makeBootstrap("assisted"))
      .mockResolvedValueOnce(makeBootstrap("owner", savedOwnerSubmission));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/participants/assisted" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({ participant: assistedParticipant, hasSubmission: false }),
        };
      if (url === "/api/participants/assisted")
        return {
          ok: true,
          json: async () => ({ participant: assistedParticipant, hasSubmission: false }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    await act(async () => result.current.startAssisted("代理参加者"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.quizzes).toHaveLength(5);

    act(() => result.current.returnToOwner());
    await waitFor(() =>
      expect(result.current).toMatchObject({ answerMode: "owner", phase: { kind: "complete" } }),
    );
    expect(vi.mocked(fetchAnswerBootstrap).mock.calls.map(([mode]) => mode)).toEqual([
      "owner",
      "assisted",
      "owner",
    ]);
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("ignores the stale bootstrap response from StrictMode's first mount", async () => {
    let releaseStale!: (value: Awaited<ReturnType<typeof fetchAnswerBootstrap>>) => void;
    const staleResponse = new Promise<Awaited<ReturnType<typeof fetchAnswerBootstrap>>>(
      (resolve) => {
        releaseStale = resolve;
      },
    );
    vi.mocked(fetchAnswerBootstrap)
      .mockImplementationOnce(() => staleResponse)
      .mockResolvedValueOnce(makeBootstrap());

    const { result } = renderHook(() => useQuizSession(), { reactStrictMode: true });
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(2);

    await act(async () =>
      releaseStale({
        ...makeBootstrap(),
        owner: { id: 99, name: "古い参加者" },
        participant: { id: 99, name: "古い参加者" },
      }),
    );

    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.submissionId).not.toBeNull();
  });

  it("preserves the assisted draft and mode after a bootstrap 403", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("assisted"));
    const firstVisit = await start();
    act(() => firstVisit.result.current.select(1, 0));
    const savedDraft = window.sessionStorage.getItem("stcirt-assisted-answer-draft");
    expect(savedDraft).not.toBeNull();
    firstVisit.unmount();

    vi.mocked(fetchAnswerBootstrap).mockClear();
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(
      new ApiError({ status: 403, message: "Scope denied", code: null, retryAt: null }),
    );
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("submission-error"));

    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
    expect(fetchAnswerBootstrap).toHaveBeenCalledWith("assisted");
    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.answerMode).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(savedDraft);
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/participants/session");
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === "/api/questions/batch" && (!init?.method || init.method === "GET"),
      ),
    ).toBe(false);
  });

  it("discards an expired assisted draft before starting a fresh attempt", async () => {
    const draft = await createAssistedDraft();
    draft.expiresAt = 0;
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("assisted"));
    const { result } = renderHook(() => useQuizSession());

    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.selections).toEqual({});
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(fetchAnswerBootstrap).toHaveBeenLastCalledWith("assisted");
  });

  it("discards an assisted draft owned by a different target", async () => {
    const draft = await createAssistedDraft();
    draft.participantId = assistedParticipant.id + 1;
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(draft));
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("assisted"));
    const { result } = renderHook(() => useQuizSession());

    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.selections).toEqual({});
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
  });

  it.each(["submissionId", "revision"] as const)(
    "returns to owner through bootstrap and discards an assisted draft when its %s is stale",
    async (mismatch) => {
      const draft = await createAssistedDraft();
      const savedSubmissionId =
        mismatch === "submissionId"
          ? `${String(draft.submissionId)}-changed`
          : String(draft.submissionId);
      const savedRevision =
        mismatch === "revision" ? Number(draft.revision) + 1 : Number(draft.revision);
      const submission = {
        submissionId: savedSubmissionId,
        revision: savedRevision,
        restoreIntegrity: restoreIntegrity(),
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 1,
          freeText: null,
        })),
      };
      const requestOrder: string[] = [];
      vi.mocked(fetchAnswerBootstrap)
        .mockClear()
        .mockImplementation(async (mode) => {
          requestOrder.push(`bootstrap:${mode}`);
          return makeBootstrap(mode, mode === "assisted" ? submission : null);
        });
      vi.mocked(fetchLatestAnswerSubmission).mockClear();
      const fetchMock = setupFetch();
      const originalFetch = fetchMock.getMockImplementation();
      if (!originalFetch) throw new Error("Expected fetch mock implementation");
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/questions/batch") requestOrder.push("questions");
        return originalFetch(url, init);
      });
      const { result } = renderHook(() => useQuizSession());

      await waitFor(() =>
        expect(result.current).toMatchObject({ answerMode: "owner", phase: { kind: "answering" } }),
      );

      expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
      expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
      expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(2);
      expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(1, "assisted");
      expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");
      expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
      expect(requestOrder).toEqual(["bootstrap:assisted", "bootstrap:owner"]);
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(
        0,
      );
      expect(result.current.quizzes.map(({ question: item }) => item.question)).toEqual([
        "Question 1?",
        "Question 2?",
        "Question 3?",
        "Question 4?",
        "Question 5?",
      ]);
    },
  );

  it("uses reauthentication after a bootstrap 401 when the participant session still exists", async () => {
    const draft = await createAssistedDraft();
    expect(draft).toMatchObject({ participantId: assistedParticipant.id });
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).not.toBeNull();
    vi.mocked(fetchAnswerBootstrap).mockClear();
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(
      new ApiError({ status: 401, message: "Expired", code: null, retryAt: null }),
    );
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.access.kind).toBe("reauthentication"));

    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(result.current.answerMode).toBe("assisted");
    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
    expect(fetchAnswerBootstrap).toHaveBeenCalledWith("assisted");
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/participants/session");
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/participants/assisted");
  });

  it("locks duplicate submits while a batch request is pending", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const fetchMock = setupFetch({ batch: () => gate });
    const { result } = await start();
    await answerAll(result);
    act(() => {
      void result.current.saveAnswers();
      void result.current.saveAnswers();
    });
    await waitFor(() => expect(result.current.phase.kind).toBe("submitting"));
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    await act(async () => release({ submissionId, revision: 1 }));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
  });

  it("retries an uncertain batch with the same operation ID and exact payload", async () => {
    const attempts: string[] = [];
    let shouldFail = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        const batch = [1, 2, 3, 4, 5].map((id) => question(id));
        return { ok: true, json: async () => ({ questions: batch }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        attempts.push(String(init.body));
        if (shouldFail) {
          shouldFail = false;
          throw new Error("network failure");
        }
        return {
          ok: true,
          json: async () => ({
            submissionId,
            revision: 1,
            completionSnapshot: failedCompletionSnapshot(submissionId, 1),
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("answering");
    expect(result.current.phase).toMatchObject({ retryRequired: true });
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
  });

  it("restores saved answers by choice index, revises the same submission, and recovers a conflict with GET", async () => {
    const fetchMock = setupFetch({
      batch: async (body) => {
        if (body.expectedRevision === 1) return { submissionId, revision: 2 };
        return { submissionId, revision: 1 };
      },
      getSubmission: () => ({
        submissionId,
        revision: 1,
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected",
          selectedIndex: 1,
          freeText: null,
        })),
      }),
    });
    const { result } = await start();
    const firstAttemptId = result.current.submissionId;
    const firstChoice = result.current.quizzes[0]!.shuffled.choiceIndices.indexOf(1);
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");

    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.answeredCount).toBe(5);
    expect(result.current.selections[1]).toBe(2);
    act(() => result.current.select(1, firstChoice));
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
    );
    const firstBody = JSON.parse(String(posts[0]?.[1]?.body));
    const revisedBody = JSON.parse(String(posts[1]?.[1]?.body));
    expect(firstBody.submissionId).toBe(firstAttemptId);
    expect(revisedBody.submissionId).toBe(firstAttemptId);
    expect(revisedBody.expectedRevision).toBe(1);
    expect(revisedBody.answers[0].selectedIndex).toBe(1);

    // Simulate an optimistic concurrency conflict, followed by restoring canonical display indices.
    let conflictSubmissionId = "";
    const conflictFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?"))
        return {
          ok: true,
          json: async () => ({
            submissionId: conflictSubmissionId,
            revision: 3,
            answers: [1, 2, 3, 4, 5].map((questionId) => ({
              questionId,
              answerKind: "selected",
              selectedIndex: 3,
              freeText: null,
            })),
          }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", conflictFetch);
    const conflictHook = await start();
    conflictSubmissionId = conflictHook.result.current.submissionId!;
    await answerAll(conflictHook.result);
    await act(async () => conflictHook.result.current.saveAnswers());
    expect(conflictHook.result.current.phase.kind).toBe("answering");
    expect(conflictHook.result.current.phase).toMatchObject({
      message: expect.stringContaining("保存済み回答"),
    });
    expect(conflictHook.result.current.savedSelections[1]).toBe(
      conflictHook.result.current.quizzes[0]!.shuffled.choiceIndices.indexOf(3),
    );
    expect(
      conflictFetch.mock.calls.some(([url]) =>
        String(url).startsWith("/api/answers/batch?submissionId="),
      ),
    ).toBe(true);
  });

  it("replaces a legacy Q5 answer with new free text when revising a saved submission", async () => {
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(
      makeBootstrap("owner", {
        submissionId,
        revision: 4,
        restoreIntegrity: restoreIntegrity(true),
        answers: [
          ...[1, 2, 3, 4].map((questionId) => ({
            questionId,
            answerKind: "selected" as const,
            selectedIndex: 1,
            freeText: null,
          })),
          {
            questionId: 5,
            answerKind: "legacy" as const,
            selectedIndex: 2,
            freeText: null,
          },
        ],
      }),
    );
    const fetchMock = setupFetch({
      freeTextFifth: true,
      batch: () => ({ submissionId, revision: 5 }),
    });
    const { result } = renderHook(() => useQuizSession());

    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.revision).toBe(4);
    expect(result.current.freeResponses[5]).toBeUndefined();

    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.legacyAnswerIds).toEqual([5]);
    expect(result.current.phase.kind).toBe("answering");
    act(() => result.current.setFreeResponse(5, "新しい自由記載回答"));
    await act(async () => result.current.saveAnswers());

    expect(result.current.phase.kind).toBe("complete");
    expect(result.current.revision).toBe(5);
    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/answers/batch" && init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]?.[1]?.body));
    expect(body).toMatchObject({ submissionId, expectedRevision: 4 });
    expect(body.answers[4]).toEqual({ questionId: 5, freeText: "新しい自由記載回答" });
    expect(body.answers[4]).not.toHaveProperty("selectedIndex");
    expect(body.answers[4]).not.toHaveProperty("answerKind");
  });

  it("locks correction when a successful POST returns a different submission ID", async () => {
    const fetchMock = setupFetch({
      batch: (body) =>
        body.expectedRevision === 0
          ? { submissionId, revision: 1 }
          : { submissionId: "00000000-0000-4000-8000-000000000002", revision: 2 },
    });
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });

    await act(async () => result.current.editAnswers(() => true));
    act(() => result.current.select(1, 0));
    await act(async () => result.current.saveAnswers());

    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
    expect(result.current.saveConfirmed).toBe(false);
    expect(result.current.revision).toBe(1);
    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/answers/batch")).toHaveLength(2);
  });

  it("preserves the correction draft and avoids conflict refresh when the server reports SUBMISSION_LOCKED", async () => {
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(
      makeBootstrap("owner", {
        submissionId,
        revision: 1,
        restoreIntegrity: restoreIntegrity(),
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 1,
          freeText: null,
        })),
      }),
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/assisted")
        return {
          ok: true,
          json: async () => ({
            participant: assistedParticipant,
            hasSubmission: false,
            eligible: false,
          }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch")
        return { ok: true, json: async () => ({ questions: batchQuestions() }) };
      if (url === "/api/answers/batch" && init?.method === "POST")
        return {
          ok: false,
          status: 423,
          json: async () => ({ message: "Submission is published", error: "SUBMISSION_LOCKED" }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    await act(async () => result.current.editAnswers(() => true));
    act(() => result.current.select(1, 3));
    const draft = { ...result.current.selections };
    await act(async () => result.current.saveAnswers());

    expect(result.current.phase).toMatchObject({ kind: "answering", publishedLock: true });
    expect(result.current.selections).toEqual(draft);
    expect(result.current.revision).toBe(1);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/answers/batch?")),
    ).toHaveLength(0);
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
  });

  it("clears the answering-phase published lock after visibility is confirmed hidden", async () => {
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(
      makeBootstrap("owner", {
        submissionId,
        revision: 1,
        restoreIntegrity: restoreIntegrity(),
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 1,
          freeText: null,
        })),
      }),
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/assisted")
        return {
          ok: true,
          json: async () => ({
            participant: assistedParticipant,
            hasSubmission: false,
            eligible: false,
          }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch")
        return { ok: true, json: async () => ({ questions: batchQuestions() }) };
      if (url === "/api/answers/batch" && init?.method === "POST")
        return {
          ok: false,
          status: 423,
          json: async () => ({ message: "Submission is published", error: "SUBMISSION_LOCKED" }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    await act(async () => result.current.editAnswers(() => true));
    act(() => result.current.select(1, 3));
    const draft = { ...result.current.selections };
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({ kind: "answering", publishedLock: true });
    expect(result.current.selections).toEqual(draft);

    act(() => result.current.clearPublishedLock());

    expect(result.current.phase).toEqual({ kind: "answering" });
    expect(result.current.selections).toEqual(draft);
  });

  it("leaves an unlocked answering phase unchanged when clearing a published lock", async () => {
    setupFetch();
    const { result } = await start();

    act(() => result.current.clearPublishedLock());

    expect(result.current.phase).toEqual({ kind: "answering" });
  });

  it("shows login after session lookup failure and keeps login errors visible", async () => {
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(
      new ApiError({ status: 401, message: "Session unavailable", code: null, retryAt: null }),
    );
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: "名前またはPINが違います" }),
        };
      throw new Error("session unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.access.kind).toBe("login"));
    expect(result.current.access).toMatchObject({
      message: "参加状態を確認できませんでした。通信状態を確認してから再読み込みしてください。",
    });
    await act(async () => {
      await expect(result.current.login("参加者", "0000")).rejects.toThrow(
        "名前またはPINが違います",
      );
    });
    expect(result.current.access).toMatchObject({
      kind: "login",
      message: "名前またはPINが違います",
    });
  });

  it("does not turn a failed bootstrap into a new attempt", async () => {
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(new Error("invalid bootstrap"));
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("submission-error"));
    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.quizzes).toEqual([]);
    expect(result.current.submissionId).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicitly rejected draft editable and gives changed answers a new retry operation", async () => {
    const attempts: Array<Record<string, unknown>> = [];
    let rejectFirst = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        attempts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (rejectFirst) {
          rejectFirst = false;
          return {
            ok: false,
            status: 400,
            json: async () => ({ message: "回答を確認してください" }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            submissionId,
            revision: 1,
            completionSnapshot: failedCompletionSnapshot(submissionId, 1),
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({
      kind: "answering",
      message: "回答を確認してください",
      retryRequired: false,
    });
    expect(result.current.answeredCount).toBe(5);
    act(() => result.current.select(1, 1));
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.operationId).not.toBe(attempts[1]?.operationId);
  });

  it("retains Q5 free text and resends the same operation after same-participant reauthentication", async () => {
    const attempts: Record<string, unknown>[] = [];
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("owner", null, true));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(true) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        attempts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (attempts.length > 1)
          return {
            ok: true,
            json: async () => ({
              submissionId,
              revision: 1,
              completionSnapshot: failedCompletionSnapshot(submissionId, 1),
            }),
          };
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: "ログイン期限が切れました" }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      act(() => result.current.select(quiz.question.id, 2));
    }
    act(() => result.current.setFreeResponse(5, "  監査済みの端末を利用します。  "));
    await act(async () => result.current.saveAnswers());
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    expect(result.current.answeredCount).toBe(5);
    expect(result.current.freeResponses[5]).toBe("  監査済みの端末を利用します。  ");

    const latestCallsBeforeLogin = vi.mocked(fetchLatestAnswerSubmission).mock.calls.length;
    await act(async () => result.current.login("参加者", "1234"));
    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    expect(result.current.answeredCount).toBe(5);
    expect(result.current.freeResponses[5]).toBe("  監査済みの端末を利用します。  ");
    expect(vi.mocked(fetchLatestAnswerSubmission)).toHaveBeenCalledTimes(latestCallsBeforeLogin);
    expect(attempts).toHaveLength(1);

    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId);
    expect(attempts[1]?.answers).toEqual(attempts[0]?.answers);
    expect(attempts[1]?.answers).toContainEqual({
      questionId: 5,
      freeText: "監査済みの端末を利用します。",
    });
  });

  it("preserves mixed local drafts when reauthentication rechecks a changed saved revision", async () => {
    const posts: Record<string, unknown>[] = [];
    let canonicalAnswers: {
      questionId: number;
      answerKind: "selected" | "freeText";
      selectedIndex: number | null;
      freeText: string | null;
    }[] = [];
    const canonicalRevision = 7;
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("owner", null, true))
      .mockImplementationOnce(async () =>
        makeBootstrap("owner", {
          submissionId,
          revision: canonicalRevision,
          restoreIntegrity: restoreIntegrity(true),
          answers: canonicalAnswers,
        }),
      );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch")
        return { ok: true, json: async () => ({ questions: batchQuestions(true) }) };
      if (url === "/api/answers/batch" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return posts.length === 1
          ? { ok: false, status: 401, json: async () => ({ message: "expired" }) }
          : {
              ok: true,
              json: async () => ({
                submissionId,
                revision: canonicalRevision + 1,
                completionSnapshot: failedCompletionSnapshot(submissionId, canonicalRevision + 1),
              }),
            };
      }
      if (url.startsWith("/api/answers/batch?"))
        return {
          ok: true,
          json: async () => ({
            submissionId,
            revision: canonicalRevision,
            answers: canonicalAnswers,
          }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await start();
    const localSelections: Record<number, number> = {};
    canonicalAnswers = result.current.quizzes
      .filter(({ question: item }) => item.answerType === "selected")
      .map(({ question: item, shuffled }) => {
        const localIndex = item.id % 4;
        localSelections[item.id] = localIndex;
        return {
          questionId: item.id,
          answerKind: "selected" as const,
          selectedIndex: shuffled.choiceIndices[(localIndex + 1) % 4]!,
          freeText: null,
        };
      });
    canonicalAnswers.push({
      questionId: 5,
      answerKind: "freeText",
      selectedIndex: null,
      freeText: "別タブで保存された回答",
    });
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      act(() => result.current.select(quiz.question.id, localSelections[quiz.question.id]!));
    }
    const localFreeResponse = "この端末で編集中の回答";
    act(() => result.current.setFreeResponse(5, localFreeResponse));

    await act(async () => result.current.saveAnswers());
    expect(result.current.access.kind).toBe("reauthentication");
    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() =>
      expect(result.current.phase).toMatchObject({
        kind: "answering",
        refreshRequired: true,
      }),
    );
    expect(result.current.revision).toBe(canonicalRevision);

    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.selections).toEqual(localSelections);
    expect(result.current.freeResponses[5]).toBe(localFreeResponse);
    expect(result.current.savedSelections).toEqual(
      Object.fromEntries(
        result.current.quizzes
          .filter(({ question: item }) => item.answerType === "selected")
          .map(({ question: item, shuffled }) => [
            item.id,
            shuffled.choiceIndices.indexOf(
              canonicalAnswers.find((answer) => answer.questionId === item.id)!.selectedIndex!,
            ),
          ]),
      ),
    );
    expect(result.current.answeredCount).toBe(5);
    expect(posts).toHaveLength(1);

    await act(async () => result.current.saveAnswers());
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ expectedRevision: canonicalRevision });
    expect(posts[1]?.answers).toContainEqual({ questionId: 5, freeText: localFreeResponse });
    expect(result.current.phase.kind).toBe("complete");
  });

  it("refreshes a saved correction after 401 and retries it explicitly at the latest revision", async () => {
    const canonicalAnswers = [1, 2, 3, 4, 5].map((questionId) =>
      questionId === 5
        ? {
            questionId,
            answerKind: "freeText" as const,
            selectedIndex: null,
            freeText: "保存済みの自由記述",
          }
        : {
            questionId,
            answerKind: "selected" as const,
            selectedIndex: 1,
            freeText: null,
          },
    );
    const initialSubmission = {
      submissionId,
      revision: 2,
      answers: canonicalAnswers,
      restoreIntegrity: restoreIntegrity(true),
    };
    const latestSubmission = {
      submissionId,
      revision: 4,
      answers: canonicalAnswers,
      restoreIntegrity: restoreIntegrity(true),
    };
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("owner", initialSubmission))
      .mockResolvedValueOnce(makeBootstrap("owner", latestSubmission));
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/assisted")
        return {
          ok: true,
          json: async () => ({
            participant: assistedParticipant,
            hasSubmission: false,
            eligible: false,
          }),
        };
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch")
        return { ok: true, json: async () => ({ questions: batchQuestions(true) }) };
      if (url === "/api/answers/batch" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return posts.length === 1
          ? { ok: false, status: 401, json: async () => ({ message: "expired" }) }
          : {
              ok: true,
              json: async () => ({
                submissionId,
                revision: 5,
                completionSnapshot: failedCompletionSnapshot(submissionId, 5),
              }),
            };
      }
      if (url.startsWith("/api/answers/batch?"))
        return {
          ok: true,
          json: async () => ({ submissionId, revision: 4, answers: canonicalAnswers }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.revision).toBe(2);
    await act(async () => result.current.editAnswers(() => true));
    act(() => result.current.select(1, 3));
    const localFreeResponse = "  修正した自由記述  ";
    act(() => result.current.setFreeResponse(5, localFreeResponse));
    expect(result.current.selections[1]).toBe(3);
    expect(result.current.freeResponses[5]).toBe(localFreeResponse);
    const correctionDraft = { ...result.current.selections };
    const expectedAnswers = result.current.quizzes.map(({ question, shuffled }) =>
      question.answerType === "freeText"
        ? { questionId: question.id, freeText: localFreeResponse.trim() }
        : {
            questionId: question.id,
            selectedIndex: shuffled.choiceIndices[correctionDraft[question.id]!],
          },
    );

    await act(async () => result.current.saveAnswers());
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(result.current.selections).toEqual(correctionDraft);
    expect(result.current.freeResponses[5]).toBe(localFreeResponse);
    expect(result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    expect(posts).toHaveLength(1);

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase).toMatchObject({ refreshRequired: true }));
    expect(result.current.revision).toBe(4);
    expect(result.current.selections).toEqual(correctionDraft);
    expect(result.current.freeResponses[5]).toBe(localFreeResponse);
    expect(posts).toHaveLength(1);

    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.revision).toBe(4);
    expect(result.current.savedSelections[1]).toBe(
      result.current.quizzes[0]!.shuffled.choiceIndices.indexOf(1),
    );
    expect(result.current.selections).toEqual(correctionDraft);
    expect(result.current.freeResponses[5]).toBe(localFreeResponse);
    expect(posts).toHaveLength(1);

    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.submissionId).toBe(submissionId);
    expect(posts[0]?.expectedRevision).toBe(2);
    const retryOperationId = posts[1]?.operationId;
    expect(retryOperationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(posts[1]).toEqual({
      submissionId,
      operationId: retryOperationId,
      expectedRevision: 4,
      answers: expectedAnswers,
    });
  });

  it("clears reauthentication draft preservation when the saved submission changes", async () => {
    const changedSubmissionId = "00000000-0000-4000-8000-000000000002";
    const canonicalAnswers: {
      questionId: number;
      answerKind: "selected" | "freeText";
      selectedIndex: number | null;
      freeText: string | null;
    }[] = [];
    let latestAfterIdChange: Awaited<ReturnType<typeof fetchLatestAnswerSubmission>> = null;
    const originalAnswers = [1, 2, 3, 4, 5].map((questionId) =>
      questionId === 5
        ? {
            questionId,
            answerKind: "freeText" as const,
            selectedIndex: null,
            freeText: "元の保存済み回答",
          }
        : {
            questionId,
            answerKind: "selected" as const,
            selectedIndex: 0,
            freeText: null,
          },
    );
    const posts: Record<string, unknown>[] = [];
    let savedAnswerRead = 0;
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("owner", null, true))
      .mockResolvedValueOnce(
        makeBootstrap("owner", {
          submissionId,
          revision: 2,
          answers: originalAnswers,
          restoreIntegrity: restoreIntegrity(true),
        }),
      )
      .mockImplementationOnce(async () => makeBootstrap("owner", latestAfterIdChange));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch")
        return { ok: true, json: async () => ({ questions: batchQuestions(true) }) };
      if (url === "/api/answers/batch" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (posts.length === 1)
          return { ok: false, status: 401, json: async () => ({ message: "expired" }) };
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      }
      if (url.startsWith("/api/answers/batch?")) {
        savedAnswerRead += 1;
        if (savedAnswerRead === 1)
          return { ok: false, status: 401, json: async () => ({ message: "expired" }) };
        if (savedAnswerRead === 2)
          return { ok: false, status: 503, json: async () => ({ message: "temporary failure" }) };
        return {
          ok: true,
          json: async () => ({
            submissionId: changedSubmissionId,
            revision: 4,
            answers: canonicalAnswers.map((answer) =>
              answer.questionId === 5 ? { ...answer, freeText: "最新の保存済み回答" } : answer,
            ),
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await start();
    canonicalAnswers.push(
      ...result.current.quizzes.map(({ question: item, shuffled }) =>
        item.answerType === "freeText"
          ? {
              questionId: item.id,
              answerKind: "freeText" as const,
              selectedIndex: null,
              freeText: "回答を保存しました",
            }
          : {
              questionId: item.id,
              answerKind: "selected" as const,
              selectedIndex: shuffled.choiceIndices[0]!,
              freeText: null,
            },
      ),
    );
    latestAfterIdChange = {
      submissionId: changedSubmissionId,
      revision: 3,
      answers: canonicalAnswers,
      restoreIntegrity: restoreIntegrity(true),
    };
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      act(() => result.current.select(quiz.question.id, 1));
    }
    act(() => result.current.setFreeResponse(5, "この端末の未保存案"));
    await act(async () => result.current.saveAnswers());
    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase).toMatchObject({ refreshRequired: true }));

    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.access.kind).toBe("reauthentication");
    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.submissionId).toBe(changedSubmissionId);
    expect(result.current.freeResponses[5]).toBeUndefined();

    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.freeResponses[5]).toBe("回答を保存しました");
    act(() => result.current.setFreeResponse(5, "別の未保存案"));
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({ refreshRequired: true });
    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.freeResponses[5]).toBe("最新の保存済み回答");
    expect(result.current.revision).toBe(4);
  });

  it("clears the previous participant draft when reauthentication succeeds as another participant", async () => {
    const otherParticipant = { id: 8, name: "別の参加者" };
    const attempts: Record<string, unknown>[] = [];
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("owner"))
      .mockResolvedValueOnce({
        ...makeBootstrap("owner"),
        owner: otherParticipant,
        participant: otherParticipant,
      });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: true,
          json: async () => ({
            participant: otherParticipant,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        attempts.push(request);
        return attempts.length === 1
          ? { ok: false, status: 401, json: async () => ({ message: "expired" }) }
          : {
              ok: true,
              json: async () => ({
                submissionId: request.submissionId,
                revision: 1,
                completionSnapshot: failedCompletionSnapshot(String(request.submissionId), 1),
              }),
            };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    const previousSubmissionId = result.current.submissionId;
    await act(async () => result.current.saveAnswers());
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });

    await act(async () => result.current.login("別の参加者", "5678"));
    await waitFor(() =>
      expect(result.current.access).toEqual({ kind: "ready", participant: otherParticipant }),
    );
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(result.current.selections).toEqual({});
    expect(result.current.answeredCount).toBe(0);
    expect(result.current.submissionId).not.toBe(previousSubmissionId);
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(2, "owner");
    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(2);
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();

    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.operationId).not.toBe(attempts[0]?.operationId);
  });

  it("retains a draft when conflict refresh fails, then refreshes saved answers on request", async () => {
    let getFails = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?")) {
        if (getFails) {
          getFails = false;
          return {
            ok: false,
            status: 503,
            json: async () => ({ message: "一時的に確認できません" }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            submissionId,
            revision: 4,
            answers: [1, 2, 3, 4, 5].map((questionId) => ({
              questionId,
              answerKind: "selected",
              selectedIndex: 0,
              freeText: null,
            })),
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });
    expect(result.current.answeredCount).toBe(5);
    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.phase).toMatchObject({
      kind: "answering",
      message: expect.stringContaining("編集中の回答案は保持されています"),
    });
    expect(result.current.phase).not.toHaveProperty("refreshRequired");
    expect(result.current.revision).toBe(4);
    expect(result.current.answeredCount).toBe(5);
  });

  it("preserves the local Q5 draft through conflict recovery and explicitly submits it at the canonical revision", async () => {
    type PersistedAnswer = {
      questionId: number;
      answerKind: "selected" | "freeText";
      selectedIndex: number | null;
      freeText: string | null;
    };
    type SubmittedAnswer = { questionId: number; selectedIndex?: number; freeText?: string };
    type SubmittedBatch = {
      submissionId: string;
      operationId: string;
      expectedRevision: number;
      answers: SubmittedAnswer[];
    };

    const posts: SubmittedBatch[] = [];
    let currentSubmissionId = "";
    let canonicalAnswers: PersistedAnswer[] = [];
    const canonicalRevision = 7;
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("owner", null, true));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(true) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as SubmittedBatch;
        posts.push(body);
        if (posts.length === 1) {
          currentSubmissionId = body.submissionId;
          return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
        }
        return {
          ok: true,
          json: async () => ({
            submissionId: body.submissionId,
            revision: 8,
            completionSnapshot: failedCompletionSnapshot(body.submissionId, 8),
          }),
        };
      }
      if (url.startsWith("/api/answers/batch?")) {
        return {
          ok: true,
          json: async () => ({
            submissionId: currentSubmissionId,
            revision: canonicalRevision,
            answers: canonicalAnswers,
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await start();
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      act(() => result.current.select(quiz.question.id, quiz.question.id % 4));
    }
    const localSelections = { ...result.current.selections };
    const localFreeResponse = "Bタブの未保存案";
    act(() => result.current.setFreeResponse(5, localFreeResponse));
    expect(result.current.answeredCount).toBe(5);

    const canonicalSelections: Record<number, number> = {};
    canonicalAnswers = result.current.quizzes
      .filter(({ question: item }) => item.answerType === "selected")
      .map(({ question: item, shuffled }) => {
        const localIndex = localSelections[item.id]!;
        const savedIndex = (localIndex + 1) % shuffled.choiceIndices.length;
        const selectedIndex = shuffled.choiceIndices[savedIndex]!;
        canonicalSelections[item.id] = savedIndex;
        return {
          questionId: item.id,
          answerKind: "selected" as const,
          selectedIndex,
          freeText: null,
        };
      });
    canonicalAnswers.push({
      questionId: 5,
      answerKind: "freeText",
      selectedIndex: null,
      freeText: "別タブで保存されたQ5回答",
    });

    await act(async () => result.current.saveAnswers());

    expect(result.current.phase).toMatchObject({
      kind: "answering",
      message: expect.stringContaining("保存済み回答が更新されています"),
    });
    expect(result.current.selections).toEqual(localSelections);
    expect(result.current.freeResponses[5]).toBe(localFreeResponse);
    expect(result.current.savedSelections).toEqual(canonicalSelections);
    expect(result.current.revision).toBe(canonicalRevision);
    expect(result.current.answeredCount).toBe(5);
    expect(posts).toHaveLength(1);

    await act(async () => result.current.saveAnswers());

    expect(result.current.phase.kind).toBe("complete");
    expect(result.current.revision).toBe(8);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.submissionId).toBe(currentSubmissionId);
    expect(posts[1]?.expectedRevision).toBe(canonicalRevision);
    expect(posts[1]?.operationId).not.toBe(posts[0]?.operationId);
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      expect(posts[1]?.answers).toContainEqual({
        questionId: quiz.question.id,
        selectedIndex: quiz.shuffled.choiceIndices[localSelections[quiz.question.id]!],
      });
    }
    expect(posts[1]?.answers).toContainEqual({
      questionId: 5,
      freeText: localFreeResponse,
    });
  });

  it("clears participant data after switching and restores access if session deletion fails", async () => {
    let deletionFails = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        if (deletionFails) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true };
      }
      if (_url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (_url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      throw new Error(`Unexpected request: ${_url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    deletionFails = true;
    await act(async () => {
      await expect(result.current.switchParticipant()).rejects.toThrow();
    });
    expect(result.current.access).toEqual({ kind: "ready", participant });
    deletionFails = false;
    await act(async () => result.current.switchParticipant());
    expect(result.current.access).toEqual({ kind: "login" });
    expect(result.current.phase).toEqual({ kind: "ready" });
    expect(result.current.quizzes).toEqual([]);
    expect(result.current.selections).toEqual({});
    expect(result.current.submissionId).toBeNull();
  });

  it("ignores actions that do not match the current session phase", async () => {
    vi.mocked(fetchLatestAnswerSubmission).mockReset().mockResolvedValue(null);
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    act(() => {
      result.current.select(1, 0);
      void result.current.saveAnswers();
      void result.current.refreshSavedAnswers();
      void result.current.editAnswers(() => true);
      result.current.retryLoad();
      void result.current.switchParticipant();
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/questions/batch")).toBe(
      false,
    );
    await waitFor(() => expect(result.current.access.kind).toBe("ready"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    await waitFor(() => expect(result.current.quizzes).toHaveLength(5));
    const initialPhase = result.current.phase;
    const initialSelections = result.current.selections;
    act(() => {
      void result.current.saveAnswers();
      void result.current.refreshSavedAnswers();
      void result.current.editAnswers(() => true);
      result.current.retryLoad();
    });
    expect(result.current.phase).toEqual(initialPhase);
    expect(result.current.selections).toEqual(initialSelections);
  });

  it("blocks selection while a submit is pending", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    setupFetch({ batch: () => gate });
    const { result } = await start();
    await answerAll(result);
    await act(async () => {
      const saving = result.current.saveAnswers();
      result.current.select(1, 3);
      expect(result.current.selections[1]).toBe(2);
      release({ submissionId, revision: 1 });
      await saving;
    });
    expect(result.current.phase.kind).toBe("complete");
  });

  it("keeps completion unconfirmed when conflict recovery returns invalid saved answers", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?"))
        return {
          ok: true,
          json: async () => ({
            submissionId,
            revision: 2,
            answers: [],
          }),
        };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toEqual({ kind: "complete" });
    expect(result.current.restoreError).toBeTruthy();
    expect(result.current.saveConfirmed).toBe(false);
    expect(result.current.answeredCount).toBe(5);
    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.phase).toEqual({ kind: "complete" });
  });

  it("requires reauthentication when conflict recovery and manual refresh return 401", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST")
        return {
          ok: false,
          status: 401,
          json: async () => ({
            message: "認証が必要です",
            participant,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        };
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 409, json: async () => ({ message: "conflict" }) };
      if (url.startsWith("/api/answers/batch?"))
        return { ok: false, status: 401, json: async () => ({ message: "認証が必要です" }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });
    await act(async () => result.current.refreshSavedAnswers());
    expect(result.current.phase).toMatchObject({ kind: "answering", refreshRequired: true });
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    await act(async () => {
      await expect(result.current.login("参加者", "1234")).rejects.toThrow("認証が必要です");
    });
    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
  });

  it("starts a session after login and does not replace reauthentication with a failed login state", async () => {
    let sessionExists = false;
    let loginFails = false;
    const postLoginQuestions = batchQuestions().map((item) => ({
      ...item,
      question: `Post-login question ${item.id}?`,
    }));
    vi.mocked(fetchAnswerBootstrap)
      .mockRejectedValueOnce(
        new ApiError({ status: 401, message: "Expired", code: null, retryAt: null }),
      )
      .mockResolvedValueOnce({
        ...makeBootstrap("owner"),
        questions: postLoginQuestions,
      });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST") {
        if (loginFails)
          return { ok: false, status: 401, json: async () => ({ message: "PIN error" }) };
        sessionExists = true;
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      }
      if (url === "/api/participants/session")
        return {
          ok: true,
          json: async () => ({ participant: sessionExists ? participant : null }),
        };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(false) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST")
        return { ok: false, status: 401, json: async () => ({ message: "expired" }) };
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.access.kind).toBe("login"));
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(1, "owner");
    const bootstrapCallsBeforeLogin = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    await act(async () => result.current.login("参加者", "1234"));
    expect(result.current.access).toEqual({ kind: "ready", participant });
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(vi.mocked(fetchAnswerBootstrap).mock.calls.length - bootstrapCallsBeforeLogin).toBe(1);
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "owner");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === "/api/questions/batch" && (!init?.method || init.method === "GET"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === "/api/answers/latest" && (!init?.method || init.method === "GET"),
      ),
    ).toBe(false);
    expect(
      result.current.quizzes.map(({ question: item }) => ({
        id: item.id,
        question: item.question,
      })),
    ).toEqual(postLoginQuestions.map(({ id, question }) => ({ id, question })));
    await answerAll(result);
    await act(async () => result.current.saveAnswers());
    expect(result.current.access.kind).toBe("reauthentication");
    loginFails = true;
    await act(async () => {
      await expect(result.current.login("参加者", "0000")).rejects.toThrow("PIN error");
    });
    expect(result.current.access.kind).toBe("reauthentication");
  });

  it("falls back to owner bootstrap after assisted login bootstrap returns 404", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    const { result, fetchMock } = await startWithExpiredOwnerSession();
    const bootstrapCallsBeforeLogin = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    const savedSubmission = {
      submissionId,
      revision: 2,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 0,
        freeText: null,
      })),
    };
    const completionSnapshot = {
      status: "ready" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: participant.id,
        participantId: participant.id,
        submissionId,
        revision: 2,
      },
      resultsState: "waiting" as const,
      resultsVisible: false,
    };
    vi.mocked(fetchAnswerBootstrap)
      .mockRejectedValueOnce(
        new ApiError({ status: 404, message: "Missing", code: null, retryAt: null }),
      )
      .mockResolvedValueOnce({
        ...makeBootstrap("owner", savedSubmission),
        completionSnapshot,
      });

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.answerMode).toBe("owner");
    expect(result.current.phase).toEqual({ kind: "complete", completionSnapshot });
    expect(result.current.submissionId).toBe(submissionId);
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 2, "owner");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("ignores a successful assisted login bootstrap after unmount", async () => {
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    const { result, unmount } = await startWithExpiredOwnerSession();
    const bootstrapCallsBeforeLogin = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    let resolveBootstrap!: (bootstrap: Awaited<ReturnType<typeof fetchAnswerBootstrap>>) => void;
    const pendingBootstrap = new Promise<Awaited<ReturnType<typeof fetchAnswerBootstrap>>>(
      (resolve) => {
        resolveBootstrap = resolve;
      },
    );
    vi.mocked(fetchAnswerBootstrap).mockReturnValueOnce(pendingBootstrap);
    let loginPromise!: Promise<number>;
    act(() => {
      loginPromise = result.current.login("参加者", "1234");
    });
    await waitFor(() =>
      expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCallsBeforeLogin + 1),
    );
    expect(fetchAnswerBootstrap).toHaveBeenLastCalledWith("assisted");
    const accessBeforeUnmount = result.current.access;
    const phaseBeforeUnmount = result.current.phase;
    unmount();
    resolveBootstrap(makeBootstrap("assisted"));

    await act(async () => {
      await expect(loginPromise).resolves.toBe(participant.id);
    });

    expect(result.current.access).toEqual(accessBeforeUnmount);
    expect(result.current.phase).toEqual(phaseBeforeUnmount);
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
  });

  it("ignores a successful assisted login owner fallback after unmount", async () => {
    const staleDraft = await createAssistedDraft();
    const { result, unmount, fetchMock } = await startWithExpiredOwnerSession();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(staleDraft));
    const bootstrapCallsBeforeLogin = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    const savedSubmission = {
      submissionId,
      revision: 2,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 0,
        freeText: null,
      })),
    };
    let resolveBootstrap!: (bootstrap: Awaited<ReturnType<typeof fetchAnswerBootstrap>>) => void;
    const pendingOwnerBootstrap = new Promise<Awaited<ReturnType<typeof fetchAnswerBootstrap>>>(
      (resolve) => {
        resolveBootstrap = resolve;
      },
    );
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("assisted", savedSubmission))
      .mockReturnValueOnce(pendingOwnerBootstrap);
    let loginPromise!: Promise<number>;
    act(() => {
      loginPromise = result.current.login("参加者", "1234");
    });
    await waitFor(() =>
      expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCallsBeforeLogin + 2),
    );
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 2, "owner");
    const accessBeforeUnmount = result.current.access;
    const phaseBeforeUnmount = result.current.phase;
    unmount();
    resolveBootstrap(makeBootstrap("owner"));

    await act(async () => {
      await expect(loginPromise).resolves.toBe(participant.id);
    });

    expect(result.current.access).toEqual(accessBeforeUnmount);
    expect(result.current.phase).toEqual(phaseBeforeUnmount);
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("blocks restoration after login when a saved submission lacks restore integrity", async () => {
    const { result } = await startWithExpiredOwnerSession();
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(
      makeBootstrap("owner", {
        submissionId,
        revision: 2,
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 0,
          freeText: null,
        })),
      }),
    );

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.restoreError).toContain("整合性を確認できません");
    expect(result.current.saveConfirmed).toBe(false);
  });

  it("seeds a valid saved bootstrap fetched during reauthentication", async () => {
    const { result } = await startWithExpiredOwnerSession();
    const savedSubmission = {
      submissionId,
      revision: 2,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 0,
        freeText: null,
      })),
    };
    const completionSnapshot = {
      status: "ready" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: participant.id,
        participantId: participant.id,
        submissionId,
        revision: 2,
      },
      resultsState: "waiting" as const,
      resultsVisible: false,
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce({
      ...makeBootstrap("owner", savedSubmission),
      completionSnapshot,
    });

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.phase).toEqual({ kind: "complete", completionSnapshot });
    expect(result.current.revision).toBe(2);
  });

  it("keeps reauthentication after the post-login bootstrap returns 401", async () => {
    const { result } = await startWithExpiredOwnerSession();
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(
      new ApiError({ status: 401, message: "Expired again", code: null, retryAt: null }),
    );

    await act(async () => result.current.login("参加者", "1234"));

    expect(result.current.access).toEqual({ kind: "reauthentication", participant });
    expect(result.current.phase.kind).toBe("ready");
  });

  it.each([
    ["HTTP 403", new ApiError({ status: 403, message: "Forbidden", code: null, retryAt: null })],
    ["a network error", new Error("offline")],
  ])("shows a retryable error when the post-login bootstrap returns %s", async (_label, error) => {
    const { result } = await startWithExpiredOwnerSession();
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(error);

    await act(async () => result.current.login("参加者", "1234"));

    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.phase).toMatchObject({
      kind: "submission-error",
      message: expect.stringContaining("通信状態"),
    });
  });

  it("falls back to owner after login when the assisted saved submission has no matching draft", async () => {
    const staleDraft = await createAssistedDraft();
    const { result, fetchMock } = await startWithExpiredOwnerSession();
    window.sessionStorage.setItem("stcirt-answer-scope", "assisted");
    window.sessionStorage.setItem("stcirt-assisted-answer-draft", JSON.stringify(staleDraft));
    const bootstrapCallsBeforeLogin = vi.mocked(fetchAnswerBootstrap).mock.calls.length;
    const savedSubmission = {
      submissionId,
      revision: 2,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 1,
        freeText: null,
      })),
    };
    const ownerSubmission = {
      ...savedSubmission,
      revision: 3,
    };
    const ownerCompletionSnapshot = {
      status: "ready" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: participant.id,
        participantId: participant.id,
        submissionId,
        revision: 3,
      },
      resultsState: "unavailable" as const,
      resultsVisible: true,
    };
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("assisted", savedSubmission))
      .mockResolvedValueOnce({
        ...makeBootstrap("owner", ownerSubmission),
        completionSnapshot: ownerCompletionSnapshot,
      });

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.answerMode).toBe("owner");
    expect(result.current.assistedScreen).toBe("closed");
    expect(result.current.phase).toEqual({
      kind: "complete",
      completionSnapshot: ownerCompletionSnapshot,
    });
    expect(result.current.submissionId).toBe(submissionId);
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 2, "owner");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("falls back to owner after reauthentication when the saved assisted ID differs from the local correction", async () => {
    const draft = await createAssistedDraft();
    const draftSubmissionId = draft.submissionId as string;
    const draftRevision = draft.revision as number;
    const initiallySavedSubmission = {
      submissionId: draftSubmissionId,
      revision: draftRevision,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 0,
        freeText: null,
      })),
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(
      makeBootstrap("assisted", initiallySavedSubmission),
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ participant, expiresAt: "2030-01-01T00:00:00.000Z" }),
        };
      }
      if (url === "/api/participants/session") {
        return { ok: true, json: async () => ({ participant }) };
      }
      if (url.startsWith("/api/answers/batch") && init?.method === "POST") {
        return { ok: false, status: 401, json: async () => ({ message: "Expired" }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    for (const quiz of result.current.quizzes) {
      act(() => result.current.select(quiz.question.id, 1));
    }
    await act(async () => result.current.saveAnswers());
    expect(result.current.access.kind).toBe("reauthentication");
    const bootstrapCallsBeforeLogin = vi.mocked(fetchAnswerBootstrap).mock.calls.length;

    const persistedDraft = JSON.parse(
      window.sessionStorage.getItem("stcirt-assisted-answer-draft")!,
    ) as Record<string, unknown>;
    const canonicalSubmissionId = "00000000-0000-4000-8000-000000000099";
    const canonicalRevision = 3;
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify({
        ...persistedDraft,
        submissionId: canonicalSubmissionId,
        revision: canonicalRevision,
      }),
    );
    const canonicalSubmission = {
      submissionId: canonicalSubmissionId,
      revision: canonicalRevision,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 1,
        freeText: null,
      })),
    };
    const ownerSubmission = {
      submissionId,
      revision: 4,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 2,
        freeText: null,
      })),
    };
    const ownerCompletionSnapshot = {
      status: "ready" as const,
      identity: {
        scope: "owner" as const,
        ownerParticipantId: participant.id,
        participantId: participant.id,
        submissionId,
        revision: 4,
      },
      resultsState: "waiting" as const,
      resultsVisible: false,
    };
    vi.mocked(fetchAnswerBootstrap)
      .mockResolvedValueOnce(makeBootstrap("assisted", canonicalSubmission))
      .mockResolvedValueOnce({
        ...makeBootstrap("owner", ownerSubmission),
        completionSnapshot: ownerCompletionSnapshot,
      });

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.answerMode).toBe("owner");
    expect(result.current.phase).toEqual({
      kind: "complete",
      completionSnapshot: ownerCompletionSnapshot,
    });
    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.revision).toBe(4);
    expect(result.current.quizzes).toEqual([]);
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBeNull();
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBeNull();
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 2, "owner");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("restores a stored assisted draft after login when bootstrap has no submission", async () => {
    const { result, draft, fetchMock, bootstrapCallsBeforeLogin } =
      await startAssistedReauthWithStoredDraft();
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(makeBootstrap("assisted", null));

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.submissionId).toBe(draft.submissionId);
    expect(result.current.revision).toBe(draft.revision);
    expect(result.current.selections).toEqual({ 1: 0 });
    expect(window.sessionStorage.getItem("stcirt-answer-scope")).toBe("assisted");
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("keeps a matching assisted draft complete when bootstrap lacks restore integrity", async () => {
    const { result, draft, fetchMock, bootstrapCallsBeforeLogin } =
      await startAssistedReauthWithStoredDraft();
    const savedSubmission = {
      submissionId: draft.submissionId as string,
      revision: draft.revision as number,
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 0,
        freeText: null,
      })),
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(
      makeBootstrap("assisted", savedSubmission),
    );

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.submissionId).toBe(draft.submissionId);
    expect(result.current.revision).toBe(draft.revision);
    expect(result.current.restoreError).toContain("整合性を確認できません");
    expect(result.current.saveConfirmed).toBe(false);
    expect(result.current.answeredCount).toBe(0);
    expect(result.current.quizzes).toEqual([]);
    expect(window.sessionStorage.getItem("stcirt-assisted-answer-draft")).toBe(
      JSON.stringify(draft),
    );
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("restores free-text responses from a matching assisted draft after login", async () => {
    const { result, draft, fetchMock, bootstrapCallsBeforeLogin } =
      await startAssistedReauthWithStoredDraft();
    type DraftQuiz = {
      question: ReturnType<typeof question>;
      shuffled: { choices: string[]; choiceIndices: number[] };
    };
    const freeText = "確認済みの回答を復元します。";
    const draftWithFreeText = {
      ...draft,
      quizzes: (draft.quizzes as DraftQuiz[]).map((quiz) =>
        quiz.question.id === 5
          ? {
              ...quiz,
              question: { ...quiz.question, answerType: "freeText" as const, choices: [] },
              shuffled: { choices: [], choiceIndices: [] },
            }
          : quiz,
      ),
      freeResponses: { 5: freeText },
    };
    window.sessionStorage.setItem(
      "stcirt-assisted-answer-draft",
      JSON.stringify(draftWithFreeText),
    );
    const savedSubmission = {
      submissionId: draft.submissionId as string,
      revision: draft.revision as number,
      restoreIntegrity: restoreIntegrity(true),
      answers: [
        ...[1, 2, 3, 4].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 0,
          freeText: null,
        })),
        {
          questionId: 5,
          answerKind: "freeText" as const,
          selectedIndex: null,
          freeText,
        },
      ],
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(
      makeBootstrap("assisted", savedSubmission),
    );

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.selections).toEqual({ 1: 0 });
    expect(result.current.freeResponses).toEqual({ 5: freeText });
    expect(result.current.answeredCount).toBe(2);
    expect(result.current.submissionId).toBe(draft.submissionId);
    expect(result.current.revision).toBe(draft.revision);
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("hydrates a valid saved owner submission after assisted reauthentication falls back", async () => {
    const { result, fetchMock, bootstrapCallsBeforeLogin } =
      await startAssistedReauthWithMismatchedDraft();
    const ownerSubmission = {
      submissionId: "00000000-0000-4000-8000-000000000098",
      revision: 4,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 2,
        freeText: null,
      })),
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(makeBootstrap("owner", ownerSubmission));

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.answerMode).toBe("owner");
    expect(result.current.submissionId).toBe(ownerSubmission.submissionId);
    expect(result.current.revision).toBe(4);
    expect(result.current.restoreError).toBeNull();
    expect(result.current.saveConfirmed).toBe(true);
    expect(result.current.quizzes).toEqual([]);
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 2, "owner");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("preserves an assisted failed attempt after same-target reauthentication finds no submission", async () => {
    const { result, fetchMock, bootstrapCallsBeforeLogin } =
      await startAssistedReauthWithMismatchedDraft({
        bootstrap: makeBootstrap("assisted", null),
      });

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.phase).toMatchObject({ retryRequired: true });
    expect(result.current.selections).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("keeps a same-target assisted submission and failed correction after reauthentication", async () => {
    const { result, draft, fetchMock, bootstrapCallsBeforeLogin } =
      await startAssistedReauthWithMismatchedDraft({ preserveLocalSubmissionIdentity: true });

    await act(async () => result.current.login("参加者", "1234"));
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));

    expect(result.current.access).toEqual({ kind: "ready", participant });
    expect(result.current.answerMode).toBe("assisted");
    expect(result.current.phase).toMatchObject({ retryRequired: true });
    expect(result.current.submissionId).toBe(draft.submissionId);
    expect(result.current.revision).toBe(draft.revision);
    expect(result.current.selections).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 1, "assisted");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it.each(["missing", "invalid"] as const)(
    "blocks correction for a %s restoreIntegrity on the owner fallback submission",
    async (integrity) => {
      const { result, fetchMock, bootstrapCallsBeforeLogin } =
        await startAssistedReauthWithMismatchedDraft();
      const ownerSubmission = {
        submissionId: "00000000-0000-4000-8000-000000000098",
        revision: 4,
        ...(integrity === "invalid" ? { restoreIntegrity: { status: "invalid" as const } } : {}),
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 2,
          freeText: null,
        })),
      };
      vi.mocked(fetchAnswerBootstrap).mockResolvedValueOnce(
        makeBootstrap("owner", ownerSubmission),
      );

      await act(async () => result.current.login("参加者", "1234"));
      await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

      expect(result.current.answerMode).toBe("owner");
      expect(result.current.submissionId).toBe(ownerSubmission.submissionId);
      expect(result.current.revision).toBe(4);
      expect(result.current.restoreError).toContain("整合性を確認できません");
      expect(result.current.saveConfirmed).toBe(false);
      expect(fetchAnswerBootstrap).toHaveBeenNthCalledWith(bootstrapCallsBeforeLogin + 2, "owner");
      expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
    },
  );

  it("ignores a successful owner fallback bootstrap after unmount", async () => {
    const { result, unmount, bootstrapCallsBeforeLogin } =
      await startAssistedReauthWithMismatchedDraft();
    let resolveBootstrap!: (bootstrap: Awaited<ReturnType<typeof fetchAnswerBootstrap>>) => void;
    const pendingBootstrap = new Promise<Awaited<ReturnType<typeof fetchAnswerBootstrap>>>(
      (resolve) => {
        resolveBootstrap = resolve;
      },
    );
    vi.mocked(fetchAnswerBootstrap).mockReturnValueOnce(pendingBootstrap);
    let loginPromise!: Promise<number>;
    act(() => {
      loginPromise = result.current.login("参加者", "1234");
    });
    await waitFor(() =>
      expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(bootstrapCallsBeforeLogin + 2),
    );
    const accessBeforeUnmount = result.current.access;
    const phaseBeforeUnmount = result.current.phase;
    unmount();
    resolveBootstrap(makeBootstrap("owner"));

    await act(async () => {
      await expect(loginPromise).resolves.toBe(participant.id);
    });

    expect(result.current.access).toEqual(accessBeforeUnmount);
    expect(result.current.phase).toEqual(phaseBeforeUnmount);
  });

  it("ignores a post-login bootstrap rejection after the session epoch is invalidated", async () => {
    const { result, unmount } = await startWithExpiredOwnerSession();
    let rejectBootstrap!: (reason?: unknown) => void;
    const pendingBootstrap = new Promise<Awaited<ReturnType<typeof fetchAnswerBootstrap>>>(
      (_resolve, reject) => {
        rejectBootstrap = reject;
      },
    );
    vi.mocked(fetchAnswerBootstrap).mockReturnValueOnce(pendingBootstrap);
    let loginPromise!: Promise<number>;
    act(() => {
      loginPromise = result.current.login("参加者", "1234");
    });
    await waitFor(() => expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(2));
    const accessBeforeUnmount = result.current.access;
    const phaseBeforeUnmount = result.current.phase;
    unmount();
    rejectBootstrap(
      new ApiError({ status: 401, message: "Expired again", code: null, retryAt: null }),
    );

    await act(async () => {
      await expect(loginPromise).resolves.toBe(participant.id);
    });

    expect(result.current.access).toEqual(accessBeforeUnmount);
    expect(result.current.phase).toEqual(phaseBeforeUnmount);
  });

  it("retains, retries, and edits a fifth-question free-text answer", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("owner", null, true));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/participants/session")
        return { ok: true, json: async () => ({ participant }) };
      if (url === "/api/questions/batch") {
        return { ok: true, json: async () => ({ questions: batchQuestions(true) }) };
      }
      if (url === "/api/answers/batch" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (posts.length === 1)
          return { ok: false, status: 503, json: async () => ({ message: "一時的な通信エラー" }) };
        return {
          ok: true,
          json: async () => ({
            submissionId,
            revision: 1,
            completionSnapshot: failedCompletionSnapshot(submissionId, 1),
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = await start();
    for (const quiz of result.current.quizzes.filter(
      ({ question: item }) => item.answerType === "selected",
    )) {
      act(() => result.current.select(quiz.question.id, 1));
    }
    act(() => result.current.setFreeResponse(5, "  承認済みの環境を上司に確認します。  "));
    expect(result.current.answeredCount).toBe(5);

    await act(async () => result.current.saveAnswers());
    expect(result.current.phase).toMatchObject({ kind: "answering", retryRequired: true });
    expect(result.current.freeResponses[5]).toBe("  承認済みの環境を上司に確認します。  ");
    await act(async () => result.current.saveAnswers());
    expect(result.current.phase.kind).toBe("complete");
    const retriedPayload = posts[1];
    expect(retriedPayload?.operationId).toBe(posts[0]?.operationId);
    expect(retriedPayload?.answers).toContainEqual({
      questionId: 5,
      freeText: "承認済みの環境を上司に確認します。",
    });
    if (!retriedPayload) throw new Error("Expected a retry payload");
    const submittedFifthAnswer = (
      retriedPayload.answers as { questionId: number; selectedIndex?: number; freeText?: string }[]
    ).find(({ questionId }) => questionId === 5);
    expect(submittedFifthAnswer).toEqual({
      questionId: 5,
      freeText: "承認済みの環境を上司に確認します。",
    });

    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.freeResponses[5]).toBe("  承認済みの環境を上司に確認します。  ");
  });

  it("revisits the latest saved submission in completion and restores answers for correction", async () => {
    const savedSubmission = {
      submissionId,
      revision: 3,
      restoreIntegrity: restoreIntegrity(true),
      answers: [
        ...[1, 2, 3, 4].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: questionId % 4,
          freeText: null,
        })),
        {
          questionId: 5,
          answerKind: "freeText" as const,
          selectedIndex: null,
          freeText: "回答を保存しました。",
        },
      ],
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("owner", savedSubmission));
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValueOnce(savedSubmission);
    const fetchMock = setupFetch({ freeTextFifth: true });
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(fetchAnswerBootstrap).toHaveBeenCalledTimes(1);
    expect(fetchAnswerBootstrap).toHaveBeenCalledWith("owner");
    expect(fetchLatestAnswerSubmission).not.toHaveBeenCalled();
    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.revision).toBe(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(0);
    expect(result.current.selections).toEqual({});
    expect(result.current.freeResponses).toEqual({});
    expect(result.current.saveConfirmed).toBe(true);

    act(() => result.current.retrySubmissionCheck());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(fetchLatestAnswerSubmission).toHaveBeenCalledWith("owner");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(0);

    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.selections).toEqual(
      Object.fromEntries(
        result.current.quizzes
          .slice(0, 4)
          .map(({ question, shuffled }) => [
            question.id,
            shuffled.choiceIndices.indexOf(question.id % 4),
          ]),
      ),
    );
    expect(result.current.freeResponses[5]).toBe("回答を保存しました。");
    expect(result.current.restoreError).toBeNull();
    expect(result.current.saveConfirmed).toBe(false);

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(1);
    expect(result.current.phase.kind).toBe("answering");
    expect(result.current.selections).toEqual(result.current.savedSelections);
  });

  it("keeps malformed latest submissions complete and disables answer restoration", async () => {
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(
      makeBootstrap("owner", {
        submissionId,
        revision: 1,
        answers: [],
        restoreIntegrity: { status: "invalid" },
      }),
    );
    setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(result.current.restoreError).toMatch(/整合性を確認できません/);
    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.saveConfirmed).toBe(false);
  });

  it("does not treat a saved submission without an integrity guarantee as completed", async () => {
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(
      makeBootstrap("owner", {
        submissionId,
        revision: 2,
        answers: [1, 2, 3, 4, 5].map((questionId) => ({
          questionId,
          answerKind: "selected" as const,
          selectedIndex: 1,
          freeText: null,
        })),
      }),
    );
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.saveConfirmed).toBe(false);
    expect(result.current.restoreError).toContain("整合性を確認できません");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("does not start an attempt after a bootstrap failure and retries latest then questions", async () => {
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(new Error("temporary failure"));
    const retryOrder: string[] = [];
    vi.mocked(fetchLatestAnswerSubmission).mockImplementationOnce(async () => {
      retryOrder.push("latest");
      return null;
    });
    const fetchMock = setupFetch();
    const originalFetch = fetchMock.getMockImplementation();
    if (!originalFetch) throw new Error("Expected fetch mock implementation");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/questions/batch") retryOrder.push("questions");
      return originalFetch(url, init);
    });
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("submission-error"));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/questions/batch")).toBe(
      false,
    );

    act(() => result.current.retrySubmissionCheck());
    await waitFor(() => expect(result.current.phase.kind).toBe("answering"));
    expect(fetchLatestAnswerSubmission).toHaveBeenCalledTimes(1);
    expect(retryOrder).toEqual(["latest", "questions"]);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/questions/batch")).toBe(true);
  });

  it("does not load questions when a submission status retry finds a saved submission", async () => {
    vi.mocked(fetchAnswerBootstrap).mockRejectedValueOnce(new Error("temporary failure"));
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("submission-error"));
    fetchMock.mockClear();
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValueOnce({
      submissionId,
      revision: 2,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 1,
        freeText: null,
      })),
    });

    act(() => result.current.retrySubmissionCheck());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));

    expect(fetchLatestAnswerSubmission).toHaveBeenCalledWith("owner");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/questions/batch")).toBe(false);
  });

  it("loads questions only when editing a saved submission after a status recheck", async () => {
    const savedSubmission = {
      submissionId,
      revision: 2,
      restoreIntegrity: restoreIntegrity(),
      answers: [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: "selected" as const,
        selectedIndex: 1,
        freeText: null,
      })),
    };
    vi.mocked(fetchAnswerBootstrap).mockResolvedValue(makeBootstrap("owner", savedSubmission));
    vi.mocked(fetchLatestAnswerSubmission).mockResolvedValueOnce(savedSubmission);
    const fetchMock = setupFetch();
    const { result } = renderHook(() => useQuizSession());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(0);

    act(() => result.current.retrySubmissionCheck());
    await waitFor(() => expect(result.current.phase.kind).toBe("complete"));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(0);

    expect(result.current.submissionId).toBe(submissionId);
    expect(result.current.revision).toBe(2);
    expect(result.current.answeredCount).toBe(0);
    await act(async () => result.current.editAnswers(() => true));
    expect(result.current.answeredCount).toBe(5);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/questions/batch")).toHaveLength(1);
  });
});
