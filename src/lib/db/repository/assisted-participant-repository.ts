import { eq } from "drizzle-orm";
import { db } from "../index";
import { assistedParticipants, examAnswerSubmissions, examParticipants } from "../schema";
import { normalizeParticipantName } from "./participant-repository";

export class AssistedParticipantError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "AssistedParticipantError";
  }
}

export type AssistedParticipant = { id: number; name: string };

function isConstraintError(error: unknown) {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

export async function getAssistedParticipant(ownerParticipantId: number) {
  const [row] = await db
    .select({ id: examParticipants.id, name: examParticipants.displayName })
    .from(assistedParticipants)
    .innerJoin(examParticipants, eq(assistedParticipants.targetParticipantId, examParticipants.id))
    .where(eq(assistedParticipants.ownerParticipantId, ownerParticipantId))
    .limit(1);
  return row ?? null;
}

export async function createAssistedParticipant(ownerParticipantId: number, name: string) {
  const { displayName, normalizedName } = normalizeParticipantName(name);
  if (!displayName || displayName.length > 120 || !normalizedName) {
    throw new AssistedParticipantError("名前を入力してください", 400);
  }

  try {
    return await db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: examParticipants.id, normalizedName: examParticipants.normalizedName })
        .from(examParticipants)
        .where(eq(examParticipants.id, ownerParticipantId))
        .limit(1);
      if (!owner) throw new AssistedParticipantError("Participant not found", 404);

      const [existingLink] = await tx
        .select({ id: examParticipants.id, name: examParticipants.displayName })
        .from(assistedParticipants)
        .innerJoin(
          examParticipants,
          eq(assistedParticipants.targetParticipantId, examParticipants.id),
        )
        .where(eq(assistedParticipants.ownerParticipantId, ownerParticipantId))
        .limit(1);
      if (existingLink) {
        const [linked] = await tx
          .select({ normalizedName: examParticipants.normalizedName })
          .from(examParticipants)
          .where(eq(examParticipants.id, existingLink.id))
          .limit(1);
        if (linked?.normalizedName === normalizedName) return existingLink;
        throw new AssistedParticipantError("ほかの人の回答者はすでに登録されています", 409);
      }

      const [ownerProxy] = await tx
        .select({ ownerParticipantId: assistedParticipants.ownerParticipantId })
        .from(assistedParticipants)
        .where(eq(assistedParticipants.targetParticipantId, ownerParticipantId))
        .limit(1);
      if (ownerProxy) {
        throw new AssistedParticipantError("代理回答者はほかの人の回答を登録できません", 409);
      }

      const [completedSubmission] = await tx
        .select({ id: examAnswerSubmissions.id })
        .from(examAnswerSubmissions)
        .where(eq(examAnswerSubmissions.participantId, ownerParticipantId))
        .limit(1);
      if (!completedSubmission) {
        throw new AssistedParticipantError("先にご自身の回答を完了してください", 409);
      }

      if (owner.normalizedName === normalizedName) {
        throw new AssistedParticipantError("ご自身と同じ名前は登録できません", 409);
      }
      const [existingParticipant] = await tx
        .select({ id: examParticipants.id })
        .from(examParticipants)
        .where(eq(examParticipants.normalizedName, normalizedName))
        .limit(1);
      if (existingParticipant) {
        throw new AssistedParticipantError("この名前はすでに使用されています", 409);
      }

      const [target] = await tx
        .insert(examParticipants)
        .values({ displayName, normalizedName })
        .returning({ id: examParticipants.id, name: examParticipants.displayName });
      await tx.insert(assistedParticipants).values({
        ownerParticipantId,
        targetParticipantId: target.id,
      });
      return target;
    });
  } catch (error) {
    if (error instanceof AssistedParticipantError) throw error;
    if (!isConstraintError(error)) throw error;

    // A concurrent request may have claimed the owner or name. Re-read the
    // durable relation so an identical retry remains idempotent.
    const linked = await getAssistedParticipant(ownerParticipantId);
    if (linked) {
      const [row] = await db
        .select({ normalizedName: examParticipants.normalizedName })
        .from(examParticipants)
        .where(eq(examParticipants.id, linked.id))
        .limit(1);
      if (row?.normalizedName === normalizedName) return linked;
      throw new AssistedParticipantError("ほかの人の回答者はすでに登録されています", 409);
    }
    throw new AssistedParticipantError("この名前はすでに使用されています", 409);
  }
}

export async function getAssistedTargetId(ownerParticipantId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: assistedParticipants.targetParticipantId })
    .from(assistedParticipants)
    .where(eq(assistedParticipants.ownerParticipantId, ownerParticipantId))
    .limit(1);
  return row?.id ?? null;
}
