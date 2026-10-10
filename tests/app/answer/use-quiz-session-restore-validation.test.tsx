import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useQuizSession } from "@/app/answer/use-quiz-session";

const mockLatest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, fetchLatestAnswerSubmission: mockLatest };
});

const participant = { id: 7, name: "参加者" };
const submissionId = "00000000-0000-4000-8000-000000000001";
const quiz = (id: number, freeText = false) => ({
  id,
  question: `Question ${id}`,
  choices: freeText ? [] : ["A", "B", "C", "D"],
  answerType: freeText ? "freeText" : "selected",
});
const validAnswers = () =>
  [1, 2, 3, 4, 5].map((questionId) => ({
    questionId,
    answerKind: "selected",
    selectedIndex: 0,
    freeText: null,
  }));

describe("useQuizSession saved answer validation", () => {
  beforeEach(() => {
    mockLatest.mockReset();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(submissionId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function loadSavedSubmission(answers: unknown[], freeTextFifth = false) {
    mockLatest.mockResolvedValue({ submissionId, revision: 2, answers });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/participants/session")
          return { ok: true, json: async () => ({ participant }) };
        if (url === "/api/questions/batch") {
          return {
            ok: true,
            json: async () => ({
              questions: [1, 2, 3, 4, 5].map((id) =>
                freeTextFifth && id === 5 ? quiz(id, true) : quiz(id),
              ),
            }),
          };
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const hook = renderHook(() => useQuizSession());
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("complete"));
    return hook;
  }

  it.each([
    ["a non-five-answer submission", validAnswers().slice(0, 4), false],
    ["duplicate question IDs", [...validAnswers().slice(0, 4), { ...validAnswers()[0]! }], false],
    [
      "an answer for a question outside the loaded exam",
      [...validAnswers().slice(0, 4), { ...validAnswers()[4]!, questionId: 6 }],
      false,
    ],
    [
      "a selected index absent from the question choices",
      [...validAnswers().slice(0, 4), { ...validAnswers()[4]!, selectedIndex: 99 }],
      false,
    ],
    [
      "a selected answer without a choice index",
      [...validAnswers().slice(0, 4), { ...validAnswers()[4]!, selectedIndex: null }],
      false,
    ],
    ["a free-text question with a selected answer", validAnswers(), true],
    [
      "a legacy free-text answer with an invalid legacy payload",
      [
        ...validAnswers().slice(0, 4),
        { questionId: 5, answerKind: "legacy", selectedIndex: null, freeText: "unexpected" },
      ],
      true,
    ],
    [
      "a free-text answer with blank text",
      [
        ...validAnswers().slice(0, 4),
        { questionId: 5, answerKind: "freeText", selectedIndex: null, freeText: "   " },
      ],
      true,
    ],
    [
      "a free-text answer longer than the limit",
      [
        ...validAnswers().slice(0, 4),
        { questionId: 5, answerKind: "freeText", selectedIndex: null, freeText: "x".repeat(1001) },
      ],
      true,
    ],
    [
      "a free-text answer that also contains a choice index",
      [
        ...validAnswers().slice(0, 4),
        { questionId: 5, answerKind: "freeText", selectedIndex: 0, freeText: "text" },
      ],
      true,
    ],
  ])("disables correction for %s", async (_label, answers, freeTextFifth) => {
    const { result } = await loadSavedSubmission(answers as unknown[], freeTextFifth as boolean);
    expect(result.current.phase.kind).toBe("complete");
    expect(result.current.restoreError).toContain("保存済み回答と現在の設問が一致しない");
    result.current.editAnswers();
    expect(result.current.phase.kind).toBe("complete");
  });
});
