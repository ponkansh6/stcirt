import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";

const dbRef = vi.hoisted(() => ({ db: null as TestDb["db"] | null }));
const gradeMock = vi.hoisted(() => vi.fn());
const rubricVersion = vi.hoisted(() => "test-rubric-v1");
const questionVersion = vi.hoisted(() => "tamami-egg-v1");

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
  JEV_QUESTION_VERSION: questionVersion,
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
        questionVersion: id === 5 ? questionVersion : `nagano-00${id}-v1`,
        question: `Q${id}`,
        choices: id === 5 ? [] : ["A", "B", "C", "D"],
        correctIndex: 0,
      })),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    dbRef.db = testDb.db;
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
      questionVersion,
      rubricVersion: JEV_RUBRIC_VERSION,
      state: "pending",
      attempts: 0,
    });
    await expect(testDb.db.select().from(schema.examAnswerSubmissions)).resolves.toMatchObject([
      {
        questionVersions: {
          "1": "nagano-001-v1",
          "2": "nagano-002-v1",
          "3": "nagano-003-v1",
          "4": "nagano-004-v1",
          "5": questionVersion,
        },
      },
    ]);
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

  it("keeps an unsupported Q5 version explicitly unversioned across revisions", async () => {
    await testDb.db
      .update(schema.examQuestions)
      .set({ questionVersion: "omiwatari-v1" })
      .where(eq(schema.examQuestions.id, 5));

    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    const [initial] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(initial).toMatchObject({
      questionVersion: "omiwatari-v1",
      rubricVersion: "unversioned",
      state: "pending",
    });

    await saveAnswerSubmission({
      submissionId,
      operationId: "00000000-0000-4000-8000-000000000105",
      expectedRevision: 1,
      participantId,
      answers: [...validAnswers.slice(0, 4), { questionId: 5, freeText: "Revised answer" }],
    });
    const [revised] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(revised).toMatchObject({
      revision: 2,
      answerText: "Revised answer",
      questionVersion: "omiwatari-v1",
      rubricVersion: "unversioned",
      state: "pending",
      attempts: 0,
    });
  });

  it("records unsupported grader version pairs as terminal unknown-version failures", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    vi.mocked(gradeFreeResponse).mockRejectedValueOnce(
      new Error("Unsupported question/rubric version pair"),
    );

    await expect(processDueAssessments()).resolves.toMatchObject({ processed: 1, failed: 1 });
    const [assessment] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessment).toMatchObject({
      state: "failed",
      errorCode: "jev_unknown_version_pair",
      nextAttemptAt: null,
    });
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
      .mockResolvedValueOnce({ score: 6.3, confidence: 0.99, model: "jev-latest" });
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
      rawScore: 6.3,
      normalizedScore: 0.7,
      confidence: 0.99,
    });
  });

  it("claims no more than five due assessments per worker call with a 45 second lease", async () => {
    const submissionIds = [
      submissionId,
      ...Array.from(
        { length: 5 },
        (_, index) => `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
      ),
    ];
    for (const [index, id] of submissionIds.entries()) {
      await saveAnswerSubmission({
        submissionId: id,
        operationId: `00000000-0000-4000-8000-${String(300 + index).padStart(12, "0")}`,
        expectedRevision: 0,
        participantId,
        answers: validAnswers,
      });
    }
    const now = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.mocked(gradeFreeResponse).mockResolvedValue({
      score: 6,
      confidence: 0.9,
      model: "jev-latest",
    });

    await expect(processDueAssessments()).resolves.toEqual({
      processed: 5,
      graded: 5,
      retried: 0,
      failed: 0,
    });
    expect(gradeFreeResponse).toHaveBeenCalledTimes(5);
    const assessments = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessments).toHaveLength(6);
    expect(assessments.filter((assessment) => assessment.state === "graded")).toHaveLength(5);
    expect(assessments.filter((assessment) => assessment.state === "pending")).toHaveLength(1);
    expect(assessments.find((assessment) => assessment.state === "pending")?.attempts).toBe(0);
  });

  it("persists the exact 45 second lease while a provider call is in flight", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    const now = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(gradeFreeResponse).mockImplementationOnce(async () => {
      started();
      await delayed;
      return { score: 6, confidence: 0.9, model: "jev-latest" };
    });
    const worker = processDueAssessments();
    await startedPromise;
    const [claimed] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(claimed).toMatchObject({ state: "processing", attempts: 1 });
    expect(claimed!.nextAttemptAt).toEqual(new Date(now.getTime() + 45_000));
    release();
    await worker;
  });

  it("uses exponential retry delays and makes the eighth transient attempt terminal", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    const start = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    vi.mocked(gradeFreeResponse).mockRejectedValue(new Error("network down"));

    let now = start;
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await expect(processDueAssessments()).resolves.toMatchObject({ retried: 1, failed: 0 });
      const [assessment] = await testDb.db.select().from(schema.examAnswerAssessments);
      const expectedDelay = Math.min(60 * 60_000, 30_000 * 2 ** (attempt - 1));
      expect(assessment).toMatchObject({ state: "pending", attempts: attempt });
      expect(assessment!.nextAttemptAt).toEqual(new Date(now.getTime() + expectedDelay));
      // SQLite stores timestamp-mode columns at whole-second precision. Keep
      // each subsequent claim exactly on that persisted due-time boundary.
      now = new Date(assessment!.nextAttemptAt!.getTime());
      vi.setSystemTime(now);
    }
    await expect(processDueAssessments()).resolves.toEqual({
      processed: 1,
      graded: 0,
      retried: 0,
      failed: 1,
    });
    const [terminal] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(terminal).toMatchObject({ state: "failed", attempts: 8, nextAttemptAt: null });
    expect(gradeFreeResponse).toHaveBeenCalledTimes(8);
  });

  it("continues to the next due assessment when its claim RETURNING result is hidden", async () => {
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

    let hideClaimResult = true;
    let hiddenClaimResult: unknown;
    let hiddenClaimToken: string | null = null;
    const wrapQuery = (query: object): object =>
      new Proxy(query, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          if (property === "set") {
            return (...args: unknown[]) => {
              const values = args[0] as { claimToken?: unknown } | undefined;
              const result = value.apply(target, args) as object;
              if (hideClaimResult && typeof values?.claimToken === "string") {
                hiddenClaimToken = values.claimToken;
              }
              return wrapQuery(result);
            };
          }
          if (property === "returning") {
            return (...args: unknown[]) => {
              const result = value.apply(target, args) as Promise<unknown>;
              if (!hideClaimResult) return result;
              hideClaimResult = false;
              // Let the conditional update claim the row, then hide its
              // RETURNING result from the worker.
              return result.then((rows) => {
                hiddenClaimResult = rows;
                return [];
              });
            };
          }
          return (...args: unknown[]) => wrapQuery(value.apply(target, args));
        },
      });
    dbRef.db = new Proxy(testDb.db, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "update") {
          return (table: typeof schema.examAnswerAssessments) =>
            wrapQuery(value.call(target, table));
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TestDb["db"];
    vi.mocked(gradeFreeResponse).mockResolvedValueOnce({
      score: 6.3,
      confidence: 0.99,
      model: "jev-latest",
    });

    await expect(processDueAssessments()).resolves.toMatchObject({
      processed: 1,
      graded: 1,
      retried: 0,
      failed: 0,
    });
    expect(gradeFreeResponse).toHaveBeenCalledTimes(1);
    expect(gradeFreeResponse).toHaveBeenCalledWith(
      validAnswers[4] && "freeText" in validAnswers[4] ? validAnswers[4].freeText.trim() : "",
      questionVersion,
      JEV_RUBRIC_VERSION,
    );
    expect(hiddenClaimResult).toHaveLength(1);
    const lostClaimSubmissionId = (hiddenClaimResult as { submissionId: string }[])[0]!
      .submissionId;
    expect([submissionId, otherSubmissionId]).toContain(lostClaimSubmissionId);
    expect(hiddenClaimToken).toEqual(expect.any(String));
    const gradedSubmissionId =
      lostClaimSubmissionId === submissionId ? otherSubmissionId : submissionId;
    const assessments = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessments).toHaveLength(2);
    const assessmentBySubmission = new Map(
      assessments.map((assessment) => [assessment.submissionId, assessment]),
    );
    const gradedAssessment = assessmentBySubmission.get(gradedSubmissionId);
    expect(gradeFreeResponse).toHaveBeenCalledWith(
      gradedAssessment!.answerText,
      gradedAssessment!.questionVersion,
      gradedAssessment!.rubricVersion,
    );
    expect(assessmentBySubmission.get(lostClaimSubmissionId)).toMatchObject({
      submissionId: lostClaimSubmissionId,
      questionId: 5,
      revision: 1,
      answerText: "上司に確認し、承認済み環境を使います。",
      state: "processing",
      attempts: 1,
      claimToken: hiddenClaimToken,
      nextAttemptAt: expect.any(Date),
      rawScore: null,
      normalizedScore: null,
      confidence: null,
      model: null,
      gradedAt: null,
      errorCode: null,
    });
    expect(gradedAssessment).toMatchObject({
      submissionId: gradedSubmissionId,
      questionId: 5,
      revision: 1,
      answerText: "上司に確認し、承認済み環境を使います。",
      questionVersion,
      rubricVersion: JEV_RUBRIC_VERSION,
      state: "graded",
      attempts: 1,
      claimToken: null,
      rawScore: 6.3,
      normalizedScore: 0.7,
      confidence: 0.99,
      model: "jev-latest",
      nextAttemptAt: null,
      errorCode: null,
    });
  });

  it("ignores a provider failure after another worker has replaced its claim", async () => {
    await saveAnswerSubmission({
      submissionId,
      operationId,
      expectedRevision: 0,
      participantId,
      answers: validAnswers,
    });
    const competingClaimToken = "00000000-0000-4000-8000-000000000105";
    vi.mocked(gradeFreeResponse).mockImplementationOnce(async () => {
      await testDb.db
        .update(schema.examAnswerAssessments)
        .set({ claimToken: competingClaimToken })
        .where(eq(schema.examAnswerAssessments.submissionId, submissionId));
      throw new Error("network down");
    });

    await expect(processDueAssessments()).resolves.toEqual({
      processed: 0,
      graded: 0,
      retried: 0,
      failed: 0,
    });
    const [assessment] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessment).toMatchObject({
      state: "processing",
      attempts: 1,
      claimToken: competingClaimToken,
      errorCode: null,
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
      score: 6.3,
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
      score: 5.4,
      confidence: 0.8,
      model: "jev-latest",
    });
    await expect(processDueAssessments()).resolves.toMatchObject({ processed: 0 });
    await expect(processDueAssessments(true)).resolves.toMatchObject({ graded: 1, failed: 0 });
    const [retried] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(retried).toMatchObject({
      state: "graded",
      attempts: 1,
      rawScore: 5.4,
    });
    expect(retried!.normalizedScore).toBeCloseTo(0.6);
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
      .mockResolvedValueOnce({ score: 7.2, confidence: 0.9, model: "jev-latest" });

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
      rawScore: 7.2,
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
