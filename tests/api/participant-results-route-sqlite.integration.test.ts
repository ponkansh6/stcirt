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

vi.mock("@/lib/participants/security", () => ({
  getParticipantCookie: (request: Request) =>
    request.headers.get("cookie")?.replace("stcirt_participant_session=", ""),
  verifyParticipantSession: (token?: string) =>
    token === "owner-session"
      ? { id: 42, expiresAt: new Date("2030-01-01") }
      : token === "target-session"
        ? { id: 99, expiresAt: new Date("2030-01-01") }
        : null,
}));

import { GET } from "@/app/api/participants/results/route";
import { GET as getPublicPresentation } from "@/app/api/presentation/route";

function request(scope?: string) {
  const query = scope ? `?scope=${scope}` : "";
  return new Request(`http://localhost/api/participants/results${query}`, {
    headers: { Cookie: "stcirt_participant_session=owner-session" },
  });
}

describe("GET /api/participants/results with SQLite persistence", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
    dbRef.db = testDb.db;
    await testDb.db.insert(schema.examParticipants).values([
      { id: 42, normalizedName: "owner", displayName: "Owner" },
      { id: 99, normalizedName: "target", displayName: "Assisted participant" },
      { id: 100, normalizedName: "other", displayName: "Other participant" },
    ]);
    await testDb.db.insert(schema.assistedParticipants).values({
      ownerParticipantId: 42,
      targetParticipantId: 99,
    });
    await testDb.db.insert(schema.presentationSessions).values({
      id: 1,
      state: "opening",
      version: 1,
      questionIndex: 0,
      questionCount: 1,
      snapshotRevision: 1,
      projectionHidden: false,
      presentationMode: "full",
    });
    await testDb.db.insert(schema.presentationQuestions).values({
      sessionId: 1,
      position: 0,
      sourceQuestionId: 7,
      question: "Snapshot question",
      choices: ["Alpha", "Beta"],
      correctIndex: 1,
      explanation: null,
    });
    await testDb.db.insert(schema.presentationEntries).values([
      {
        sessionId: 1,
        participantId: 42,
        displayName: "Owner",
        score: 0,
        rank: 2,
        answers: [
          {
            questionId: 7,
            answerKind: "selected",
            selectedIndex: 0,
            freeText: null,
            rawScore: 0,
            normalizedScore: null,
          },
        ],
      },
      {
        sessionId: 1,
        participantId: 99,
        displayName: "Assisted participant",
        score: 1,
        rank: 1,
        answers: [
          {
            questionId: 7,
            answerKind: "selected",
            selectedIndex: 1,
            freeText: null,
            rawScore: 1,
            normalizedScore: null,
          },
        ],
      },
      {
        sessionId: 1,
        participantId: 100,
        displayName: "Other participant",
        score: 1,
        rank: 1,
        answers: [
          {
            questionId: 7,
            answerKind: "selected",
            selectedIndex: 1,
            freeText: null,
            rawScore: 1,
            normalizedScore: null,
          },
        ],
      },
    ]);
    await testDb.db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: true,
      everPublished: true,
    });
  });

  afterEach(async () => {
    dbRef.db = null;
    await testDb.cleanup();
  });

  it("reads only the signed-in participant's snapshot row and projects no other entry", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      state: "visible",
      rank: 2,
      isAggregationTarget: true,
      participantCount: 3,
      score: 0,
      maxScore: 1,
      questions: [
        {
          position: 0,
          question: "Snapshot question",
          answer: { kind: "selected", value: "Alpha", correctness: "incorrect" },
        },
      ],
    });
  });

  it("returns waiting without private data when hidden while the public projection is unchanged", async () => {
    const publicBefore = await getPublicPresentation();
    await testDb.db
      .update(schema.participantResultSettings)
      .set({ visible: false })
      .where(eq(schema.participantResultSettings.id, 1));

    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: "waiting" });
    await expect(getPublicPresentation()).resolves.toEqual(publicBefore);
  });

  it("returns unavailable for absent or malformed snapshot entries", async () => {
    await testDb.db
      .delete(schema.presentationEntries)
      .where(eq(schema.presentationEntries.participantId, 42));
    await expect((await GET(request())).json()).resolves.toEqual({ state: "unavailable" });

    await testDb.db.insert(schema.presentationEntries).values({
      sessionId: 1,
      participantId: 42,
      displayName: "Owner",
      score: 0,
      rank: 2,
      answers: [],
    });
    await expect((await GET(request())).json()).resolves.toEqual({ state: "unavailable" });
  });

  it("resolves assisted reads through the stored owner link and rejects unresolved or invalid scope", async () => {
    const assisted = await GET(request("assisted"));
    expect(assisted.status).toBe(200);
    await expect(assisted.json()).resolves.toMatchObject({
      state: "visible",
      rank: 1,
      isAggregationTarget: true,
      participantCount: 3,
      score: 1,
      maxScore: 1,
      questions: [{ answer: { value: "Beta", correctness: "correct" } }],
    });

    await testDb.db.delete(schema.assistedParticipants);
    const unresolved = await GET(request("assisted"));
    expect(unresolved.status).toBe(404);
    await expect(unresolved.json()).resolves.toEqual({ error: "Assisted participant not found" });

    const invalid = await GET(request("other"));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid answer scope" });
  });
});
