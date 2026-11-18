import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  examAnswerAssessments,
  examQuestions,
  presentationEntries,
  presentationQuestions,
  presentationSessions,
} from "@/lib/db/schema";
import {
  JEV_QUESTION_VERSION,
  JEV_RUBRIC_VERSION,
  LEGACY_Q5_RUBRIC_VERSION,
} from "@/lib/jev/versions";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | DatabaseTransaction;

type AssessmentRepair = {
  submissionId: string;
  questionId: number;
  normalizedScore: number | null;
  rubricVersion: string;
};

type EntryRepair = {
  sessionId: number;
  participantId: number;
  isAggregationTarget: boolean;
  isReference: boolean;
  score: number;
  rank: number | null;
  equivalentRank: number | null;
  answers: (typeof presentationEntries.$inferSelect)["answers"];
};

type SessionRepair = {
  id: number;
  version: number;
  snapshotRevision: number;
  rubricVersions: Record<string, string>;
};

type RepairPlan = {
  assessments: AssessmentRepair[];
  entries: EntryRepair[];
  sessions: SessionRepair[];
};

function invalidQ5Score(): Error {
  return new Error("Invalid Q5 score in legacy scoring data");
}

function requireFiniteScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
    throw invalidQ5Score();
  }
  return value;
}

function validateVersionMap(value: unknown, q5Key: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Q5 snapshot version map");
  }
  const map = value as Record<string, unknown>;
  if (map[q5Key] !== JEV_QUESTION_VERSION) {
    throw new Error("Unsupported Q5 snapshot question version");
  }
  return map as Record<string, string>;
}

function rankEntries(entries: EntryRepair[]): EntryRepair[] {
  const eligible = entries.filter((entry) => entry.isAggregationTarget && !entry.isReference);
  eligible.sort(
    (left, right) => right.score - left.score || left.participantId - right.participantId,
  );
  const rankByParticipant = new Map<number, number>();
  let previousScore: number | undefined;
  let previousRank = 0;
  eligible.forEach((entry, index) => {
    if (entry.score !== previousScore) {
      previousRank = index + 1;
      previousScore = entry.score;
    }
    rankByParticipant.set(entry.participantId, previousRank);
  });

  return entries.map((entry) => ({
    ...entry,
    rank:
      entry.isAggregationTarget && !entry.isReference
        ? rankByParticipant.get(entry.participantId)!
        : null,
    equivalentRank:
      entry.isAggregationTarget && entry.isReference
        ? 1 + eligible.filter((ordinary) => ordinary.score > entry.score).length
        : null,
  }));
}

