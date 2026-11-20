import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/lib/db/schema";
import { JEV_RUBRIC_VERSION } from "@/lib/jev/adapter";

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
  getLatestAnswerSubmission,
  saveAnswerSubmission,
} from "@/lib/db/repository/answer-repository";
import { operatePresentation } from "@/lib/db/repository/presentation-repository";

describe("legacy answer-set upgrade", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.presentationOperations);
    await testDb.db.delete(schema.presentationEntries);
    await testDb.db.delete(schema.presentationQuestions);
    await testDb.db.delete(schema.presentationSessions);
    await testDb.db.delete(schema.examSubmissionOperations);
    await testDb.db.delete(schema.examAnswerAssessments);
    await testDb.db.delete(schema.examSubmissionAnswers);
    await testDb.db.delete(schema.examAnswerSubmissions);
    await testDb.db.delete(schema.examParticipants);
    await testDb.db.delete(schema.examQuestions);
  });

  afterEach(() => testDb.cleanup());

  it("restores old five-question answers and upgrades the submission when it is saved", async () => {
    const questionVersions = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [String(index + 1), `q${index + 1}-v1`]),
    );
    await testDb.db.insert(schema.examQuestions).values(
      Array.from({ length: 7 }, (_, index) => {
        const id = index + 1;
        return {
          id,
          key: id === 5 ? "it-literacy-005" : `it-literacy-${String(id).padStart(3, "0")}`,
          question: `Question ${id}`,
          choices: id === 5 ? [] : ["A", "B", "C", "D"],
          correctIndex: 0,
          correctIndices: null,
          explanation: null,
          questionVersion: `q${id}-v1`,
          selectionMode: "single" as const,
        };
      }),
    );
    const [participant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "legacy-five", displayName: "Legacy Five" })
      .returning({ id: schema.examParticipants.id });
    const submissionId = "00000000-0000-4000-8000-000000000005";
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId: participant!.id,
      questionIds: [1, 2, 3, 4, 5],
      questionVersions,
      revision: 1,
    });
    await testDb.db.insert(schema.examSubmissionAnswers).values(
      [1, 2, 3, 4, 5].map((questionId) => ({
        submissionId,
        questionId,
        selectedIndex: questionId === 5 ? null : questionId === 4 ? 0 : questionId,
        selectedIndices: null,
        freeText: questionId === 5 ? JSON.stringify({ a: "Saved A", b: "Saved B" }) : null,
        answerKind: questionId === 5 ? ("freeText" as const) : ("selected" as const),
      })),
    );

    const restored = await getLatestAnswerSubmission(participant!.id);
    expect(restored).toMatchObject({
      submissionId,
      restoreIntegrity: {
        status: "complete",
        questions: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      },
      answers: [
        { questionId: 1, selectedIndex: 1 },
        { questionId: 2, selectedIndex: 2 },
        { questionId: 3, selectedIndex: 3 },
        { questionId: 4, selectedIndex: 0 },
        { questionId: 5, freeTextParts: { a: "Saved A", b: "Saved B" } },
      ],
    });

    await saveAnswerSubmission({
      submissionId,
      operationId: "00000000-0000-4000-8000-000000000006",
      expectedRevision: 1,
      participantId: participant!.id,
      answers: [
        { questionId: 1, selectedIndex: 1 },
        { questionId: 2, selectedIndex: 2 },
        { questionId: 3, selectedIndex: 3 },
        { questionId: 4, selectedIndex: 0 },
        { questionId: 5, freeTextParts: { a: "Saved A", b: "Saved B" } },
        { questionId: 6, selectedIndex: 3 },
        { questionId: 7, selectedIndex: 2 },
      ],
    });

    const [upgraded] = await testDb.db
      .select()
      .from(schema.examAnswerSubmissions)
      .where(eq(schema.examAnswerSubmissions.id, submissionId));
    const rows = await testDb.db
      .select()
      .from(schema.examSubmissionAnswers)
      .where(eq(schema.examSubmissionAnswers.submissionId, submissionId));
    expect(upgraded?.questionIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(upgraded?.questionVersions).toMatchObject({ "6": "q6-v1", "7": "q7-v1" });
    expect(rows).toHaveLength(7);
    expect(rows.find(({ questionId }) => questionId === 5)?.freeText).toBe(
      JSON.stringify({ a: "Saved A", b: "Saved B" }),
    );
    expect(rows.find(({ questionId }) => questionId === 6)?.selectedIndex).toBe(3);
    expect(rows.find(({ questionId }) => questionId === 7)?.selectedIndex).toBe(2);
  });

  it("restores old six-question answers with Q7 blank and upgrades them on save", async () => {
    const questionVersions = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [String(index + 1), `q${index + 1}-v1`]),
    );
    await testDb.db.insert(schema.examQuestions).values(
      Array.from({ length: 7 }, (_, index) => {
        const id = index + 1;
        return {
          id,
          key: id === 5 ? "it-literacy-005" : `it-literacy-${String(id).padStart(3, "0")}`,
          question: `Question ${id}`,
          choices: id === 5 ? [] : ["A", "B", "C", "D"],
          correctIndex: 0,
          correctIndices: null,
          explanation: null,
          questionVersion: `q${id}-v1`,
          selectionMode: "single" as const,
        };
      }),
    );
    const [participant] = await testDb.db
      .insert(schema.examParticipants)
      .values({ normalizedName: "legacy-six", displayName: "Legacy Six" })
      .returning({ id: schema.examParticipants.id });
    const submissionId = "00000000-0000-4000-8000-000000000007";
    await testDb.db.insert(schema.examAnswerSubmissions).values({
      id: submissionId,
      participantId: participant!.id,
      questionIds: [1, 2, 3, 4, 5, 6],
      questionVersions,
      revision: 1,
    });
    await testDb.db.insert(schema.examSubmissionAnswers).values(
      [1, 2, 3, 4, 5, 6].map((questionId) => ({
        submissionId,
        questionId,
        selectedIndex: questionId === 5 ? null : 0,
        selectedIndices: null,
        freeText: questionId === 5 ? JSON.stringify({ a: "Saved A", b: "Saved B" }) : null,
        answerKind: questionId === 5 ? ("freeText" as const) : ("selected" as const),
      })),
    );

    const restored = await getLatestAnswerSubmission(participant!.id);
    expect(restored).toMatchObject({
      submissionId,
      restoreIntegrity: {
        status: "complete",
        questions: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
      },
      answers: [
        { questionId: 1, selectedIndex: 0 },
        { questionId: 2, selectedIndex: 0 },
        { questionId: 3, selectedIndex: 0 },
        { questionId: 4, selectedIndex: 0 },
        { questionId: 5, freeTextParts: { a: "Saved A", b: "Saved B" } },
        { questionId: 6, selectedIndex: 0 },
      ],
    });

    await saveAnswerSubmission({
      submissionId,
      operationId: "00000000-0000-4000-8000-000000000008",
      expectedRevision: 1,
      participantId: participant!.id,
      answers: [
        { questionId: 1, selectedIndex: 0 },
        { questionId: 2, selectedIndex: 0 },
        { questionId: 3, selectedIndex: 0 },
        { questionId: 4, selectedIndex: 0 },
        { questionId: 5, freeTextParts: { a: "Saved A", b: "Saved B" } },
        { questionId: 6, selectedIndex: 0 },
        { questionId: 7, selectedIndex: 1 },
      ],
    });
    const [upgraded] = await testDb.db
      .select()
      .from(schema.examAnswerSubmissions)
      .where(eq(schema.examAnswerSubmissions.id, submissionId));
    expect(upgraded?.questionIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(upgraded?.questionVersions).toMatchObject({ "7": "q7-v1" });
  });

  it("excludes old five-question submissions while including current seven-question results", async () => {
    const questionVersions = {
      "1": "nagano-001-v1",
      "2": "nagano-002-v1",
      "3": "nagano-003-v1",
      "4": "nagano-004-v1",
      "5": "hong-kong-trip-a-b-v6",
      "6": "tamami-university-friends-local-curry-v2",
      "7": "high-school-microwave-power-v1",
    };
    await testDb.db.insert(schema.examQuestions).values(
      [1, 2, 3, 4, 5, 6, 7].map((id) => ({
        id,
        key: `it-literacy-${String(id).padStart(3, "0")}`,
        question: `Question ${id}`,
        choices: id === 5 ? [] : ["Correct", "Wrong"],
        correctIndex: 0,
        correctIndices: null,
        explanation: null,
        questionVersion: questionVersions[String(id) as keyof typeof questionVersions],
        selectionMode: "single" as const,
      })),
    );
    const [oldParticipant, currentParticipant] = await testDb.db
      .insert(schema.examParticipants)
      .values([
        { normalizedName: "old-five", displayName: "Old five" },
        { normalizedName: "current-seven", displayName: "Current seven" },
      ])
      .returning({ id: schema.examParticipants.id });
    const oldSubmissionId = "00000000-0000-4000-8000-000000000015";
    const currentSubmissionId = "00000000-0000-4000-8000-000000000016";
    await testDb.db.insert(schema.examAnswerSubmissions).values([
      {
        id: oldSubmissionId,
        participantId: oldParticipant!.id,
        questionIds: [1, 2, 3, 4, 5],
        questionVersions: Object.fromEntries(
          Object.entries(questionVersions).filter(([id]) => id !== "6"),
        ),
        revision: 1,
      },
      {
        id: currentSubmissionId,
        participantId: currentParticipant!.id,
        questionIds: [1, 2, 3, 4, 5, 6, 7],
        questionVersions,
        revision: 1,
      },
    ]);
    await testDb.db.insert(schema.examSubmissionAnswers).values([
      ...[1, 2, 3, 4].map((questionId) => ({
        submissionId: oldSubmissionId,
        questionId,
        selectedIndex: 0,
        freeText: null,
        answerKind: "selected" as const,
      })),
      {
        submissionId: oldSubmissionId,
        questionId: 5,
        selectedIndex: null,
        freeText: JSON.stringify({ a: "Old A", b: "Old B" }),
        answerKind: "freeText" as const,
      },
      ...[1, 2, 3, 4, 6, 7].map((questionId) => ({
        submissionId: currentSubmissionId,
        questionId,
        selectedIndex: 0,
        freeText: null,
        answerKind: "selected" as const,
      })),
      {
        submissionId: currentSubmissionId,
        questionId: 5,
        selectedIndex: null,
        freeText: JSON.stringify({ a: "Current A", b: "Current B" }),
        answerKind: "freeText" as const,
      },
    ]);
    await testDb.db.insert(schema.examAnswerAssessments).values({
      submissionId: currentSubmissionId,
      questionId: 5,
      revision: 1,
      answerText: JSON.stringify({ a: "Current A", b: "Current B" }),
      questionVersion: "hong-kong-trip-a-b-v6",
      state: "graded",
      rawScore: 5,
      normalizedScore: 0.5,
      rubricVersion: JEV_RUBRIC_VERSION,
    });

    const aggregated = await operatePresentation("legacy-five-question-exclusion", "aggregate");

    expect(aggregated.aggregationSummary).toMatchObject({
      snapshotUpdated: true,
      includedSubmissionCount: 1,
      excludedSubmissionCount: 1,
      excludedReasonCounts: { questionVersionMismatch: 1 },
    });
    expect(aggregated.entries.map(({ displayName }) => displayName)).toEqual(["Current seven"]);
    expect(
      await testDb.db
        .select()
        .from(schema.presentationEntries)
        .where(eq(schema.presentationEntries.participantId, oldParticipant!.id)),
    ).toHaveLength(0);
  });
});
