import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../index";
import {
  examAnswerLogs,
  examAnswerSubmissions,
  examQuestions,
  examSubmissionAnswers,
  examSubmissionOperations,
} from "../schema";
import { jstDayStart } from "../../date";

export type BatchAnswer = { questionId: number; selectedIndex: number };

export class BatchSubmissionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "BatchSubmissionError";
  }
}

export async function getAnswerSubmission(submissionId: string, participantId: number) {
  return db.transaction(async (tx) => {
    const [submission] = await tx
      .select()
      .from(examAnswerSubmissions)
      .where(eq(examAnswerSubmissions.id, submissionId));
    if (!submission || submission.participantId !== participantId) return null;

    const storedAnswers = await tx
      .select({
        questionId: examSubmissionAnswers.questionId,
        selectedIndex: examSubmissionAnswers.selectedIndex,
      })
      .from(examSubmissionAnswers)
      .where(eq(examSubmissionAnswers.submissionId, submissionId));
    const answerByQuestion = new Map(storedAnswers.map((answer) => [answer.questionId, answer]));
    const answers = submission.questionIds.flatMap((questionId) => {
      const answer = answerByQuestion.get(questionId);
      return answer ? [answer] : [];
    });
    return { submissionId: submission.id, revision: submission.revision, answers };
  });
}

/** Save or revise one fixed five-question answer set atomically. */
export async function saveAnswerSubmission(input: {
  submissionId: string;
  operationId: string;
  expectedRevision: number;
  participantId: number;
  answers: BatchAnswer[];
}) {
  const canonicalAnswers = [...input.answers].sort(
    (left, right) => left.questionId - right.questionId,
  );
  const payload = JSON.stringify({
    submissionId: input.submissionId,
    expectedRevision: input.expectedRevision,
    answers: canonicalAnswers,
  });

  try {
    return await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(examSubmissionOperations)
        .where(eq(examSubmissionOperations.operationId, input.operationId));
      if (operation) {
        const [owner] = await tx
          .select({ participantId: examAnswerSubmissions.participantId })
          .from(examAnswerSubmissions)
          .where(eq(examAnswerSubmissions.id, operation.submissionId));
        if (!owner || owner.participantId !== input.participantId) {
          throw new BatchSubmissionError("Submission not found", 404);
        }
        if (operation.submissionId !== input.submissionId || operation.payload !== payload) {
          throw new BatchSubmissionError("Operation ID was already used", 409);
        }
        return { submissionId: input.submissionId, revision: operation.revision };
      }

      if (
        input.answers.length !== 5 ||
        new Set(input.answers.map((a) => a.questionId)).size !== 5
      ) {
        throw new BatchSubmissionError("Exactly five distinct answers are required", 400);
      }

      const [submission] = await tx
        .select()
        .from(examAnswerSubmissions)
        .where(eq(examAnswerSubmissions.id, input.submissionId));
      if (submission && submission.participantId !== input.participantId) {
        throw new BatchSubmissionError("Submission not found", 404);
      }
      if (input.expectedRevision !== (submission?.revision ?? 0)) {
        throw new BatchSubmissionError("Submission revision conflict", 409);
      }

      const examSet = await tx
        .select({ id: examQuestions.id, choices: examQuestions.choices })
        .from(examQuestions)
        .orderBy(asc(examQuestions.id))
        .limit(5);
      const expectedQuestionIds = submission
        ? submission.questionIds
        : examSet.map((question) => question.id);
      if (
        expectedQuestionIds.length !== 5 ||
        canonicalAnswers.some((answer, index) => answer.questionId !== expectedQuestionIds[index])
      ) {
        throw new BatchSubmissionError("Answers must match the submission's five questions", 400);
      }
      if (!submission && examSet.length !== 5) {
        throw new BatchSubmissionError("Five exam questions are required", 400);
      }
      const questions = submission
        ? await tx
            .select({ id: examQuestions.id, choices: examQuestions.choices })
            .from(examQuestions)
            .where(inArray(examQuestions.id, expectedQuestionIds))
        : examSet;
      const questionById = new Map(questions.map((question) => [question.id, question]));
      if (
        canonicalAnswers.some((answer) => {
          const question = questionById.get(answer.questionId);
          return (
            !question || answer.selectedIndex < 0 || answer.selectedIndex >= question.choices.length
          );
        })
      ) {
        throw new BatchSubmissionError("Selected answer is outside the question's choices", 400);
      }

      const revision = submission ? submission.revision + 1 : 1;

      if (submission) {
        const updated = await tx
          .update(examAnswerSubmissions)
          .set({ revision, updatedAt: new Date() })
          .where(
            and(
              eq(examAnswerSubmissions.id, input.submissionId),
              eq(examAnswerSubmissions.revision, input.expectedRevision),
            ),
          )
          .returning({ id: examAnswerSubmissions.id });
        if (updated.length === 0) {
          const [latest] = await tx
            .select({ revision: examAnswerSubmissions.revision })
            .from(examAnswerSubmissions)
            .where(eq(examAnswerSubmissions.id, input.submissionId));
          if (!latest) throw new BatchSubmissionError("Submission not found", 404);
          throw new BatchSubmissionError("Submission revision conflict", 409);
        }
        await tx
          .delete(examSubmissionAnswers)
          .where(eq(examSubmissionAnswers.submissionId, input.submissionId));
      } else {
        await tx.insert(examAnswerSubmissions).values({
          id: input.submissionId,
          participantId: input.participantId,
          questionIds: expectedQuestionIds,
          revision,
        });
      }

      await tx.insert(examSubmissionAnswers).values(
        canonicalAnswers.map((answer) => ({
          submissionId: input.submissionId,
          questionId: answer.questionId,
          selectedIndex: answer.selectedIndex,
        })),
      );
      await tx.insert(examSubmissionOperations).values({
        operationId: input.operationId,
        submissionId: input.submissionId,
        payload,
        revision,
      });
      return { submissionId: input.submissionId, revision };
    });
  } catch (error) {
    if (error instanceof BatchSubmissionError || !isKnownSqliteConflict(error)) throw error;
    const recovered = await recoverSubmissionConflict(input, payload);
    if (recovered) return recovered;
    throw error;
  }
}

