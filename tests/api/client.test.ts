import { describe, it, expect, vi } from "vitest";
import { fetchNextQuestion, submitAnswer } from "@/lib/api/client";

describe("api client", () => {
  it("fetches the first question when no cursor is provided", async () => {
    const question = { id: 1, question: "Q1", choices: ["A", "B", "C", "D"] };
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(question), { status: 200 }));
    await expect(fetchNextQuestion()).resolves.toEqual(question);
    expect(fetchSpy).toHaveBeenCalledWith("/api/questions/next", undefined);
  });

  it("fetches the question after the given id and returns null at completion", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(fetchNextQuestion(7)).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith("/api/questions/next?afterId=7", undefined);
  });

  it("propagates errors while fetching the next question", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Storage unavailable" }), { status: 500 }),
    );
    await expect(fetchNextQuestion()).rejects.toThrow("Storage unavailable");
  });

  it("submits answers and returns feedback", async () => {
    const result = { isCorrect: true, correctIndex: 0, explanation: null };
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));
    await expect(submitAnswer(1, 0)).resolves.toEqual(result);
    expect(fetchSpy).toHaveBeenCalledWith("/api/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: 1, selectedIndex: 0 }),
    });
  });
});
