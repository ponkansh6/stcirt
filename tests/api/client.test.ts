import { describe, it, expect, vi } from "vitest";
import {
  ApiError,
  createParticipantSession,
  deleteParticipantSession,
  fetchNextQuestion,
  fetchLatestAnswerSubmission,
  fetchParticipantSession,
  submitAnswer,
} from "@/lib/api/client";

describe("api client", () => {
  it("fetches the participant's latest saved submission, including an explicit empty result", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ submission: null }), { status: 200 }));
    await expect(fetchLatestAnswerSubmission()).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith("/api/answers/latest", { credentials: "same-origin" });
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
