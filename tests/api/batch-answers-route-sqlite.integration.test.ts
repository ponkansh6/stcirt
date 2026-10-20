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

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: (request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  requestHasValidOrigin: (request: Request) =>
    request.headers.get("origin") === new URL(request.url).origin,
  verifyParticipantSession: (token?: string) =>
    token === "owner-session" ? { id: 42, expiresAt: new Date("2030-01-01") } : null,
}));

import { POST } from "@/app/api/answers/batch/route";
import {
  operatePresentationControls,
  setParticipantResultsVisible,
} from "@/lib/db/repository/presentation-repository.mutations";

describe("POST /api/answers/batch with SQLite persistence", () => {
  let testDb: TestDb;
  let targetId: number;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.delete(schema.examQuestions);
    await testDb.db.insert(schema.examParticipants).values([
      { id: 42, normalizedName: "owner", displayName: "Owner" },
      { id: 99, normalizedName: "target", displayName: "Assisted participant" },
    ]);
    targetId = 99;
    await testDb.db.insert(schema.assistedParticipants).values({
      ownerParticipantId: 42,
      targetParticipantId: targetId,
    });
    await testDb.db.insert(schema.examQuestions).values(
      [1, 2, 3, 4, 5].map((id) => ({
        id,
        key: `it-literacy-${String(id).padStart(3, "0")}`,
        questionVersion: id === 5 ? "tamami-egg-v1" : `test-v${id}`,
        question: `Question ${id}`,
        choices: id === 5 ? [] : ["A", "B", "C", "D"],
        correctIndex: 0,
      })),
    );
  });

  afterEach(async () => {
    dbRef.db = null;
    await testDb.cleanup();
  });

  it("persists an assisted batch under the database-linked target and ignores caller identity", async () => {
    const submissionId = "00000000-0000-4000-8000-000000000401";
    const operationId = "00000000-0000-4000-8000-000000000402";
    const answers = [
      ...[1, 2, 3, 4].map((questionId) => ({ questionId, selectedIndex: 0 })),
      { questionId: 5, freeText: "  answer from assisted participant  " },
    ];
    const response = await POST(
      new Request("http://localhost/api/answers/batch?scope=assisted", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          Cookie: "stcirt_participant_session=owner-session",
        },
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ submissionId, revision: 1 });
    const [submission] = await testDb.db.select().from(schema.examAnswerSubmissions);
    expect(submission).toMatchObject({ id: submissionId, participantId: targetId, revision: 1 });
    expect(await testDb.db.select().from(schema.examSubmissionAnswers)).toHaveLength(5);
    const [assessment] = await testDb.db.select().from(schema.examAnswerAssessments);
    expect(assessment).toMatchObject({
      submissionId,
      questionId: 5,
      answerText: "answer from assisted participant",
      state: "pending",
    });
  });

  it("accepts a batch save while published and leaves the public snapshot unchanged until aggregation", async () => {
    const submissionId = "00000000-0000-4000-8000-000000000411";
    const operationId = "00000000-0000-4000-8000-000000000412";
    const answers = [
      ...[1, 2, 3, 4].map((questionId) => ({ questionId, selectedIndex: 0 })),
      { questionId: 5, freeText: "answer before the next aggregation" },
    ];

    // Use registered source versions so both explicit snapshots are aggregatable.
    for (const questionId of [1, 2, 3, 4]) {
      await testDb.db
        .update(schema.examQuestions)
        .set({ questionVersion: `nagano-00${questionId}-v1` })
        .where(eq(schema.examQuestions.id, questionId));
    }
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "not_started",
      version: 0,
      questionIndex: 0,
      questionCount: 5,
      snapshotRevision: 0,
      projectionHidden: false,
    });

    await operatePresentationControls("00000000-0000-4000-8000-000000000413", "aggregate");
    await setParticipantResultsVisible(true);
    const beforeSnapshot = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, 42));

    const response = await POST(
      new Request("http://localhost/api/answers/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          Cookie: "stcirt_participant_session=owner-session",
        },
        body: JSON.stringify({ submissionId, operationId, expectedRevision: 0, answers }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ submissionId, revision: 1 });
    const [savedSubmission] = await testDb.db
      .select()
      .from(schema.examAnswerSubmissions)
      .where(eq(schema.examAnswerSubmissions.id, submissionId));
    expect(savedSubmission).toMatchObject({ id: submissionId, participantId: 42, revision: 1 });
    const savedAnswers = await testDb.db
      .select()
      .from(schema.examSubmissionAnswers)
      .where(eq(schema.examSubmissionAnswers.submissionId, submissionId));
    expect(savedAnswers).toHaveLength(5);
    const [pendingAssessment] = await testDb.db
      .select()
      .from(schema.examAnswerAssessments)
      .where(eq(schema.examAnswerAssessments.submissionId, submissionId));
    expect(pendingAssessment).toMatchObject({
      submissionId,
      questionId: 5,
      state: "pending",
    });
    expect(
      await testDb.db
        .select()
        .from(schema.presentationEntries)
        .where(eq(schema.presentationEntries.participantId, 42)),
    ).toEqual(beforeSnapshot);

    await testDb.db
      .update(schema.examAnswerAssessments)
      .set({
        state: "graded",
        rawScore: 1,
        normalizedScore: 1,
        rubricVersion: "jev-q5-fulfillment-v3-02",
        gradedAt: new Date(),
      })
      .where(eq(schema.examAnswerAssessments.submissionId, submissionId));
    await operatePresentationControls("00000000-0000-4000-8000-000000000414", "aggregate");

    const afterAggregation = await testDb.db
      .select()
      .from(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, 42));
    expect(afterAggregation).toHaveLength(1);
    expect(afterAggregation[0]?.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ questionId: 1, answerKind: "selected", selectedIndex: 0 }),
        expect.objectContaining({ questionId: 5, answerKind: "freeText" }),
      ]),
    );
  });
});
