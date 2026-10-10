import { z } from "zod";
import { QuizQuestion } from "@/types/quiz";
import {
  answerBatchResultSchema,
  answerSubmissionSchema,
  latestAnswerSubmissionSchema,
} from "./schemas";

export const quizQuestionSchema = z
  .object({
    id: z.number().int().positive(),
    question: z.string().min(1),
    choices: z.array(z.string().min(1)),
    answerType: z.enum(["selected", "freeText"]),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.answerType === "selected" && question.choices.length < 2) {
      context.addIssue({ code: "custom", message: "Selected questions require choices" });
    }
    if (question.answerType === "freeText" && question.choices.length !== 0) {
      context.addIssue({ code: "custom", message: "Free-text questions cannot expose choices" });
    }
  });

const examQuestionsSchema = z
  .object({ questions: z.array(quizQuestionSchema).length(5) })
  .strict()
  .superRefine(({ questions }, context) => {
    const ids = questions.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Question IDs must be unique" });
    }
    if (ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) {
      context.addIssue({ code: "custom", message: "Questions must be ordered by ID" });
    }
  });

export const answerResultSchema = z.object({
  recorded: z.literal(true),
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

export async function fetchExamQuestions(): Promise<QuizQuestion[]> {
  const result = await request(
    "/api/questions/batch",
    undefined,
    "fetch exam questions",
    examQuestionsSchema,
  );
  return result.questions;
}

export type Participant = { id: number; name: string };
export type ParticipantSession = { participant: Participant; expiresAt: string };
export type AssistedParticipantState = {
  participant: Participant | null;
  hasSubmission: boolean;
  eligible: boolean;
};
export type AnswerScope = "owner" | "assisted";

const participantSchema = z.object({ id: z.number(), name: z.string() });
const participantSessionSchema = z.object({
  participant: participantSchema,
  expiresAt: z.string(),
});
const participantLookupSchema = z.object({ participant: participantSchema.nullable() });
const assistedParticipantStateSchema = z.object({
  participant: participantSchema.nullable(),
  hasSubmission: z.boolean(),
  eligible: z.boolean(),
});
const assistedParticipantResultSchema = z.object({
  participant: participantSchema,
  hasSubmission: z.boolean(),
});

export async function fetchAssistedParticipant(): Promise<AssistedParticipantState> {
  return request(
    "/api/participants/assisted",
    undefined,
    "check assisted participant",
    assistedParticipantStateSchema,
  );
}

export async function createAssistedParticipant(name: string): Promise<{
  participant: Participant;
  hasSubmission: boolean;
}> {
  return request(
    "/api/participants/assisted",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
    "start assisted answer",
    assistedParticipantResultSchema,
  );
}

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
): Promise<{ recorded: true }> {
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

export type AnswerBatchInput = {
  submissionId: string;
  operationId: string;
  expectedRevision: number;
  answers: (
    | { questionId: number; selectedIndex: number }
    | { questionId: number; freeText: string }
  )[];
};

export type AnswerBatchResult = { submissionId: string; revision: number };

function scopedPath(path: string, scope: AnswerScope): string {
  return scope === "assisted" ? `${path}${path.includes("?") ? "&" : "?"}scope=assisted` : path;
}

export async function submitAnswerBatch(
  input: AnswerBatchInput,
  scope: AnswerScope = "owner",
): Promise<AnswerBatchResult> {
  return request(
    scopedPath("/api/answers/batch", scope),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    "submit answer batch",
    answerBatchResultSchema,
  );
}

export type AnswerSubmission = z.infer<typeof answerSubmissionSchema>;

export async function fetchAnswerSubmission(
  submissionId: string,
  scope: AnswerScope = "owner",
): Promise<AnswerSubmission> {
  return request(
    scopedPath(`/api/answers/batch?submissionId=${encodeURIComponent(submissionId)}`, scope),
    undefined,
    "fetch answer submission",
    answerSubmissionSchema,
  );
}

export async function fetchLatestAnswerSubmission(
  scope: AnswerScope = "owner",
): Promise<AnswerSubmission | null> {
  const result = await request(
    scopedPath("/api/answers/latest", scope),
    undefined,
    "fetch latest answer submission",
    latestAnswerSubmissionSchema,
  );
  return result.submission;
}
