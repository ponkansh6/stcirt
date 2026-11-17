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
  getAdminPresentationDeck,
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
        questionVersion: id === 5 ? "hong-kong-trip-a-b-v3" : `nagano-00${id}-v1`,
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
      answers: [
        ...answerSet,
        { questionId: 5, freeTextParts: { a: `answer ${suffix}`, b: `answer ${suffix}` } },
      ],
    });
    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({
        state: "graded",
        rawScore,
        normalizedScore: rawScore,
        confidence: 0.01,
        model: "test-model",
        gradedAt: new Date(),
        nextAttemptAt: null,
      })
      .where(eq(schema.examAnswerAssessments.submissionId, submissionId));
  }

  async function startWithAggregate(operationId: string) {
    await operatePresentation(`${operationId}-aggregate`, "aggregate");
    return operatePresentation(operationId, "start");
  }

  it("adds score divided by two at full precision and ranks before display rounding", async () => {
    const first = await addParticipant("fractional-one");
    const second = await addParticipant("fractional-two");
    await addFreeTextSubmission(first, 1.5, "one");
    await addFreeTextSubmission(second, 1.499, "two");

    const presentation = await startWithAggregate("fraction-start");
    expect(presentation.entries).toEqual([
      expect.objectContaining({ displayName: "fractional-one", score: 5.5, rank: 1 }),
      expect.objectContaining({
        displayName: "fractional-two",
        score: 5.4990000000000006,
        rank: 2,
      }),
    ]);
    expect(presentation.entries[0]!.score.toFixed(2)).toBe(
      presentation.entries[1]!.score.toFixed(2),
    );
    expect(presentation.entries[0]!.answers).toContainEqual(
      expect.objectContaining({
        questionId: 5,
        answerKind: "freeText",
        rawScore: 1.5,
        normalizedScore: 1.5,
      }),
    );
    for (let index = 0; index < 17; index += 1)
      await operatePresentation(`fraction-rank-forward-${index}`, "advance");
    let winnerProjection = await getPublicPresentation();
    expect(winnerProjection).toMatchObject({
      state: "second",
      winners: [{ displayName: "fractional-two" }],
    });
    await operatePresentation("fraction-rank-forward-first", "advance");
    winnerProjection = await getPublicPresentation();
    expect(winnerProjection).toMatchObject({
      state: "first",
      winners: [{ displayName: "fractional-one" }],
    });
    if (winnerProjection.state === "first")
      expect(winnerProjection.winners[0]?.questionResults[4]).toMatchObject({
        position: 4,
        answer: { kind: "freeText", value: "A: answer one\nB: answer one" },
        normalizedScore: 1.5,
      });
    expect(JSON.stringify(winnerProjection)).not.toContain('"rawScore"');
  });

  it("keeps normalized zero distinct from a null ungraded snapshot score", async () => {
    const participantId = await addParticipant("zero-normalized-score");
    const maximumParticipantId = await addParticipant("maximum-normalized-score");
    await addFreeTextSubmission(participantId, 0, "zero");
    await addFreeTextSubmission(maximumParticipantId, 2, "maximum");
    await startWithAggregate("zero-score-start");
    for (let index = 0; index < 17; index += 1)
      await operatePresentation(`zero-score-forward-${index}`, "advance");

    let projection = await getPublicPresentation();
    if (projection.state !== "second") throw new Error("Expected second-rank projection");
    expect(projection.winners[0]).toMatchObject({ displayName: "zero-normalized-score" });
    expect(projection.winners[0]?.questionResults[4]).toMatchObject({
      answer: { kind: "freeText", value: "A: answer zero\nB: answer zero" },
      normalizedScore: 0,
    });

    const [entry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, participantId));
    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: entry!.answers.map((answer) =>
          answer.questionId === 5 ? { ...answer, normalizedScore: null } : answer,
        ),
      })
      .where(eq(schema.presentationEntries.participantId, participantId));
    projection = await getPublicPresentation();
    if (projection.state !== "second") throw new Error("Expected second-rank projection");
    expect(projection.winners[0]?.questionResults[4]).toMatchObject({
      answer: { kind: "freeText", value: "A: answer zero\nB: answer zero" },
      normalizedScore: null,
    });

    await operatePresentation("zero-score-to-first", "advance");
    projection = await getPublicPresentation();
    if (projection.state !== "first") throw new Error("Expected first-rank projection");
    expect(projection.winners[0]).toMatchObject({ displayName: "maximum-normalized-score" });
    expect(projection.winners[0]?.questionResults[4]).toMatchObject({
      answer: { kind: "freeText", value: "A: answer maximum\nB: answer maximum" },
      normalizedScore: 2,
    });
  });

  it("bins free-text scores at every inclusive half-point boundary without exposing unanswered counts", async () => {
    const values = [0, 0.5, 0.51, 1, 1.5, 2];
    const participants = await Promise.all(
      values.map((_, index) => addParticipant(`range-${index}`)),
    );
    const ungradedParticipant = await addParticipant("ungraded");
    await addParticipant("unanswered");
    for (let index = 0; index < values.length; index += 1) {
      await addFreeTextSubmission(participants[index]!, values[index]!, `range-${index}`);
    }
    await addFreeTextSubmission(ungradedParticipant, 1, "ungraded");
    await startWithAggregate("range-boundary-start");
    const [ungradedEntry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, ungradedParticipant));
    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: ungradedEntry!.answers.map((answer) =>
          answer.questionId === 5 ? { ...answer, normalizedScore: null } : answer,
        ),
      })
      .where(eq(schema.presentationEntries.participantId, ungradedParticipant));
    for (let index = 0; index < 15; index += 1)
      await operatePresentation(`range-boundary-forward-${index}`, "advance");

    const projection = await getPublicPresentation();
    expect(projection).toMatchObject({
      state: "statistics",
      question: { ordinal: 5 },
      statistics: {
        kind: "freeText",
        participantCount: 8,
        gradedCount: 6,
        ungradedCount: 1,
        uncountableCount: 0,
        ranges: [
          { label: "0点", count: 1 },
          { label: "0点超〜0.5点", count: 1 },
          { label: "0.5点超〜1点", count: 2 },
          { label: "1点超〜1.5点", count: 1 },
          { label: "1.5点超〜2点", count: 1 },
        ],
      },
    });
    expect(JSON.stringify(projection)).not.toContain("unanswered");
    expect(JSON.stringify(projection)).not.toContain("rawScore");
    expect(JSON.stringify(projection)).not.toContain("range-0");
  });

  it("classifies malformed free-text content with a zero score as uncountable", async () => {
    const participantId = await addParticipant("malformed-q5-content");
    await addFreeTextSubmission(participantId, 0, "malformed-content");
    await startWithAggregate("malformed-q5-content-start");
    const [entry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, participantId));
    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: entry!.answers.map((answer) =>
          answer.questionId === 5
            ? {
                ...answer,
                freeText: "A:  \nB: valid",
                freeTextParts: { a: "  ", b: "valid" },
                normalizedScore: 0,
              }
            : answer,
        ),
      })
      .where(eq(schema.presentationEntries.participantId, participantId));
    for (let index = 0; index < 15; index += 1)
      await operatePresentation(`malformed-q5-content-forward-${index}`, "advance");

    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "statistics",
      statistics: {
        kind: "freeText",
        participantCount: 1,
        gradedCount: 0,
        ungradedCount: 0,
        uncountableCount: 1,
        ranges: [
          { label: "0点", count: 0 },
          { label: "0点超〜0.5点", count: 0 },
          { label: "0.5点超〜1点", count: 0 },
          { label: "1点超〜1.5点", count: 0 },
          { label: "1.5点超〜2点", count: 0 },
        ],
      },
    });
  });

  it("classifies valid Q5 parts with a mismatched formatted text as uncountable", async () => {
    const participantId = await addParticipant("mismatched-q5-content");
    await addFreeTextSubmission(participantId, 0, "mismatched-content");
    await startWithAggregate("mismatched-q5-content-start");
    const [entry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, participantId));
    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: entry!.answers.map((answer) =>
          answer.questionId === 5
            ? { ...answer, freeText: "A: different\nB: different", normalizedScore: 0 }
            : answer,
        ),
      })
      .where(eq(schema.presentationEntries.participantId, participantId));
    for (let index = 0; index < 15; index += 1)
      await operatePresentation(`mismatched-q5-content-forward-${index}`, "advance");

    await expect(getPublicPresentation()).resolves.toMatchObject({
      state: "statistics",
      statistics: {
        kind: "freeText",
        participantCount: 1,
        gradedCount: 0,
        ungradedCount: 0,
        uncountableCount: 1,
        ranges: [
          { label: "0点", count: 0 },
          { label: "0点超〜0.5点", count: 0 },
          { label: "0.5点超〜1点", count: 0 },
          { label: "1点超〜1.5点", count: 0 },
          { label: "1.5点超〜2点", count: 0 },
        ],
      },
    });
  });

  it("keeps Q5 statistics fixed when the source question key changes after aggregation", async () => {
    const participantId = await addParticipant("snapshot-q5-key");
    await addFreeTextSubmission(participantId, 1, "snapshot-key");
    await startWithAggregate("snapshot-q5-key-start");
    for (let index = 0; index < 15; index += 1)
      await operatePresentation(`snapshot-q5-key-forward-${index}`, "advance");
    const before = await getPublicPresentation();
    expect(before).toMatchObject({
      state: "statistics",
      statistics: { kind: "freeText", gradedCount: 1, uncountableCount: 0 },
    });
    const deckBefore = await getAdminPresentationDeck();
    const q5StatisticsBefore = deckBefore.slides.find(
      (slide) => slide.state === "statistics" && slide.questionIndex === 4,
    )?.projection;
    const q5AnswerBefore = deckBefore.slides.find(
      (slide) => slide.state === "answer" && slide.questionIndex === 4,
    )?.projection;
    expect(q5StatisticsBefore).toMatchObject({
      state: "statistics",
      statistics: { kind: "freeText", gradedCount: 1, uncountableCount: 0 },
    });
    expect(q5AnswerBefore).not.toHaveProperty("question.responses");

    await testDb.db
      .update(schema.examQuestions)
      .set({ key: "renamed-after-aggregate" })
      .where(eq(schema.examQuestions.id, 5));

    await expect(getPublicPresentation()).resolves.toEqual(before);
    const deckAfter = await getAdminPresentationDeck();
    const q5StatisticsAfter = deckAfter.slides.find(
      (slide) => slide.state === "statistics" && slide.questionIndex === 4,
    )?.projection;
    const q5AnswerAfter = deckAfter.slides.find(
      (slide) => slide.state === "answer" && slide.questionIndex === 4,
    )?.projection;
    expect(q5StatisticsAfter).toEqual(q5StatisticsBefore);
    expect(q5AnswerAfter).toEqual(q5AnswerBefore);
  });

  it("keeps Q5 response privacy and score identity fixed by the question snapshot", async () => {
    const participantId = await addParticipant("question-five-identity");
    await addFreeTextSubmission(participantId, 1, "identity");
    await startWithAggregate("question-five-identity-start");
    for (let index = 0; index < 14; index += 1)
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
    expect(renamedQuestion).not.toHaveProperty("responses");
    await operatePresentation("question-five-identity-rank-forward-1", "advance");
    await operatePresentation("question-five-identity-rank-forward-2", "advance");
    await operatePresentation("question-five-identity-rank-forward-3", "advance");
    const renamedWinner = await getPublicPresentation();
    const fifthResult =
      renamedWinner.state === "first" ? renamedWinner.winners[0]?.questionResults[4] : undefined;
    expect(fifthResult).toMatchObject({
      answer: { kind: "freeText", value: "A: answer identity\nB: answer identity" },
      normalizedScore: 1,
    });
  });

  it("keeps Q5 response privacy when the source row is missing", async () => {
    const participantId = await addParticipant("missing-source");
    await addFreeTextSubmission(participantId, 1, "missing-source");
    await startWithAggregate("missing-source-start");
    for (let index = 0; index < 14; index += 1)
      await operatePresentation(`missing-source-forward-${index}`, "advance");
    await testDb.db.delete(schema.examQuestions).where(eq(schema.examQuestions.id, 5));

    const projection = await getPublicPresentation();
    const question = projection.state === "answer" ? projection.question : undefined;
    expect(question).not.toHaveProperty("responses");
    await operatePresentation("missing-source-rank-forward-1", "advance");
    await operatePresentation("missing-source-rank-forward-2", "advance");
    await operatePresentation("missing-source-rank-forward-3", "advance");
    const winnerProjection = await getPublicPresentation();
    const fifthResult =
      winnerProjection.state === "first"
        ? winnerProjection.winners[0]?.questionResults[4]
        : undefined;
    expect(fifthResult).toMatchObject({
      answer: { kind: "freeText", value: "A: answer missing-source\nB: answer missing-source" },
      normalizedScore: 1,
    });
  });

  it("keeps response data for an unrelated free-text answer stage", async () => {
    const participantId = await addParticipant("other-free-text-source");
    await addFreeTextSubmission(participantId, 1, "other-free-text-source");
    await startWithAggregate("other-free-text-start");
    await testDb.db
      .update(schema.presentationQuestions)
      .set({ choices: [] })
      .where(eq(schema.presentationQuestions.position, 2));
    for (let index = 0; index < 8; index += 1)
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

      await testDb.db.insert(schema.presentationSessions).values({
        id: 1,
        state: "not_started",
        version: 0,
        questionIndex: 0,
        questionCount: 0,
        projectionHidden: false,
      });
      const sessionBefore = await testDb.db.select().from(schema.presentationSessions);
      expect(sessionBefore).toHaveLength(1);
      expect(sessionBefore[0]).toMatchObject({
        state: "not_started",
        version: 0,
        snapshotRevision: 0,
      });
      await expect(
        operatePresentation(`blocked-start-${caseName}`, "start"),
      ).rejects.toBeInstanceOf(PresentationConflictError);
      await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toEqual(
        sessionBefore,
      );
    },
  );

  it("rejects aggregation when a submission has a legacy Q5 answer", async () => {
    const legacyId = await addParticipant("Legacy");
    await addParticipant("Unanswered");
    const submissionId = `legacy-${legacyId}`;
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId: legacyId,
      questionIds: [1, 2, 3, 4, 5],
      questionVersions: {
        "1": "nagano-001-v1",
        "2": "nagano-002-v1",
        "3": "nagano-003-v1",
        "4": "nagano-004-v1",
        "5": "hong-kong-trip-a-b-v3",
      },
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
    const sessionBefore = await testDb.db.select().from(schema.presentationSessions);
    await expect(operatePresentation("legacy-q5-aggregate", "aggregate")).rejects.toBeInstanceOf(
      PresentationConflictError,
    );
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toEqual(
      sessionBefore,
    );
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toHaveLength(0);
  });
});
