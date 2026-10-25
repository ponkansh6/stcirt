import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/lib/db/schema";
import { e2eDatabaseUrl, e2eParticipantPin } from "./fixtures/admin-auth";
import { expect, test } from "./fixtures/test";

test("@chromium invalid shared links fail closed with or without participant cookies", async ({
  page,
}) => {
  const anonymousResponse = await page.goto("/api/shared-results/not-a-token");
  expect(anonymousResponse?.status()).toBe(404);
  const anonymousBody = await anonymousResponse?.text();
  expect(anonymousBody).toBe('{"error":"NOT_FOUND"}');
  expect(anonymousResponse?.headers()["cache-control"]).toBe("private, no-store");
  expect(anonymousResponse?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(anonymousResponse?.headers()["x-robots-tag"]).toContain("noindex");
  expect(anonymousResponse?.headers()["set-cookie"]).toBeUndefined();

  await page.context().addCookies([
    {
      name: "stcirt_participant_session",
      value: "unrelated-session-cookie",
      url: "http://127.0.0.1:3001",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const cookieResponse = await page.goto("/api/shared-results/not-a-token");
  expect(cookieResponse?.status()).toBe(404);
  expect(await cookieResponse?.text()).toBe(anonymousBody);
  expect(cookieResponse?.headers()["set-cookie"]).toBeUndefined();
  expect((await page.context().cookies()).map(({ name }) => name)).toEqual([
    "stcirt_participant_session",
  ]);
});

test("@chromium an issued share is readable without login and becomes unavailable after stop", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "The seeded share flow owns the shared isolated E2E database in Chromium only.",
  );
  test.setTimeout(90_000);
  const client = createClient({ url: e2eDatabaseUrl, authToken: "" });
  const db = drizzle({ client, schema });
  const ownerName = `E2E share owner ${randomUUID()}`;
  const targetName = `E2E share target ${randomUUID()}`;
  const baseUrl = "http://127.0.0.1:3001";
  const ownerContext = await browser.newContext();
  let ownerId: number | null = null;
  let targetId: number | null = null;
  let migrationReady = false;

  try {
    await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });
    migrationReady = true;
    // Keep this dedicated E2E database repeatable across Playwright retries.
    await db.delete(schema.assistedResultShares);
    await db.delete(schema.assistedParticipants);
    await db.delete(schema.presentationEntries);
    await db.delete(schema.presentationQuestions);
    await db.delete(schema.presentationSessions);
    await db.delete(schema.participantResultSettings);

    const [owner] = await db
      .insert(schema.examParticipants)
      .values({ normalizedName: ownerName.normalize("NFC"), displayName: ownerName })
      .returning({ id: schema.examParticipants.id });
    if (!owner) throw new Error("Failed to seed the share owner");
    ownerId = owner.id;
    const [target] = await db
      .insert(schema.examParticipants)
      .values({ normalizedName: targetName.normalize("NFC"), displayName: targetName })
      .returning({ id: schema.examParticipants.id });
    if (!target) throw new Error("Failed to seed the assisted target");
    targetId = target.id;
    await db.insert(schema.assistedParticipants).values({
      ownerParticipantId: owner.id,
      targetParticipantId: target.id,
    });
    await db.insert(schema.presentationSessions).values({
      id: 1,
      state: "finished",
      version: 1,
      questionIndex: 0,
      questionCount: 1,
      snapshotRevision: 1,
      projectionHidden: false,
      presentationMode: "full",
    });
    await db.insert(schema.presentationQuestions).values({
      sessionId: 1,
      position: 0,
      sourceQuestionId: 90001,
      question: "E2E shared question",
      choices: ["E2E shared answer", "Other answer"],
      correctIndex: 0,
      explanation: null,
    });
    await db.insert(schema.presentationEntries).values({
      sessionId: 1,
      participantId: target.id,
      displayName: targetName,
      score: 1,
      rank: 1,
      isAggregationTarget: true,
      answers: [
        {
          questionId: 90001,
          answerKind: "selected",
          selectedIndex: 0,
          freeText: null,
          rawScore: 1,
          normalizedScore: null,
        },
      ],
    });
    await db.insert(schema.participantResultSettings).values({
      id: 1,
      visible: true,
      everPublished: true,
    });

    const ownerApi = ownerContext.request;
    const login = await ownerApi.post(`${baseUrl}/api/participants/session`, {
      data: { name: ownerName, pin: e2eParticipantPin },
      headers: { Origin: baseUrl },
    });
    expect(login.status()).toBe(200);
    expect((await ownerContext.cookies(baseUrl)).map(({ name }) => name)).toContain(
      "stcirt_participant_session",
    );

    const issuedResponse = await ownerApi.post(`${baseUrl}/api/participants/results/share`, {
      headers: { Origin: baseUrl },
    });
    expect(issuedResponse.status()).toBe(200);
    const issued = (await issuedResponse.json()) as { path: string };
    expect(issued.path).toMatch(/^\/shared-results\/v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    const token = issued.path.slice("/shared-results/".length);

    await page.goto(issued.path);
    expect(await page.context().cookies()).toEqual([]);
    await expect(page.getByText("E2E shared question")).toBeVisible();
    await expect(page.getByText("E2E shared answer")).toBeVisible();
    await expect(page.getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    const main = page.locator("main");
    await expect(main.getByRole("button")).toHaveCount(1);
    await expect(main.getByRole("button", { name: "結果を再読み込み" })).toBeVisible();

    const sharedApiRequestHeaders = new Promise<Record<string, string>>((resolve) => {
      page.on("request", async (request) => {
        if (new URL(request.url()).pathname === `/api/shared-results/${token}`) {
          resolve(await request.allHeaders());
        }
      });
    });
    await main.getByRole("button", { name: "結果を再読み込み" }).click();
    expect((await sharedApiRequestHeaders).cookie).toBeUndefined();
    await expect(page.getByText("E2E shared answer")).toBeVisible();
    await expect(page.getByText("1.00点")).toBeVisible();

    await db
      .update(schema.presentationEntries)
      .set({ score: 0 })
      .where(
        and(
          eq(schema.presentationEntries.sessionId, 1),
          eq(schema.presentationEntries.participantId, target.id),
        ),
      );
    await page.getByRole("button", { name: "結果を再読み込み" }).click();
    await expect(page.getByText("0.00点")).toBeVisible();
    await expect(page.getByText("1.00点")).toHaveCount(0);

    const stopped = await ownerApi.delete(`${baseUrl}/api/participants/results/share`, {
      headers: { Origin: baseUrl },
    });
    expect(stopped.status()).toBe(200);
    expect(await stopped.json()).toMatchObject({ stopped: true });
    await page.getByRole("button", { name: "結果を再読み込み" }).click();
    await expect(page.getByText("この共有URLは無効か、期限が切れています。")).toBeVisible();
    await expect(page.getByText("E2E shared answer")).toHaveCount(0);

    const expiryShareResponse = await ownerApi.post(`${baseUrl}/api/participants/results/share`, {
      headers: { Origin: baseUrl },
    });
    expect(expiryShareResponse.status()).toBe(200);
    const expiryShare = (await expiryShareResponse.json()) as { path: string };
    const expiryToken = expiryShare.path.slice("/shared-results/".length);
    await db
      .update(schema.assistedResultShares)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.assistedResultShares.ownerParticipantId, owner.id));
    const expiredPageResponse = await page.goto(`/shared-results/${expiryToken}`);
    expect(expiredPageResponse?.status()).toBe(404);
    const expiredResponse = await page.goto(`/api/shared-results/${expiryToken}`);
    expect(expiredResponse?.status()).toBe(404);
    await ownerApi.delete(`${baseUrl}/api/participants/results/share`, {
      headers: { Origin: baseUrl },
    });
  } finally {
    try {
      if (migrationReady) {
        if (ownerId !== null) {
          await db
            .delete(schema.assistedResultShares)
            .where(eq(schema.assistedResultShares.ownerParticipantId, ownerId));
          await db
            .delete(schema.assistedParticipants)
            .where(eq(schema.assistedParticipants.ownerParticipantId, ownerId));
          await db.delete(schema.examParticipants).where(eq(schema.examParticipants.id, ownerId));
        }
        if (targetId !== null) {
          await db
            .delete(schema.presentationEntries)
            .where(eq(schema.presentationEntries.participantId, targetId));
          await db.delete(schema.examParticipants).where(eq(schema.examParticipants.id, targetId));
        }
        await db
          .delete(schema.presentationQuestions)
          .where(eq(schema.presentationQuestions.sessionId, 1));
        await db.delete(schema.presentationSessions).where(eq(schema.presentationSessions.id, 1));
        await db
          .delete(schema.participantResultSettings)
          .where(eq(schema.participantResultSettings.id, 1));
      }
    } finally {
      await ownerContext.close();
      await client.close();
    }
  }
});
