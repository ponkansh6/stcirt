import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";

const dbRef = vi.hoisted(() => ({ db: null as TestDb["db"] | null }));
const gradeMock = vi.hoisted(() => vi.fn());
const rubricVersion = vi.hoisted(() => "test-rubric-v1");

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    get db() {
      if (!dbRef.db) throw new Error("test db not initialized");
      return dbRef.db;
    },
  };
});
vi.mock("@/lib/jev/adapter", () => ({
  gradeFreeResponse: gradeMock,
  JEV_RUBRIC_VERSION: rubricVersion,
}));

import {
  BatchSubmissionError,
  getAnswerSubmission,
  processDueAssessments,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";
import { gradeFreeResponse, JEV_RUBRIC_VERSION } from "@/lib/jev/adapter";

const submissionId = "00000000-0000-4000-8000-000000000101";
const operationId = "00000000-0000-4000-8000-000000000102";

describe("durable free-response assessment and restoration", () => {
  let testDb: TestDb;
  let participantId: number;
  const validAnswers = [
    ...[1, 2, 3, 4].map((questionId) => ({ questionId, selectedIndex: 0 })),
    { questionId: 5, freeText: "  上司に確認し、承認済み環境を使います。  " },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.examAnswerAssessments);
    await testDb.db.delete(schema.examSubmissionOperations);
    await testDb.db.delete(schema.examSubmissionAnswers);
    await testDb.db.delete(schema.examAnswerSubmissions);
    await testDb.db.delete(schema.examQuestions);
    await testDb.db.delete(schema.examParticipants);
    const [participant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "回答者", displayName: "回答者" })
      .returning({ id: schema.examParticipants.id });
    participantId = participant!.id;
    await testDb.db.insert(schema.examQuestions).values(
      [1, 2, 3, 4, 5].map((id) => ({
        id,
        key: id === 5 ? "it-literacy-005" : `it-literacy-00${id}`,
        question: `Q${id}`,
        choices: id === 5 ? [] : ["A", "B", "C", "D"],
        correctIndex: 0,
      })),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await testDb.cleanup();
  });

  it("enforces question-specific answer variants and persists trimmed text with a pending assessment", async () => {
    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId,
        expectedRevision: 0,
        participantId,
        answers: [...validAnswers.slice(0, 4), { questionId: 5, selectedIndex: 0 }],
      }),
    ).rejects.toBeInstanceOf(BatchSubmissionError);
    await expect(
      saveAnswerSubmission({
        submissionId,
        operationId,
        expectedRevision: 0,
        participantId,
        answers: [
          ...validAnswers.slice(1, 4),
          { questionId: 1, freeText: "wrong type" },
          validAnswers[4]!,
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });

    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    const [assessment] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessment).toMatchObject({
      revision: 1,
      answerText: "上司に確認し、承認済み環境を使います。",
      rubricVersion: JEV_RUBRIC_VERSION,
      state: "pending",
      attempts: 0,
    });
    await expect(getAnswerSubmission(submissionId, participantId)).resolves.toMatchObject({
      answers: expect.arrayContaining([
        {
          questionId: 5,
          answerKind: "freeText",
          selectedIndex: null,
          freeText: "上司に確認し、承認済み環境を使います。",
        },
      ]),
    });
  });

  it("restores migrated legacy rows distinctly and never submits them for regrading", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    await testDb.db
      .update(schema.examSubmissionAnswers)
      .set({ answerKind: "legacy", freeText: null, selectedIndex: 1 })
      .where(eq(schema.examSubmissionAnswers.questionId, 5));
    await testDb.db.delete(schema.examAnswerAssessments);
    const restored = await getAnswerSubmission(submissionId, participantId);
    expect(restored?.answers.find(({ questionId }) => questionId === 5)).toEqual({
      questionId: 5,
      answerKind: "legacy",
      selectedIndex: 1,
      freeText: null,
    });
    expect(await testDb.db.select().from(schema.examAnswerAssessments)).toHaveLength(0);
  });

  it("retries transient provider failures with persisted backoff and increments durable attempts", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    vi.mocked(gradeFreeResponse)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ score: 1.4, confidence: 0.99, model: "jev-latest" });
    await expect(processDueAssessments()).resolves.toMatchObject({
      processed: 1,
      retried: 1,
      graded: 0,
    });
    const [waiting] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(waiting).toMatchObject({
      state: "pending",
      attempts: 1,
      errorCode: "jev_transport_error",
    });
    expect(await processDueAssessments()).toMatchObject({ processed: 0 });

    vi.setSystemTime(new Date(waiting!.nextAttemptAt!.getTime() + 1));
    await expect(processDueAssessments()).resolves.toMatchObject({ processed: 1, graded: 1 });
    const [graded] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(graded).toMatchObject({
      state: "graded",
      attempts: 2,
      rawScore: 1.4,
      normalizedScore: 0.7,
      confidence: 0.99,
    });
  });

  it("processes only the requested submission revision when answer submission triggers grading", async () => {
    const otherSubmissionId = "00000000-0000-4000-8000-000000000103";
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    await saveAnswerSubmission({
      submissionId: otherSubmissionId,
      operationId: "00000000-0000-4000-8000-000000000104",
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    vi.mocked(gradeFreeResponse).mockResolvedValueOnce({
      score: 1.4,
      confidence: 0.99,
      model: "jev-latest",
    });

    await expect(
      processDueAssessments(false, { submissionId, revision: 1 }),
    ).resolves.toMatchObject({
      processed: 1,
      graded: 1,
    });
    expect(gradeFreeResponse).toHaveBeenCalledTimes(1);
    const assessments = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessments.find((assessment) => assessment.submissionId === submissionId)?.state).toBe(
      "graded",
    );
    expect(
      assessments.find((assessment) => assessment.submissionId === otherSubmissionId)?.state,
    ).toBe("pending");
  });

  it("requeues a terminal failure only when the privileged retry path requests it", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    vi.mocked(gradeFreeResponse).mockRejectedValueOnce(new Error("jev_invalid_response"));
    await expect(processDueAssessments()).resolves.toMatchObject({ failed: 1 });
    const [failed] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(failed).toMatchObject({ state: "failed", attempts: 1, nextAttemptAt: null });
    vi.mocked(gradeFreeResponse).mockResolvedValueOnce({
      score: 1.2,
      confidence: 0.8,
      model: "jev-latest",
    });
    await expect(processDueAssessments()).resolves.toMatchObject({ processed: 0 });
    await expect(processDueAssessments(true)).resolves.toMatchObject({ graded: 1, failed: 0 });
    const [retried] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(retried).toMatchObject({
      state: "graded",
      attempts: 1,
      rawScore: 1.2,
      normalizedScore: 0.6,
    });
  });

  it("rejects a late result after the lease is reclaimed by another worker", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    const oldStartedPromise = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const oldResult = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    vi.mocked(gradeFreeResponse)
      .mockImplementationOnce(async () => {
        oldStarted();
        await oldResult;
        return { score: 0.4, confidence: 0.5, model: "jev-latest" };
      })
      .mockResolvedValueOnce({ score: 1.6, confidence: 0.9, model: "jev-latest" });

    const oldWorker = processDueAssessments();
    await oldStartedPromise;
    const [claimed] = await testDb.db.select().from(schema.examAnswerAssessments);
    vi.setSystemTime(new Date(claimed!.nextAttemptAt!.getTime() + 1));
    await expect(processDueAssessments()).resolves.toMatchObject({ graded: 1 });
    releaseOld();
    await oldWorker;

    const [assessment] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessment).toMatchObject({
      state: "graded",
      rawScore: 1.6,
      normalizedScore: 0.8,
      claimToken: null,
    });
  });

  it("does not apply an assessment after the participant revises the answer revision", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    let releaseGrade!: () => void;
    let gradeStarted!: () => void;
    const gradeStartedPromise = new Promise<void>((resolve) => {
      gradeStarted = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      releaseGrade = resolve;
    });
    vi.mocked(gradeFreeResponse).mockImplementationOnce(async () => {
      gradeStarted();
      await delayed;
      return { score: 1.8, confidence: 1, model: "jev-latest" };
    });
    const oldWorker = processDueAssessments();
    await gradeStartedPromise;
    await saveAnswerSubmission({
      submissionId,
      operationId: "00000000-0000-4000-8000-000000000103",
      expectedRevision: 1,
      participantId,
      answers: [...validAnswers.slice(0, 4), { questionId: 5, freeText: "Revised answer" }],
    });
    releaseGrade();
    await oldWorker;
    const [current] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(current).toMatchObject({
      revision: 2,
      state: "pending",
      answerText: "Revised answer",
      rawScore: null,
      claimToken: null,
    });
  });
});
