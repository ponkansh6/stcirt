import { describe, it, expect, vi } from "vitest";
import {
  ApiError,
  createAssistedParticipant,
  createParticipantSession,
  deleteParticipantSession,
  fetchAnswerSubmission,
  fetchExamQuestions,
  fetchAssistedParticipant,
  fetchNextQuestion,
  fetchLatestAnswerSubmission,
  fetchParticipantSession,
  submitAnswerBatch,
  submitAnswer,
} from "@/lib/api/client";

describe("api client", () => {
  const examQuestions = () =>
    [1, 2, 3, 4, 5].map((id) => ({
      id,
      question: `Q${id}`,
      choices: id === 5 ? [] : ["A", "B", "C", "D"],
      answerType: id === 5 ? "freeText" : "selected",
    }));

  it("fetches the complete ordered exam in one same-origin request", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ questions: examQuestions() }), { status: 200 }),
      );
    await expect(fetchExamQuestions()).resolves.toEqual(examQuestions());
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith("/api/questions/batch", {
      credentials: "same-origin",
    });
  });

  it.each([
    { label: "a partial batch", questions: examQuestions().slice(0, 4) },
    {
      label: "duplicate IDs",
      questions: [examQuestions()[0], examQuestions()[0], ...examQuestions().slice(2)],
    },
    {
      label: "out of order IDs",
      questions: [examQuestions()[1], examQuestions()[0], ...examQuestions().slice(2)],
    },
    {
      label: "private answer fields",
      questions: examQuestions().map((question, index) =>
        index === 0 ? { ...question, correctIndex: 2 } : question,
      ),
    },
    {
      label: "choices on a free-text question",
      questions: examQuestions().map((question, index) =>
        index === 4 ? { ...question, choices: ["private"] } : question,
      ),
    },
  ])("rejects $label before returning exam questions", async ({ questions }) => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ questions }), { status: 200 }),
    );
    await expect(fetchExamQuestions()).rejects.toThrow(
      "Invalid response schema for fetch exam questions",
    );
  });

  it("rejects selected exam questions that do not offer enough choices", async () => {
    const questions = examQuestions().map((question, index) =>
      index === 0 ? { ...question, choices: ["A"] } : question,
    );
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ questions }), { status: 200 }),
    );

    await expect(fetchExamQuestions()).rejects.toThrow(
      "Invalid response schema for fetch exam questions",
    );
  });

  it("fetches the participant's latest saved submission, including an explicit empty result", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ submission: null }), { status: 200 }));
    await expect(fetchLatestAnswerSubmission()).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith("/api/answers/latest", { credentials: "same-origin" });
  });

  it("uses the assisted answer scope for both loading and saving answers", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ submission: null }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ submissionId: "00000000-0000-4000-8000-000000000002", revision: 1 }),
          { status: 200 },
        ),
      );
    await expect(fetchLatestAnswerSubmission("assisted")).resolves.toBeNull();
    await submitAnswerBatch(
      {
        submissionId: "00000000-0000-4000-8000-000000000002",
        operationId: "00000000-0000-4000-8000-000000000003",
        expectedRevision: 0,
        answers: [{ questionId: 1, selectedIndex: 2 }],
      },
      "assisted",
    );

    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/answers/latest?scope=assisted", {
      credentials: "same-origin",
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/answers/batch?scope=assisted");
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  it("appends the assisted scope after an existing submission query", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          submissionId: "00000000-0000-4000-8000-000000000002",
          revision: 1,
          answers: [],
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchAnswerSubmission("00000000-0000-4000-8000-000000000002", "assisted"),
    ).resolves.toMatchObject({ revision: 1, answers: [] });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/answers/batch?submissionId=00000000-0000-4000-8000-000000000002&scope=assisted",
      { credentials: "same-origin" },
    );
  });

  it("checks and creates one assisted participant with same-origin requests", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participant: { id: 18, name: "代理回答者" },
            hasSubmission: true,
            eligible: false,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ participant: { id: 18, name: "代理回答者" }, hasSubmission: false }),
          { status: 200 },
        ),
      );

    await expect(fetchAssistedParticipant()).resolves.toEqual({
      participant: { id: 18, name: "代理回答者" },
      hasSubmission: true,
      eligible: false,
    });
    await expect(createAssistedParticipant("代理回答者")).resolves.toEqual({
      participant: { id: 18, name: "代理回答者" },
      hasSubmission: false,
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/participants/assisted", {
      credentials: "same-origin",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(2, "/api/participants/assisted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "代理回答者" }),
      credentials: "same-origin",
    });
  });

  it("rejects malformed assisted participant responses", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ participant: { id: "18", name: "代理" } }), { status: 200 }),
    );
    await expect(fetchAssistedParticipant()).rejects.toThrow(
      "Invalid response schema for check assisted participant",
    );
  });

  it("fetches the first question when no cursor is provided", async () => {
    const question = {
      id: 1,
      question: "Q1",
      choices: ["A", "B", "C", "D"],
      answerType: "selected",
    };
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(question), { status: 200 }));
    await expect(fetchNextQuestion()).resolves.toEqual(question);
    expect(fetchSpy).toHaveBeenCalledWith("/api/questions/next", { credentials: "same-origin" });
  });

  it("fetches the question after the given id and returns null at completion", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(fetchNextQuestion(7)).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith("/api/questions/next?afterId=7", {
      credentials: "same-origin",
    });
  });

  it("propagates errors while fetching the next question", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Storage unavailable" }), { status: 500 }),
    );
    await expect(fetchNextQuestion()).rejects.toThrow("Storage unavailable");
  });

  it.each([
    { description: "an empty response", response: new Response(null, { status: 204 }) },
    { description: "invalid JSON", response: new Response("{", { status: 200 }) },
  ])("rejects when the successful response contains $description", async ({ response }) => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(response);
    await expect(fetchNextQuestion()).rejects.toThrow(
      "Failed to parse response from fetch next question",
    );
  });

  it("rejects when the successful response does not match the expected schema", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "1", question: "Q1" }), { status: 200 }),
    );
    await expect(fetchNextQuestion()).rejects.toThrow(
      "Invalid response schema for fetch next question",
    );
  });

  it("propagates network errors while fetching the next question", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new TypeError("Network unavailable"));
    await expect(fetchNextQuestion()).rejects.toThrow("Network unavailable");
  });

  it("uses the request fallback when an error response is not JSON", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("Service unavailable", { status: 503 }),
    );
    await expect(fetchNextQuestion()).rejects.toThrow("Failed to fetch next question: status 503");
  });

  it("uses the request fallback when an error response contains primitive JSON", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response("null", { status: 503 }));
    const error = await fetchNextQuestion().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 503,
      message: "Failed to fetch next question: status 503",
      code: null,
      retryAt: null,
    });
  });

  it("preserves status and retryAt on structured API errors", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "RATE_LIMITED",
          message: "Try later",
          retryAt: "2030-01-01T00:00:00.000Z",
        }),
        { status: 429 },
      ),
    );
    const error = await fetchNextQuestion().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      message: "Try later",
      retryAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("checks participant session and returns null when no participant cookie exists", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ participant: null }), { status: 200 }));
    await expect(fetchParticipantSession()).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith("/api/participants/session", {
      credentials: "same-origin",
    });
  });

  it("creates a participant session with name and PIN", async () => {
    const result = { participant: { id: 4, name: "佐藤" }, expiresAt: "2030-01-01T00:00:00.000Z" };
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));
    await expect(createParticipantSession("佐藤", "0012")).resolves.toEqual(result);
    expect(fetchSpy).toHaveBeenCalledWith("/api/participants/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "佐藤", pin: "0012" }),
      credentials: "same-origin",
    });
  });

  it("deletes the participant session", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(deleteParticipantSession()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith("/api/participants/session", {
      method: "DELETE",
      credentials: "same-origin",
    });
  });

  it("submits answers without returning grading details", async () => {
    const result = { recorded: true };
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));
    await expect(submitAnswer(1, 0)).resolves.toEqual(result);
    expect(fetchSpy).toHaveBeenCalledWith("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: 1, selectedIndex: 0 }),
      credentials: "same-origin",
    });
  });
});
