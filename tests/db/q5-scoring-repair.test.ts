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

import { repairQ5Scoring } from "@/lib/db/repository/q5-scoring-repair";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";
import { parseParticipantResult } from "@/lib/participant-results-contract";
import { JEV_RUBRIC_VERSION, JEV_QUESTION_VERSION } from "@/lib/jev/adapter";

const LEGACY_RUBRIC = "jev-q5-lobster-french-toast-independent-points-v2";
const CURRENT_QUESTION_VERSION = "hong-kong-trip-a-b-v4";

describe("Q5 half-point scoring repair", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.presentationOperations);
    await testDb.db.delete(schema.presentationQuestions);
    await testDb.db.delete(schema.presentationEntries);
    await testDb.db.delete(schema.presentationSessions);
    await testDb.db.delete(schema.participantResultSettings);
    await testDb.db.delete(schema.examAnswerAssessments);
    await testDb.db.delete(schema.examAnswerSubmissions);
    await testDb.db.delete(schema.examQuestions);
    await testDb.db.delete(schema.examParticipants);
  });

  afterEach(() => testDb.cleanup());

  async function seedLegacySnapshot() {
    await testDb.db.insert(schema.examQuestions).values({
      id: 5,
      key: "it-literacy-005",
      questionVersion: CURRENT_QUESTION_VERSION,
      question: "Question 5",
      choices: [],
      correctIndex: 0,
      explanation: "Model answer",
    });
    const participants = await testDb.db
      .insert(schema.examParticipants)
      .values([
        { normalizedName: "rank-a", displayName: "Rank A" },
        { normalizedName: "rank-b", displayName: "Rank B" },
        { normalizedName: "reference", displayName: "Reference" },
      ])
      .returning({ id: schema.examParticipants.id });
    const [a, b, reference] = participants.map(({ id }) => id);

    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: "legacy-assessment-submission",
      participantId: a!,
      questionIds: [1, 2, 3, 4, 5],
      questionVersions: { "5": CURRENT_QUESTION_VERSION },
      revision: 1,
    });
    await testDb.db.insert(schema.examAnswerAssessments).values({
      submissionId: "legacy-assessment-submission",
      questionId: 5,
      revision: 1,
      answerText: JSON.stringify({ a: "A answer", b: "B answer" }),
      questionVersion: JEV_QUESTION_VERSION,
      state: "graded",
      rawScore: 4.5,
      normalizedScore: 0.11,
      confidence: 0.8,
      model: "test-model",
      rubricVersion: LEGACY_RUBRIC,
    });

    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "finished",
      version: 8,
      questionIndex: 4,
      questionCount: 5,
      snapshotRevision: 3,
      questionVersions: {
        "1": "question-1-v1",
        "2": "question-2-v1",
        "3": "question-3-v1",
        "4": "question-4-v1",
        "5": CURRENT_QUESTION_VERSION,
      },
      rubricVersions: {
        "1": "single-choice-v1",
        "2": "single-choice-v1",
        "3": "single-choice-v1",
        "4": "single-choice-v1",
        "5": LEGACY_RUBRIC,
      },
    });
    await testDb.db.insert(schema.presentationQuestions).values(
      [1, 2, 3, 4, 5].map((sourceQuestionId, position) => ({
        sessionId: 1,
        position,
        sourceQuestionId,
        sourceQuestionKey:
          sourceQuestionId === 5 ? "it-literacy-005" : `question-${sourceQuestionId}`,
        question: `Question ${sourceQuestionId}`,
        choices: sourceQuestionId === 5 ? [] : ["correct", "incorrect"],
        correctIndex: 0,
        correctIndices: null,
        selectionMode: "single" as const,
        explanation: null,
      })),
    );

    const answersFor = (participantId: number, q5Score: number) =>
      [1, 2, 3, 4, 5].map((questionId) => ({
        questionId,
        answerKind: questionId === 5 ? ("freeText" as const) : ("selected" as const),
        selectedIndex: questionId === 5 ? null : 0,
        freeText: questionId === 5 ? `A: ${participantId}\nB: ${participantId}` : null,
        rawScore: questionId === 5 ? q5Score * 9 : null,
        normalizedScore: questionId === 5 ? q5Score : null,
      }));

    await testDb.db.insert(schema.presentationEntries).values([
      {
        sessionId: 1,
        participantId: a!,
        displayName: "Rank A",
        score: 5,
        rank: 1,
        isAggregationTarget: true,
        isReference: false,
        equivalentRank: null,
        answers: answersFor(a!, 2),
      },
      {
        sessionId: 1,
        participantId: b!,
        displayName: "Rank B",
        score: 4.5,
        rank: 2,
        isAggregationTarget: true,
        isReference: false,
        equivalentRank: null,
        answers: answersFor(b!, 0.5),
      },
      {
        sessionId: 1,
        participantId: reference!,
        displayName: "Reference",
        score: 6,
        rank: null,
        isAggregationTarget: true,
        isReference: true,
        equivalentRank: 1,
        answers: answersFor(reference!, 2),
      },
    ]);
    await testDb.db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: true,
      everPublished: true,
    });

    return { a: a!, b: b!, reference: reference! };
  }

  async function expectAtomicRepairRejection(mutate: () => Promise<unknown>, message: RegExp) {
    await seedLegacySnapshot();
    await mutate();
    const sessionsBefore = await testDb.db.select().from(schema.presentationSessions);
    const assessmentsBefore = await testDb.db.select().from(schema.examAnswerAssessments);
    const entriesBefore = await testDb.db.select().from(schema.presentationEntries);

    await expect(repairQ5Scoring({ apply: true })).rejects.toThrow(message);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toEqual(
      sessionsBefore,
    );
    await expect(testDb.db.select().from(schema.examAnswerAssessments)).resolves.toEqual(
      assessmentsBefore,
    );
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toEqual(
      entriesBefore,
    );
  }

  it("dry-runs and atomically repairs old scores, recomputes ranks, and is idempotent", async () => {
    const ids = await seedLegacySnapshot();
    const sessionBefore = await testDb.db.select().from(schema.presentationSessions);
    const assessmentsBefore = await testDb.db.select().from(schema.examAnswerAssessments);
    const entriesBefore = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .orderBy(schema.presentationEntries.participantId);

    await expect(repairQ5Scoring()).resolves.toMatchObject({
      assessmentCount: 1,
      snapshotCount: 1,
      entryCount: 3,
      applied: false,
    });
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toEqual(
      sessionBefore,
    );
    await expect(testDb.db.select().from(schema.examAnswerAssessments)).resolves.toEqual(
      assessmentsBefore,
    );
    await expect(
      testDb.db
        .select()
        .from(schema.presentationEntries)
        .orderBy(schema.presentationEntries.participantId),
    ).resolves.toEqual(entriesBefore);

    await expect(repairQ5Scoring({ apply: true })).resolves.toMatchObject({
      assessmentCount: 1,
      snapshotCount: 1,
      entryCount: 3,
      applied: true,
    });
    const [sessionAfter] = await testDb.db.select().from(schema.presentationSessions);
    expect(sessionAfter).toMatchObject({
      state: "finished",
      version: 9,
      questionIndex: 4,
      questionCount: 5,
      snapshotRevision: 4,
      questionVersions: sessionBefore[0]!.questionVersions,
      rubricVersions: {
        "1": "single-choice-v1",
        "2": "single-choice-v1",
        "3": "single-choice-v1",
        "4": "single-choice-v1",
        "5": JEV_RUBRIC_VERSION,
      },
    });
    await expect(testDb.db.select().from(schema.examAnswerAssessments)).resolves.toMatchObject([
      {
        normalizedScore: 0.055,
        rubricVersion: JEV_RUBRIC_VERSION,
        state: "graded",
      },
    ]);

    const entriesAfter = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .orderBy(schema.presentationEntries.participantId);
    expect(entriesAfter).toEqual([
      expect.objectContaining({
        participantId: ids.a,
        score: 4,
        rank: 2,
        isAggregationTarget: true,
        isReference: false,
        equivalentRank: null,
        answers: expect.arrayContaining([
          expect.objectContaining({ questionId: 5, normalizedScore: 1 }),
        ]),
      }),
      expect.objectContaining({
        participantId: ids.b,
        score: 4.25,
        rank: 1,
        isAggregationTarget: true,
        isReference: false,
        equivalentRank: null,
        answers: expect.arrayContaining([
          expect.objectContaining({ questionId: 5, normalizedScore: 0.25 }),
        ]),
      }),
      expect.objectContaining({
        participantId: ids.reference,
        score: 5,
        rank: null,
        isAggregationTarget: true,
        isReference: true,
        equivalentRank: 1,
        answers: expect.arrayContaining([
          expect.objectContaining({ questionId: 5, normalizedScore: 1 }),
        ]),
      }),
    ]);
    const result = await getParticipantResult(ids.a);
    expect(result).toMatchObject({ state: "visible", score: 4, maxScore: 5 });
    expect(parseParticipantResult(result)).toEqual(result);

    await expect(repairQ5Scoring({ apply: true })).resolves.toMatchObject({
      assessmentCount: 0,
      snapshotCount: 0,
      entryCount: 0,
      applied: true,
    });
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toEqual(
      entriesAfter,
    );
  });

  it("rejects a malformed legacy score without changing any repaired rows", async () => {
    await seedLegacySnapshot();
    const [entry] = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, 1));
    await testDb.db
      .update(schema.presentationEntries)
      .set({
        answers: entry!.answers.map((answer) =>
          answer.questionId === 5 ? { ...answer, normalizedScore: -0.1 } : answer,
        ),
      })
      .where(eq(schema.presentationEntries.participantId, 1));
    const sessionBefore = await testDb.db.select().from(schema.presentationSessions);
    const entriesBefore = await testDb.db.select().from(schema.presentationEntries);
    const assessmentsBefore = await testDb.db.select().from(schema.examAnswerAssessments);

    await expect(repairQ5Scoring({ apply: true })).rejects.toThrow(/invalid.*Q5.*score/i);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toEqual(
      sessionBefore,
    );
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toEqual(
      entriesBefore,
    );
    await expect(testDb.db.select().from(schema.examAnswerAssessments)).resolves.toEqual(
      assessmentsBefore,
    );
  });

  it.each(["pending", "failed"] as const)(
    "converts a retained %s legacy score from the old scale",
    async (state) => {
      await seedLegacySnapshot();
      await testDb.db
        .update(schema.examAnswerAssessments)
        .set({ state, normalizedScore: 1.8 })
        .where(eq(schema.examAnswerAssessments.submissionId, "legacy-assessment-submission"));

      await expect(repairQ5Scoring({ apply: true })).resolves.toMatchObject({
        assessmentCount: 1,
        applied: true,
      });
      await expect(testDb.db.select().from(schema.examAnswerAssessments)).resolves.toMatchObject([
        { state, normalizedScore: 0.9, rubricVersion: JEV_RUBRIC_VERSION },
      ]);
    },
  );

  it.each(["pending", "failed"] as const)("keeps a null %s score null", async (state) => {
    await seedLegacySnapshot();
    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({ state, normalizedScore: null })
      .where(eq(schema.examAnswerAssessments.submissionId, "legacy-assessment-submission"));

    await expect(repairQ5Scoring({ apply: true })).resolves.toMatchObject({
      assessmentCount: 1,
      applied: true,
    });
    await expect(testDb.db.select().from(schema.examAnswerAssessments)).resolves.toMatchObject([
      { state, normalizedScore: null, rubricVersion: JEV_RUBRIC_VERSION },
    ]);
  });

  it("returns empty counts when Q5 has no legacy assessment or presentation snapshot", async () => {
    await expect(repairQ5Scoring({ apply: true })).resolves.toEqual({
      assessmentCount: 0,
      snapshotCount: 0,
      entryCount: 0,
      applied: true,
    });
  });

  it("skips presentation sessions without a Q5 snapshot question", async () => {
    await seedLegacySnapshot();
    await testDb.db.insert(schema.presentationSessions).values({
      id: 2,
      state: "finished",
      version: 1,
      questionIndex: 0,
      questionCount: 0,
      questionVersions: {},
      rubricVersions: {},
    });

    await expect(repairQ5Scoring()).resolves.toMatchObject({
      assessmentCount: 1,
      snapshotCount: 1,
      entryCount: 3,
      applied: false,
    });
  });

  it("uses competition ranks when repaired totals tie", async () => {
    const ids = await seedLegacySnapshot();
    await testDb.db
      .update(schema.presentationEntries)
      .set({ score: 4.25 })
      .where(eq(schema.presentationEntries.participantId, ids.b));

    await repairQ5Scoring({ apply: true });

    const entries = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.sessionId, 1))
      .orderBy(schema.presentationEntries.participantId);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: ids.a, score: 4, rank: 1 }),
        expect.objectContaining({ participantId: ids.b, score: 4, rank: 1 }),
      ]),
    );
  });

  it.each([
    {
      name: "unsupported question version",
      mutate: async () => {
        await testDb.db
          .update(schema.examQuestions)
          .set({ questionVersion: "obsolete-q5-v1" })
          .where(eq(schema.examQuestions.id, 5));
      },
      message: /unsupported Q5 question version/i,
    },
    {
      name: "unsupported assessment question version",
      mutate: async () => {
        await testDb.db
          .update(schema.examAnswerAssessments)
          .set({ questionVersion: "obsolete-q5-v1" });
      },
      message: /unsupported Q5 assessment question version/i,
    },
    {
      name: "an assessment still being processed",
      mutate: async () => {
        await testDb.db.update(schema.examAnswerAssessments).set({ state: "processing" });
      },
      message: /assessment is processing/i,
    },
    {
      name: "an unknown assessment state",
      mutate: async () => {
        await testDb.db.update(schema.examAnswerAssessments).set({ state: "unknown" });
      },
      message: /unsupported Q5 assessment state/i,
    },
    ...([-0.1, 2.01] as const).map((normalizedScore) => ({
      name: "graded score " + normalizedScore + " outside the old scale",
      mutate: async () => {
        await testDb.db.update(schema.examAnswerAssessments).set({ normalizedScore });
      },
      message: /invalid.*Q5.*score/i,
    })),
    {
      name: "a graded assessment without a score",
      mutate: async () => {
        await testDb.db.update(schema.examAnswerAssessments).set({ normalizedScore: null });
      },
      message: /invalid.*Q5.*score/i,
    },
  ])("rejects $name and rolls back the complete repair", async ({ mutate, message }) => {
    await expectAtomicRepairRejection(mutate, message);
  });

  it.each([
    {
      name: "a non-object map",
      mutate: async () => {
        await testDb.db.update(schema.presentationSessions).set({ rubricVersions: null as never });
      },
      message: /invalid Q5 snapshot rubric version map/i,
    },
    {
      name: "an array map",
      mutate: async () => {
        await testDb.db.update(schema.presentationSessions).set({ rubricVersions: [] as never });
      },
      message: /invalid Q5 snapshot rubric version map/i,
    },
    {
      name: "a legacy rubric assigned to both Q5 and a different question",
      mutate: async () => {
        await testDb.db.update(schema.presentationSessions).set({
          rubricVersions: {
            "1": "single-choice-v1",
            "2": "single-choice-v1",
            "3": "single-choice-v1",
            "4": LEGACY_RUBRIC,
            "5": LEGACY_RUBRIC,
          },
        });
      },
      message: /unsupported Q5 snapshot question identity/i,
    },
    {
      name: "a missing Q5 question version",
      mutate: async () => {
        await testDb.db
          .update(schema.presentationSessions)
          .set({ questionVersions: { "1": "question-1-v1" } });
      },
      message: /unsupported Q5 snapshot question version/i,
    },
    {
      name: "an array question version map",
      mutate: async () => {
        await testDb.db.update(schema.presentationSessions).set({ questionVersions: [] as never });
      },
      message: /invalid Q5 snapshot version map/i,
    },
    {
      name: "a null question version map",
      mutate: async () => {
        await testDb.db
          .update(schema.presentationSessions)
          .set({ questionVersions: null as never });
      },
      message: /invalid Q5 snapshot version map/i,
    },
  ])("rejects $name before applying any rows", async ({ mutate, message }) => {
    await expectAtomicRepairRejection(mutate, message);
  });

  it.each([
    {
      name: "a missing Q5 answer",
      answers: (answers: typeof schema.presentationEntries.$inferSelect.answers) =>
        answers.filter((answer) => answer.questionId !== 5),
      score: undefined,
      q5Score: undefined,
    },
    {
      name: "duplicate Q5 answers",
      answers: (answers: typeof schema.presentationEntries.$inferSelect.answers) => [
        ...answers,
        answers.find((answer) => answer.questionId === 5)!,
      ],
      score: undefined,
      q5Score: undefined,
    },
    {
      name: "a Q5 answer stored as a selected choice",
      answers: (answers: typeof schema.presentationEntries.$inferSelect.answers) =>
        answers.map((answer) =>
          answer.questionId === 5 ? { ...answer, answerKind: "selected" as const } : answer,
        ),
      score: undefined,
      q5Score: undefined,
    },
    {
      name: "a total below its Q5 component",
      answers: undefined,
      score: 1,
      q5Score: undefined,
    },
    {
      name: "a total above the six-point snapshot maximum",
      answers: undefined,
      score: 6.1,
      q5Score: undefined,
    },
    {
      name: "a negative total score",
      answers: undefined,
      score: -0.1,
      q5Score: undefined,
    },
    {
      name: "a non-Q5 subtotal above four points",
      answers: undefined,
      score: 5.2,
      q5Score: 1,
    },
  ])("rejects $name without changing any scores", async ({ answers, score, q5Score }) => {
    await expectAtomicRepairRejection(async () => {
      const [entry] = await testDb.db
        .select()
        .from(schema.presentationEntries)
        .where(eq(schema.presentationEntries.participantId, 1));
      await testDb.db
        .update(schema.presentationEntries)
        .set({
          ...(score === undefined ? {} : { score }),
          ...(answers === undefined ? {} : { answers: answers(entry!.answers) }),
          ...(q5Score === undefined
            ? {}
            : {
                answers: entry!.answers.map((answer) =>
                  answer.questionId === 5 ? { ...answer, normalizedScore: q5Score } : answer,
                ),
              }),
        })
        .where(eq(schema.presentationEntries.participantId, 1));
    }, /invalid Q5 (?:(?:answer|total score) in legacy snapshot|score in legacy scoring data)/i);
  });

  it("rolls all planned writes back when a session compare-and-swap update affects no row", async () => {
    await seedLegacySnapshot();
    await testDb.client.execute({
      sql: "CREATE TRIGGER ignore_q5_session_update BEFORE UPDATE ON presentation_sessions BEGIN SELECT RAISE(IGNORE); END",
    });
    const sessionsBefore = await testDb.db.select().from(schema.presentationSessions);
    const assessmentsBefore = await testDb.db.select().from(schema.examAnswerAssessments);
    const entriesBefore = await testDb.db.select().from(schema.presentationEntries);

    await expect(repairQ5Scoring({ apply: true })).rejects.toThrow(/concurrent update/i);
    await expect(testDb.db.select().from(schema.presentationSessions)).resolves.toEqual(
      sessionsBefore,
    );
    await expect(testDb.db.select().from(schema.examAnswerAssessments)).resolves.toEqual(
      assessmentsBefore,
    );
    await expect(testDb.db.select().from(schema.presentationEntries)).resolves.toEqual(
      entriesBefore,
    );
  });

  it("preserves unanswered participants while repairing submitted legacy scores", async () => {
    const ids = await seedLegacySnapshot();
    const [unanswered] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "unanswered", displayName: "Unanswered" })
      .returning({ id: schema.examParticipants.id });
    const unansweredAnswers = [1, 2, 3, 4, 5].map((questionId) => ({
      questionId,
      answerKind: "unanswered" as const,
      selectedIndex: null,
      freeText: null,
      rawScore: null,
      normalizedScore: null,
    }));
    const [unansweredEntry] = await testDb.db
      .insert(schema.presentationEntries)
      .values({
        sessionId: 1,
        participantId: unanswered!.id,
        displayName: "Unanswered",
        score: 0,
        rank: null,
        isAggregationTarget: false,
        isReference: false,
        equivalentRank: null,
        answers: unansweredAnswers,
      })
      .returning();

    await expect(repairQ5Scoring()).resolves.toMatchObject({
      assessmentCount: 1,
      snapshotCount: 1,
      entryCount: 4,
      applied: false,
    });
    await expect(repairQ5Scoring({ apply: true })).resolves.toMatchObject({
      assessmentCount: 1,
      snapshotCount: 1,
      entryCount: 4,
      applied: true,
    });

    const entries = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .orderBy(schema.presentationEntries.participantId);
    expect(entries).toHaveLength(4);
    expect(entries).toEqual([
      expect.objectContaining({ participantId: ids.a, score: 4, rank: 2 }),
      expect.objectContaining({ participantId: ids.b, score: 4.25, rank: 1 }),
      expect.objectContaining({
        participantId: ids.reference,
        score: 5,
        rank: null,
        isAggregationTarget: true,
        isReference: true,
        equivalentRank: 1,
      }),
      expect.objectContaining({
        ...unansweredEntry,
        score: 0,
        rank: null,
        isAggregationTarget: false,
        isReference: false,
        equivalentRank: null,
        answers: unansweredAnswers,
      }),
    ]);
  });
});
