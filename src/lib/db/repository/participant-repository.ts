import { eq } from "drizzle-orm";
import { db } from "../index";
import { examParticipants } from "../schema";

export function normalizeParticipantName(name: string) {
  const displayName = name.trim();
  return { displayName, normalizedName: displayName.normalize("NFC") };
}

export async function findParticipantById(id: number) {
  const rows = await db
    .select({ id: examParticipants.id, name: examParticipants.displayName })
    .from(examParticipants)
    .where(eq(examParticipants.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOrCreateParticipant(name: string) {
  const { displayName, normalizedName } = normalizeParticipantName(name);
  if (!displayName || !normalizedName) return null;

  await db
    .insert(examParticipants)
    .values({ displayName, normalizedName })
    .onConflictDoNothing({ target: examParticipants.normalizedName });

  const rows = await db
    .select({ id: examParticipants.id, name: examParticipants.displayName })
    .from(examParticipants)
    .where(eq(examParticipants.normalizedName, normalizedName))
    .limit(1);
  return rows[0] ?? null;
}
