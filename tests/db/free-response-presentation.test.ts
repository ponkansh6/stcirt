import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";

const dbRef = vi.hoisted(() => ({ db: null as TestDb["db"] | null }));
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

import {
  getPublicPresentation,
  operatePresentation,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";
import { saveAnswerSubmission } from "@/lib/db/repository/answer-repository";

const answerSet = [1, 2, 3, 4].map((questionId) => ({ questionId, selectedIndex: 0 }));

describe("free-response presentation scoring and immutable snapshots", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.presentationOperations);
    await testDb.db.delete(schema.presentationQuestions);
    await testDb.db.delete(schema.presentationEntries);
    await testDb.db.delete(schema.presentationSessions);
    await testDb.db.delete(schema.examAnswerAssessments);
    await testDb.db.delete(schema.examSubmissionOperations);
    await testDb.db.delete(schema.examSubmissionAnswers);
    await testDb.db.delete(schema.examAnswerSubmissions);
    await testDb.db.delete(schema.examParticipants);
    await testDb.db.delete(schema.examQuestions);
    await testDb.db.insert(schema.examQuestions).values(
      [1, 2, 3, 4, 5].map((id) => ({
        id,
        key: `it-literacy-00${id}`,
        question: `Question ${id}`,
        choices: id === 5 ? [] : ["correct", "incorrect"],
        correctIndex: 0,
        explanation: id === 5 ? "Fifth model answer" : `Explanation ${id}`,
      })),
    );
  });

  afterEach(() => testDb.cleanup());

  async function addParticipant(name: string) {
    const [participant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: name, displayName: name })
      .returning({ id: schema.examParticipants.id });
    return participant!.id;
  }

  async function addFreeTextSubmission(participantId: number, rawScore: number, suffix: string) {
    const submissionId = `free-${participantId}-${suffix}`;
    await saveAnswerSubmission({
      submissionId,
      operationId: `operation-${participantId}-${suffix}`,
      expectedRevision: 0,
      participantId,
      answers: [...answerSet, { questionId: 5, freeText: `answer ${suffix}` }],
    });
    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({
        state: "graded",
        rawScore,
        normalizedScore: rawScore / 2,
        confidence: 0.01,
        model: "test-model",
        gradedAt: new Date(),
        nextAttemptAt: null,
      })
      .where(eq(schema.examAnswerAssessments.submissionId, submissionId));
  }

  it("adds score divided by two at full precision and ranks before display rounding", async () => {
    const first = await addParticipant("fractional-one");
    const second = await addParticipant("fractional-two");
    await addFreeTextSubmission(first, 1.5, "one");
    await addFreeTextSubmission(second, 1.499, "two");

    const presentation = await operatePresentation("fraction-start", "start");
    expect(presentation.entries).toEqual([
      expect.objectContaining({ displayName: "fractional-one", score: 4.75, rank: 1 }),
      expect.objectContaining({ displayName: "fractional-two", score: 4.7495, rank: 2 }),
    ]);
    expect(presentation.entries[0]!.score.toFixed(2)).toBe(
      presentation.entries[1]!.score.toFixed(2),
    );
    expect(presentation.entries[0]!.answers).toContainEqual(
      expect.objectContaining({
        questionId: 5,
        answerKind: "freeText",
        rawScore: 1.5,
        normalizedScore: 0.75,
      }),
    );
  });

  it("suppresses responses only when the source key still identifies question five", async () => {
    const participantId = await addParticipant("question-five-identity");
    await addFreeTextSubmission(participantId, 1, "identity");
    await operatePresentation("question-five-identity-start", "start");
    for (let index = 0; index < 9; index += 1)
      await operatePresentation(`question-five-identity-forward-${index}`, "advance");
    const fifthAnswer = await getPublicPresentation();
    expect(fifthAnswer).toMatchObject({ state: "answer", question: { ordinal: 5 } });
    if (fifthAnswer.state === "answer" && fifthAnswer.question?.answerType === "freeText")
      expect(fifthAnswer.question).not.toHaveProperty("responses");

    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "renamed-question" })
      .where(eq(schema.examQuestions.id, 5));
    const renamedAnswer = await getPublicPresentation();
    const renamedQuestion = renamedAnswer.state === "answer" ? renamedAnswer.question : undefined;
    expect(renamedQuestion).toHaveProperty("responses");
    if (renamedQuestion && "responses" in renamedQuestion)
      expect(renamedQuestion.responses).toHaveLength(1);
  });

  it("retains fifth-question responses when the source row is missing", async () => {
    const participantId = await addParticipant("missing-source");
    await addFreeTextSubmission(participantId, 1, "missing-source");
    await operatePresentation("missing-source-start", "start");
    for (let index = 0; index < 9; index += 1)
      await operatePresentation(`missing-source-forward-${index}`, "advance");
    await testDb.db.delete(schema.examQuestions).where(eq(schema.examQuestions.id, 5));

    const projection = await getPublicPresentation();
    const question = projection.state === "answer" ? projection.question : undefined;
    expect(question).toHaveProperty("responses");
    if (question && "responses" in question) expect(question.responses).toHaveLength(1);
  });

  it("keeps response data for an unrelated free-text answer stage", async () => {
    const participantId = await addParticipant("other-free-text-source");
    await addFreeTextSubmission(participantId, 1, "other-free-text-source");
    await testDb.db
      .update(schema.examQuestions)
      .set({ choices: [] })
      .where(eq(schema.examQuestions.id, 3));
    await operatePresentation("other-free-text-start", "start");
    for (let index = 0; index < 5; index += 1)
      await operatePresentation(`other-free-text-forward-${index}`, "advance");

    const projection = await getPublicPresentation();
    expect(projection).toMatchObject({ state: "answer", question: { ordinal: 3 } });
    const question = projection.state === "answer" ? projection.question : undefined;
    if (question && "responses" in question) expect(question.responses).toHaveLength(1);
  });

  it.each(["pending", "failed", "stale"] as const)(
    "blocks start for a %s or revision-mismatched assessment",
    async (caseName) => {
      const participantId = await addParticipant(`blocked-${caseName}`);
      await addFreeTextSubmission(participantId, 1.2, caseName);
      if (caseName !== "stale") {
        await testDb.db
          .update(schema.examAnswerAssessments)
          .set({ state: caseName })
          .where(
            eq(schema.examAnswerAssessments.submissionId, `free-${participantId}-${caseName}`),
          );
      } else {
        await testDb.db
          .update(schema.examAnswerAssessments)
          .set({ revision: 0 })
          .where(
            eq(schema.examAnswerAssessments.submissionId, `free-${participantId}-${caseName}`),
          );
      }

      await expect(
        operatePresentation(`blocked-start-${caseName}`, "start"),
      ).rejects.toBeInstanceOf(PresentationConflictError);
      await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toHaveLength(0);
    },
  );

  it("snapshots explicit legacy separately from unanswered without inventing a legacy answer", async () => {
    const legacyId = await addParticipant("Legacy");
    await addParticipant("Unanswered");
    const submissionId = `legacy-${legacyId}`;
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId: legacyId,
      questionIds: [1, 2, 3, 4, 5],
      revision: 1,
    });
    await testDb.db.insert(schema.examSubmissionAnswers).values([
      ...answerSet.map((answer) => ({
        submissionId,
        questionId: answer.questionId,
        answerKind: "selected",
        selectedIndex: answer.selectedIndex,
      })),
      { submissionId, questionId: 5, answerKind: "legacy", selectedIndex: 1 },
    ]);
    const started = await operatePresentation("legacy-snapshot-start", "start");
    expect(started.entries.find(({ displayName }) => displayName === "Legacy")).toMatchObject({
      score: 4,
    });
    expect(
      started.entries.find(({ displayName }) => displayName === "Legacy")?.answers,
    ).toContainEqual(
      expect.objectContaining({
        questionId: 5,
        answerKind: "legacy",
        selectedIndex: 1,
        rawScore: null,
      }),
    );
    expect(
      started.entries.find(({ displayName }) => displayName === "Unanswered")?.answers,
    ).toContainEqual(
      expect.objectContaining({ questionId: 5, answerKind: "unanswered", selectedIndex: null }),
    );

    const examQuestionStage = await getPublicPresentation();
    expect(examQuestionStage).toMatchObject({ state: "question" });
    expect(JSON.stringify(examQuestionStage)).not.toMatch(
      /score|confidence|rubric|assessment|answer_match|probabilities/i,
    );
    for (let index = 0; index < 8; index += 1)
      await operatePresentation(`legacy-next-${index}`, "advance");
    const fifthQuestionStage = await getPublicPresentation();
    expect(fifthQuestionStage).toMatchObject({ state: "question", question: { ordinal: 5 } });
    expect(JSON.stringify(fifthQuestionStage)).not.toMatch(
      /score|confidence|rubric|assessment|answer_match|probabilities/i,
    );
    await operatePresentation("legacy-next-answer", "advance");
    const answer = await getPublicPresentation();
    expect(answer).toMatchObject({
      state: "answer",
      question: { answerType: "freeText", expectedAnswer: "Fifth model answer" },
    });
    expect(answer.question).not.toHaveProperty("responses");
    expect(JSON.stringify(answer)).not.toMatch(
      /confidence|rubric|assessment|answer_match|probabilities|usage/i,
    );
  });
});
