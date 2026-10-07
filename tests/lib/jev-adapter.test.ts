import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { gradeFreeResponse } from "@/lib/jev/adapter";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-latest",
    answers: {
      answer_match: {
        type: "score",
        score: 1.5,
        confidence: 0.98,
        legend: { "0": "不一致", "1": "部分一致", "2": "意味的に一致" },
        probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("accepts a valid fractional score and keeps confidence separate", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    respond(envelope());

    await expect(gradeFreeResponse("回答文")).resolves.toEqual({
      score: 1.5,
      confidence: 0.98,
      model: "jev-latest",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed when the provider API key is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(gradeFreeResponse("answer")).rejects.toThrow("jev_not_configured");
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
            score: 2.01,
            probabilities: { "0": 0, "1": 0, "2": 1 },
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
            probabilities: { "0": 0.2, "1": 0.2, "2": 0.2 },
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
            probabilities: { "0": -0.1, "1": 0.2, "2": 0.9 },
            score: 1.8,
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
            probabilities: { "0": 0.1, "1": 0.9 },
          },
        },
      },
    ],
    [
      "score disagrees with weighted probability",
      { answers: { answer_match: { ...envelope().answers.answer_match, score: 0.8 } } },
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
    await expect(gradeFreeResponse("answer")).rejects.toThrow("jev_invalid_response");
  });

  it("classifies validation and malformed JSON errors without forwarding response text", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private provider detail", { status: 422 })),
    );
    await expect(gradeFreeResponse("secret answer")).rejects.toThrow("jev_validation");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(gradeFreeResponse("secret answer")).rejects.toThrow("jev_invalid_json");
  });

  it("uses an abort timeout signal and leaves transport and timeout failures unclassified for durable retry", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-only-key");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(gradeFreeResponse("answer")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private detail", { status: 503 })),
    );
    await expect(gradeFreeResponse("answer")).rejects.toThrow("jev_http_error");
  });
});
