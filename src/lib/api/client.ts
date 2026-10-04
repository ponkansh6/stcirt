import { z } from "zod";
import { QuizQuestion, AnswerResult } from "@/types/quiz";

export const quizQuestionSchema = z.object({
  id: z.number(),
  question: z.string(),
  choices: z.array(z.string()),
});

export const answerResultSchema = z.object({
  isCorrect: z.boolean(),
  correctIndex: z.number(),
  explanation: z.string().nullable(),
});

type RequestOptions = { customErrorMsg?: string; allowNotFound?: boolean };

async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const json = await res.json();
    if (json && typeof json === "object" && "error" in json && typeof json.error === "string") {
      return json.error;
    }
  } catch {
    // non-JSON body, fall back
  }
  return null;
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  label: string,
  schema: z.ZodType<T>,
  options: RequestOptions & { allowNotFound: true },
): Promise<T | null>;
async function request<T>(
  path: string,
  init: RequestInit | undefined,
  label: string,
  schema: z.ZodType<T>,
  options?: RequestOptions,
): Promise<T>;
async function request<T>(
  path: string,
  init: RequestInit | undefined,
  label: string,
  schema: z.ZodType<T>,
  options?: RequestOptions,
): Promise<T | null> {
  const res = await fetch(path, init);
  if (res.status === 404 && options?.allowNotFound) {
    return null;
  }
  if (!res.ok) {
    const fallback = `Failed to ${label}: status ${res.status}`;
    const errorMsg = (await readErrorMessage(res)) ?? options?.customErrorMsg ?? fallback;
    throw new Error(errorMsg);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Failed to parse response from ${label}`);
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid response schema for ${label}: ${parsed.error.message}`);
  }

  return parsed.data;
}

export async function fetchNextQuestion(afterId?: number): Promise<QuizQuestion | null> {
  const query = afterId === undefined ? "" : `?afterId=${afterId}`;
  return request(
    `/api/questions/next${query}`,
    undefined,
    "fetch next question",
    quizQuestionSchema,
    { allowNotFound: true },
  );
}

export async function submitAnswer(
  questionId: number,
  selectedIndex: number,
): Promise<AnswerResult> {
  return request(
    "/api/answers",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, selectedIndex }),
    },
    "submit answer",
    answerResultSchema,
  );
}
