import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/questions/batch/route";
import { getExamQuestions } from "@/lib/db/repository/question-repository";

vi.mock("@/lib/db/repository/question-repository", () => ({
  getExamQuestions: vi.fn(),
}));

describe("GET /api/questions/batch route handler", () => {
  beforeEach(() => vi.mocked(getExamQuestions).mockReset());

  it("returns the repository's public exam projection in one response", async () => {
    const questions = [1, 2, 3, 4, 5].map((id) => ({
      id,
      question: `Question ${id}`,
      choices: id === 5 ? [] : ["A", "B", "C", "D"],
      answerType: id === 5 ? ("freeText" as const) : ("selected" as const),
    }));
    vi.mocked(getExamQuestions).mockResolvedValueOnce(questions);

    const response = await GET(new Request("http://localhost/api/questions/batch"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ questions });
    expect(getExamQuestions).toHaveBeenCalledOnce();
  });

  it("converts repository failures to an internal server error", async () => {
    vi.mocked(getExamQuestions).mockRejectedValueOnce(new Error("Database unavailable"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(new Request("http://localhost/api/questions/batch"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expect(logError).toHaveBeenCalledWith("Error in GET /api/questions/batch:", expect.any(Error));
  });
});