async function createRepairPlan(executor: Executor): Promise<RepairPlan> {
  const [q5] = await executor
    .select({ id: examQuestions.id, questionVersion: examQuestions.questionVersion })
    .from(examQuestions)
    .where(eq(examQuestions.key, "it-literacy-005"));

  if (!q5) return { assessments: [], entries: [], sessions: [] };
  if (q5.questionVersion !== JEV_QUESTION_VERSION) {
    throw new Error("Unsupported Q5 question version");
  }

  const assessments: AssessmentRepair[] = [];
  const legacyAssessments = await executor
    .select()
    .from(examAnswerAssessments)
    .where(
      and(
        eq(examAnswerAssessments.questionId, q5.id),
        eq(examAnswerAssessments.rubricVersion, LEGACY_Q5_RUBRIC_VERSION),
      ),
    );
  for (const assessment of legacyAssessments) {
    if (assessment.questionVersion !== JEV_QUESTION_VERSION) {
      throw new Error("Unsupported Q5 assessment question version");
    }
    if (assessment.state === "processing") {
      throw new Error("Cannot repair Q5 scoring while an assessment is processing");
    }
    if (assessment.state === "graded") {
      assessments.push({
        submissionId: assessment.submissionId,
        questionId: assessment.questionId,
        normalizedScore: requireFiniteScore(assessment.normalizedScore) / 2,
        rubricVersion: JEV_RUBRIC_VERSION,
      });
    } else if (assessment.state === "pending" || assessment.state === "failed") {
      const normalizedScore =
        assessment.normalizedScore === null
          ? null
          : requireFiniteScore(assessment.normalizedScore) / 2;
      assessments.push({
        submissionId: assessment.submissionId,
        questionId: assessment.questionId,
        normalizedScore,
        rubricVersion: JEV_RUBRIC_VERSION,
      });
    } else {
      throw new Error("Unsupported Q5 assessment state");
    }
  }

  const sessions = await executor.select().from(presentationSessions);
  const snapshotQuestions = await executor
    .select()
    .from(presentationQuestions)
    .where(eq(presentationQuestions.sourceQuestionId, q5.id));
  const sessionRepairs: SessionRepair[] = [];
  const entryRepairs: EntryRepair[] = [];

  for (const session of sessions) {
    const question = snapshotQuestions.find((row) => row.sessionId === session.id);
    if (!question) continue;
    const rubrics = session.rubricVersions;
    if (!rubrics || typeof rubrics !== "object" || Array.isArray(rubrics)) {
      throw new Error("Invalid Q5 snapshot rubric version map");
    }
    const legacyKeys = Object.keys(rubrics).filter(
      (key) => rubrics[key] === LEGACY_Q5_RUBRIC_VERSION,
    );
    if (!legacyKeys.length) continue;
    const q5Key = String(question.sourceQuestionId);
    if (legacyKeys.length !== 1 || legacyKeys[0] !== q5Key) {
      throw new Error("Unsupported Q5 snapshot question identity");
    }
    validateVersionMap(session.questionVersions, q5Key);

    const entries = await executor
      .select()
      .from(presentationEntries)
      .where(eq(presentationEntries.sessionId, session.id));
    const converted: EntryRepair[] = entries.map((entry) => {
      if (!Number.isFinite(entry.score) || entry.score < 0 || entry.score > 6)
        throw invalidQ5Score();
      const answerIndexes = entry.answers.flatMap((answer, index) =>
        answer.questionId === q5.id ? [index] : [],
      );
      const answerIndex = answerIndexes[0];
      if (answerIndexes.length !== 1 || answerIndex === undefined) {
        throw new Error("Invalid Q5 answer in legacy snapshot");
      }
      const q5Answer = entry.answers[answerIndex]!;
      if (
        q5Answer.answerKind === "unanswered" &&
        q5Answer.normalizedScore === null &&
        !entry.isAggregationTarget &&
        entry.score === 0
      ) {
        return { ...entry, answers: entry.answers };
      }
      if (q5Answer.answerKind !== "freeText") {
        throw new Error("Invalid Q5 answer in legacy snapshot");
      }
      const previousQ5Score = requireFiniteScore(q5Answer.normalizedScore);
      const newQ5Score = previousQ5Score / 2;
      const nonQ5Score = entry.score - previousQ5Score;
      const newTotal = nonQ5Score + newQ5Score;
      if (nonQ5Score < 0 || nonQ5Score > 4) {
        throw new Error("Invalid Q5 total score in legacy snapshot");
      }
      const answers = entry.answers.map((answer, index) =>
        index === answerIndex ? { ...answer, normalizedScore: newQ5Score } : answer,
      );
      return {
        ...entry,
        score: newTotal,
        answers,
      };
    });
    entryRepairs.push(...rankEntries(converted));
    sessionRepairs.push({
      id: session.id,
      version: session.version,
      snapshotRevision: session.snapshotRevision,
      rubricVersions: { ...rubrics, [q5Key]: JEV_RUBRIC_VERSION },
    });
  }

  return { assessments, entries: entryRepairs, sessions: sessionRepairs };
}

async function applyRepairPlan(executor: DatabaseTransaction, plan: RepairPlan) {
  for (const assessment of plan.assessments) {
    await executor
      .update(examAnswerAssessments)
      .set({ normalizedScore: assessment.normalizedScore, rubricVersion: assessment.rubricVersion })
      .where(
        and(
          eq(examAnswerAssessments.submissionId, assessment.submissionId),
          eq(examAnswerAssessments.questionId, assessment.questionId),
          eq(examAnswerAssessments.rubricVersion, LEGACY_Q5_RUBRIC_VERSION),
        ),
      );
  }
  for (const entry of plan.entries) {
    await executor
      .update(presentationEntries)
      .set({
        score: entry.score,
        rank: entry.rank,
        equivalentRank: entry.equivalentRank,
        answers: entry.answers,
      })
      .where(
        and(
          eq(presentationEntries.sessionId, entry.sessionId),
          eq(presentationEntries.participantId, entry.participantId),
        ),
      );
  }
  for (const session of plan.sessions) {
    const updated = await executor
      .update(presentationSessions)
      .set({
        rubricVersions: session.rubricVersions,
        version: session.version + 1,
        snapshotRevision: session.snapshotRevision + 1,
      })
      .where(
        and(
          eq(presentationSessions.id, session.id),
          eq(presentationSessions.version, session.version),
          eq(presentationSessions.snapshotRevision, session.snapshotRevision),
        ),
      )
      .returning({ id: presentationSessions.id });
    if (!updated.length) throw new Error("Q5 scoring repair conflicted with a concurrent update");
  }
}

export async function repairQ5Scoring(options: { apply?: boolean } = {}): Promise<{
  assessmentCount: number;
  snapshotCount: number;
  entryCount: number;
  applied: boolean;
}> {
  const applied = options.apply === true;
  const result = applied
    ? await db.transaction(async (tx) => {
        const plan = await createRepairPlan(tx);
        await applyRepairPlan(tx, plan);
        return plan;
      })
    : await createRepairPlan(db);

  return {
    assessmentCount: result.assessments.length,
    snapshotCount: result.sessions.length,
    entryCount: result.entries.length,
    applied,
  };
}
