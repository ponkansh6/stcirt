import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/questions/next/route";
import { getNextQuestion } from "@/lib/db/repository/question-repository";

vi.mock("@/lib/db/repository/question-repository", () => ({
  getNextQuestion: vi.fn(),
}));

const question = {
  id: 7,
  question: "Question?",
  choices: ["A", "B", "C", "D"],
  answerType: "selected" as const,
};

describe("GET /api/questions/next route handler", () => {
  beforeEach(() => {
    vi.mocked(getNextQuestion).mockReset();
  });

  it("returns the first question without a cursor", async () => {
    vi.mocked(getNextQuestion).mockResolvedValueOnce(question);

    const response = await GET(new Request("http://localhost/api/questions/next"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(question);
    expect(getNextQuestion).toHaveBeenCalledWith(undefined);
  });

  it("passes a positive afterId cursor to the repository", async () => {
    vi.mocked(getNextQuestion).mockResolvedValueOnce(question);

    const response = await GET(new Request("http://localhost/api/questions/next?afterId=6"));

    expect(response.status).toBe(200);
    expect(getNextQuestion).toHaveBeenCalledWith(6);
  });

  it.each(["abc", "0"])("rejects invalid cursor %s", async (afterId) => {
    const response = await GET(
      new Request(`http://localhost/api/questions/next?afterId=${afterId}`),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid question cursor" });
    expect(getNextQuestion).not.toHaveBeenCalled();
  });

  it("returns 404 when no question remains", async () => {
    vi.mocked(getNextQuestion).mockResolvedValueOnce(null);

    const response = await GET(new Request("http://localhost/api/questions/next?afterId=6"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "No questions available" });
  });

  it("converts repository failures to an internal server error", async () => {
    vi.mocked(getNextQuestion).mockRejectedValueOnce(new Error("Database unavailable"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(new Request("http://localhost/api/questions/next"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expect(logError).toHaveBeenCalledWith("Error in GET /api/questions/next:", expect.any(Error));
  });
});