function isKnownSqliteConflict(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  for (let depth = 0; pending.length > 0 && depth < 6; depth += 1) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    const value = current as {
      code?: unknown;
      extendedCode?: unknown;
      message?: unknown;
      cause?: unknown;
      originalError?: unknown;
      original?: unknown;
      error?: unknown;
    };
    const code = typeof value.code === "string" ? value.code : "";
    const extendedCode = typeof value.extendedCode === "string" ? value.extendedCode : "";
    if (/^SQLITE_BUSY(?:_|$)/.test(code) || /^SQLITE_LOCKED(?:_|$)/.test(code)) return true;
    if (
      [code, extendedCode].some(
        (candidate) =>
          candidate === "SQLITE_CONSTRAINT_UNIQUE" || candidate === "SQLITE_CONSTRAINT_PRIMARYKEY",
      )
    ) {
      return true;
    }
    if (
      code === "SQLITE_CONSTRAINT" &&
      typeof value.message === "string" &&
      /^UNIQUE constraint failed:/i.test(value.message)
    ) {
      return true;
    }

    pending.push(value.cause, value.originalError, value.original, value.error);
  }
  return false;
}

/** Re-read committed state only after a recognized adapter conflict and rollback. */
async function recoverSubmissionConflict(
  input: {
    submissionId: string;
    operationId: string;
    expectedRevision: number;
    participantId: number;
  },
  payload: string,
) {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(examSubmissionOperations)
      .where(eq(examSubmissionOperations.operationId, input.operationId));
    if (operation) {
      const [owner] = await tx
        .select({ participantId: examAnswerSubmissions.participantId })
        .from(examAnswerSubmissions)
        .where(eq(examAnswerSubmissions.id, operation.submissionId));
      if (!owner || owner.participantId !== input.participantId) {
        throw new BatchSubmissionError("Submission not found", 404);
      }
      if (operation.submissionId === input.submissionId && operation.payload === payload) {
        return { submissionId: input.submissionId, revision: operation.revision };
      }
      throw new BatchSubmissionError("Operation ID was already used", 409);
    }

    const [submission] = await tx
      .select()
      .from(examAnswerSubmissions)
      .where(eq(examAnswerSubmissions.id, input.submissionId));
    if (!submission) return null;
    if (submission.participantId !== input.participantId) {
      throw new BatchSubmissionError("Submission not found", 404);
    }
    if (submission.revision !== input.expectedRevision) {
      throw new BatchSubmissionError("Submission revision conflict", 409);
    }
    return null;
  });
}

export async function recordAnswer(input: {
  questionId: number;
  selectedIndex: number;
  isCorrect: boolean;
  participantId?: number;
}) {
  await db.insert(examAnswerLogs).values({
    questionId: input.questionId,
    selectedIndex: input.selectedIndex,
    isCorrect: input.isCorrect ? 1 : 0,
    participantId: input.participantId ?? null,
  });
}

export async function getStats() {
  const dayStart = jstDayStart();
  // The two answer-log counts share the same table and predicate (answered
  // since JST day start), so fold them into one conditional aggregate. The
  // question count is independent, so run it in parallel.
  const [qCountResult, todayStats] = await Promise.all([
    db.select({ count: count(examQuestions.id) }).from(examQuestions),
    db
      .select({
        answers: count(examAnswerLogs.id),
        correct: sql<number>`sum(case when ${examAnswerLogs.isCorrect} = 1 then 1 else 0 end)`,
      })
      .from(examAnswerLogs)
      .where(gte(examAnswerLogs.answeredAt, dayStart)),
  ]);

  const totalQuestions = Number(qCountResult?.[0]?.count ?? 0);
  const todayAnswers = Number(todayStats?.[0]?.answers ?? 0);
  const todayCorrect = Number(todayStats?.[0]?.correct ?? 0);

  const todayAccuracy = todayAnswers > 0 ? todayCorrect / todayAnswers : 0;

  return {
    totalQuestions,
    todayAnswers,
    todayAccuracy,
  };
}
