import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getRubricVersionForQuestionVersion,
  gradeFreeResponse,
  gradeFreeResponseParts,
  isSupportedGraderVersionPair,
  JEV_QUESTION_VERSION,
  JEV_RUBRIC_VERSION,
} from "@/lib/jev/adapter";

function gradeCurrentAnswer(answer: string) {
  return gradeFreeResponse(answer, JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION);
}

function envelope(overrides: Record<string, unknown> = {}) {
  const probabilities = Object.fromEntries(
    Array.from({ length: 10 }, (_, score) => [
      String(score),
      score === 0 ? 0.1 : score === 1 ? 0.3 : score === 2 ? 0.6 : 0,
    ]),
  );
  return {
    model: "jev-latest",
    answers: {
      answer_match: {
        type: "score",
        score: 1.5,
        confidence: 0.98,
        legend: Object.fromEntries(
          Array.from({ length: 10 }, (_, score) => [String(score), `score ${score}`]),
        ),
        probabilities,
      },
    },
    usage: { input_tokens: 130, output_tokens: 18 },
    ...overrides,
  };
}

function respond(payload: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status })),
  );
}

describe("JEV score adapter", () => {
  it("maps only the current question version to a rubric and accepts only its matching pair", () => {
    expect(getRubricVersionForQuestionVersion(JEV_QUESTION_VERSION)).toBe(JEV_RUBRIC_VERSION);
    expect(getRubricVersionForQuestionVersion("omiwatari-v1")).toBeNull();
    expect(getRubricVersionForQuestionVersion(null)).toBeNull();
    expect(isSupportedGraderVersionPair(JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION)).toBe(true);
    expect(isSupportedGraderVersionPair(JEV_QUESTION_VERSION, "omiwatari-v1")).toBe(false);
    expect(isSupportedGraderVersionPair(undefined, JEV_RUBRIC_VERSION)).toBe(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("accepts a valid fractional score and keeps confidence separate", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    respond(envelope());

    await expect(gradeCurrentAnswer("回答文")).resolves.toEqual({
      score: 1.5,
      confidence: 0.98,
      model: "jev-latest",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends one criterion per score level and accepts the provider's highest level", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        const criteria = request.questions.answer_match.criteria as string[];
        const highestScore = criteria.length - 1;

        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              answer_match: {
                type: "score",
                score: highestScore,
                confidence: 0.98,
                legend: Object.fromEntries(
                  criteria.map((criterion, score) => [String(score), criterion]),
                ),
                probabilities: Object.fromEntries(
                  criteria.map((_, score) => [String(score), score === highestScore ? 1 : 0]),
                ),
              },
            },
            usage: { input_tokens: 130, output_tokens: 18 },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(gradeCurrentAnswer("回答文")).resolves.toEqual({
      score: 9,
      confidence: 0.98,
      model: "jev-latest",
    });

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(request?.body)).questions.answer_match.criteria).toEqual([
      "0: 内容がない、または誤り",
      "1: 正しい意味情報がごく一部のみ",
      "2: 正しい意味情報が一部のみ",
      "3: 部分的に正しいが大きな不足がある",
      "4: 部分的に正しく、重要な不足がある",
      "5: 概ね正しいが重要な曖昧さや不足がある",
      "6: 概ね正しく、軽い不足が残る",
      "7: 正しく、軽い不足のみ",
      "8: ほぼ完全に正しい",
      "9: 期待される意味を正確かつ十分に満たす",
    ]);
  });

  it("skips JEV for keyword-complete parts while grading the other part independently", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    respond(envelope());

    await expect(
      gradeFreeResponseParts(
        { a: "新鮮なロブスター", b: "あの店で食事をしました" },
        JEV_QUESTION_VERSION,
        JEV_RUBRIC_VERSION,
      ),
    ).resolves.toMatchObject({
      a: null,
      b: { score: 1.5, confidence: 0.98, model: "jev-latest" },
      model: "jev-latest",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      state: {
        question: "3/1 早朝（6:30）に食べたものは何ですか？",
        user_answer: "あの店で食事をしました",
      },
      questions: {
        answer_match: {
          instructions: expect.stringContaining(
            "ハトシが6〜7点で最も近く、トーストまたはサンドイッチが3〜4点でその次",
          ),
        },
      },
    });
  });

  it("sends the ordered A near-miss guidance to JEV", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    respond(envelope());

    await gradeFreeResponse("カニ", JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION, "a");

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      questions: {
        answer_match: {
          instructions: expect.stringContaining(
            "エビが6〜7点で最も近く、カニが3〜4点でその次。エビは必ずカニより高く",
          ),
        },
      },
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      state: {
        expected_answer: "ロブスター（『新鮮な』は必須でなく、ロブスターだけでも正答）",
      },
      questions: {
        answer_match: {
          instructions: expect.stringContaining(
            "回答が『ロブスター』だけでも正答であり、『新鮮な』など鮮度の修飾語がなくても一切減点せず",
          ),
        },
      },
    });
  });

  it("skips both JEV calls when each part contains its required keyword", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      gradeFreeResponseParts(
        { a: "ロブスター", b: "フレンチトースト" },
        JEV_QUESTION_VERSION,
        JEV_RUBRIC_VERSION,
      ),
    ).resolves.toMatchObject({ a: null, b: null, model: "keyword-override" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records both model names when the independent part requests use different models", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    const responseFor = (model: string) =>
      new Response(JSON.stringify({ ...envelope(), model }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(responseFor("jev-a"))
        .mockResolvedValueOnce(responseFor("jev-b")),
    );

    await expect(
      gradeFreeResponseParts(
        { a: "朝食", b: "レストラン" },
        JEV_QUESTION_VERSION,
        JEV_RUBRIC_VERSION,
      ),
    ).resolves.toMatchObject({ model: "jev-a,jev-b" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends the original mixed Unicode answer to JEV without keyword normalization", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    respond(envelope());
    const originalAnswer = "  ﾀﾏｺﾞ・シュントウと卵  ";

    await gradeCurrentAnswer(originalAnswer);

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      state: { user_answer: originalAnswer },
    });
  });

  it("accepts a score that differs from the weighted probability and logs the delta", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    respond(
      envelope({
        answers: {
          answer_match: { ...envelope().answers.answer_match, score: 0.8 },
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(gradeCurrentAnswer("回答文")).resolves.toEqual({
        score: 1.5,
        confidence: 0.98,
        model: "jev-latest",
      });
      expect(warn).toHaveBeenCalledWith("JEV weighted score differs from returned score", {
        returnedScore: 0.8,
        weightedScore: 1.5,
        delta: 0.7,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("fails closed when the provider API key is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(gradeCurrentAnswer("answer")).rejects.toThrow("jev_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["negative token usage", { usage: { input_tokens: -1, output_tokens: 2 } }],
    ["fractional token usage", { usage: { input_tokens: 1.5, output_tokens: 2 } }],
    ["extra usage field", { usage: { input_tokens: 1, output_tokens: 2, cached_tokens: 1 } }],
    ["missing usage field", { usage: { input_tokens: 1 } }],
    [
      "score outside the documented scale",
      {
        answers: {
          answer_match: {
            ...envelope().answers.answer_match,
            score: 9.01,
            probabilities: Object.fromEntries(
              Array.from({ length: 10 }, (_, score) => [String(score), score === 9 ? 1 : 0]),
            ),
          },
        },
      },
    ],
    [
      "non-numeric score",
      { answers: { answer_match: { ...envelope().answers.answer_match, score: "1.5" } } },
    ],
    [
      "probabilities do not sum to one",
      {
        answers: {
          answer_match: {
            ...envelope().answers.answer_match,
            probabilities: {
              ...envelope().answers.answer_match.probabilities,
              "0": 0.2,
              "1": 0.2,
              "2": 0.2,
            },
          },
        },
      },
    ],
    [
      "negative probability",
      {
        answers: {
          answer_match: {
            ...envelope().answers.answer_match,
            probabilities: {
              ...envelope().answers.answer_match.probabilities,
              "0": -0.1,
              "1": 0.2,
              "2": 0.9,
            },
            score: 2,
          },
        },
      },
    ],
    [
      "missing probability level",
      {
        answers: {
          answer_match: {
            ...envelope().answers.answer_match,
            probabilities: Object.fromEntries(
              Object.entries(envelope().answers.answer_match.probabilities).filter(
                ([key]) => key !== "9",
              ),
            ),
          },
        },
      },
    ],
    [
      "confidence outside its range",
      { answers: { answer_match: { ...envelope().answers.answer_match, confidence: 1.1 } } },
    ],
    [
      "extra score response field",
      { answers: { answer_match: { ...envelope().answers.answer_match, raw: "unexpected" } } },
    ],
  ])("rejects %s", async (_name, override) => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    respond(envelope(override));
    await expect(gradeCurrentAnswer("answer")).rejects.toThrow("jev_invalid_response");
  });

  it("classifies validation and malformed JSON errors without forwarding response text", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    const providerSecret = "private provider detail sentinel";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(providerSecret, { status: 422 })),
    );
    const validationError = await gradeCurrentAnswer("secret answer").catch(
      (error: unknown) => error,
    );
    expect(validationError).toMatchObject({ message: "jev_validation" });
    expect((validationError as Error).message).toBe("jev_validation");
    expect(JSON.stringify(validationError)).not.toContain(providerSecret);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(`not-json: ${providerSecret}`, { status: 200 })),
    );
    const malformedJsonError = await gradeCurrentAnswer("secret answer").catch(
      (error: unknown) => error,
    );
    expect(malformedJsonError).toMatchObject({ message: "jev_invalid_json" });
    expect((malformedJsonError as Error).message).toBe("jev_invalid_json");
    expect(JSON.stringify(malformedJsonError)).not.toContain(providerSecret);
  });

  it("uses an abort timeout signal and leaves transport and timeout failures unclassified for durable retry", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(gradeCurrentAnswer("answer")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private detail", { status: 503 })),
    );
    await expect(gradeCurrentAnswer("answer")).rejects.toThrow("jev_http_error");
  });

  it("rejects missing or mismatched question and rubric versions before provider access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(gradeFreeResponse("answer", undefined, JEV_RUBRIC_VERSION)).rejects.toThrow(
      "Unsupported question/rubric version pair",
    );
    await expect(
      gradeFreeResponse("answer", JEV_QUESTION_VERSION, "old-rubric-v1"),
    ).rejects.toThrow("Unsupported question/rubric version pair");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
