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

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAt: string | null;

  constructor({
    status,
    message,
    code,
    retryAt,
  }: {
    status: number;
    message: string;
    code: string | null;
    retryAt: string | null;
  }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAt = retryAt;
  }
}

type ApiErrorPayload = { message: string | null; code: string | null; retryAt: string | null };

async function readErrorPayload(res: Response): Promise<ApiErrorPayload> {
  try {
    const json = await res.json();
    if (json && typeof json === "object") {
      const value = json as Record<string, unknown>;
      return {
        message:
          typeof value.message === "string"
            ? value.message
            : typeof value.error === "string"
              ? value.error
              : null,
        code: typeof value.error === "string" ? value.error : null,
        retryAt: typeof value.retryAt === "string" ? value.retryAt : null,
      };
    }
  } catch {
    // non-JSON body, fall back
  }
  return { message: null, code: null, retryAt: null };
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
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  if (res.status === 404 && options?.allowNotFound) {
    return null;
  }
  if (!res.ok) {
    const fallback = `Failed to ${label}: status ${res.status}`;
    const payload = await readErrorPayload(res);
    throw new ApiError({
      status: res.status,
      message: payload.message ?? options?.customErrorMsg ?? fallback,
      code: payload.code,
      retryAt: payload.retryAt,
    });
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

export type Participant = { id: number; name: string };
export type ParticipantSession = { participant: Participant; expiresAt: string };

const participantSchema = z.object({ id: z.number(), name: z.string() });
const participantSessionSchema = z.object({
  participant: participantSchema,
  expiresAt: z.string(),
});
const participantLookupSchema = z.object({ participant: participantSchema.nullable() });

export async function fetchParticipantSession(): Promise<Participant | null> {
  const result = await request(
    "/api/participants/session",
    undefined,
    "check participant session",
    participantLookupSchema,
  );
  return result.participant;
}

export async function createParticipantSession(
  name: string,
  pin: string,
): Promise<ParticipantSession> {
  return request(
    "/api/participants/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, pin }),
    },
    "start participant session",
    participantSessionSchema,
  );
}

export async function deleteParticipantSession(): Promise<void> {
  const res = await fetch("/api/participants/session", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const payload = await readErrorPayload(res);
    throw new ApiError({
      status: res.status,
      message: payload.message ?? `Failed to end participant session: status ${res.status}`,
      code: payload.code,
      retryAt: payload.retryAt,
    });
  }
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
