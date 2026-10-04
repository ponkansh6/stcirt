import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql, desc } from "drizzle-orm";

export const knowledge = sqliteTable("knowledge", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  sourceText: text("source_text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const questions = sqliteTable("questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  knowledgeId: integer("knowledge_id")
    .notNull()
    .unique()
    .references(() => knowledge.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  choices: text("choices", { mode: "json" }).notNull().$type<string[]>(),
  correctIndex: integer("correct_index").notNull(),
  explanation: text("explanation"), // nullable: optional in API
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const answerLogs = sqliteTable(
  "answer_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionId: integer("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    selectedIndex: integer("selected_index").notNull(),
    isCorrect: integer("is_correct", { mode: "number" }).notNull().$type<0 | 1>(),
    answeredAt: integer("answered_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    questionIdIdx: index("answer_logs_question_id_idx").on(t.questionId),
    answeredAtIdx: index("answer_logs_answered_at_idx").on(t.answeredAt),
    questionAnsweredAtIdx: index("answer_logs_question_answered_at_idx").on(
      t.questionId,
      desc(t.answeredAt),
    ),
  }),
);

// The exam uses its own fixed five-question set and answer history. The
// original study tables above remain available but are not queried by STCIRT.
export const examQuestions = sqliteTable("exam_questions", {
  id: integer("id").primaryKey(),
  key: text("question_key").notNull().unique(),
  question: text("question").notNull(),
  choices: text("choices", { mode: "json" }).notNull().$type<string[]>(),
  correctIndex: integer("correct_index").notNull(),
  explanation: text("explanation"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const examParticipants = sqliteTable("exam_participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  normalizedName: text("normalized_name").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const participantRateLimits = sqliteTable("participant_rate_limits", {
  fingerprint: text("fingerprint").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStartedAt: integer("window_started_at", { mode: "timestamp" }).notNull(),
});

export const examAnswerLogs = sqliteTable(
  "exam_answer_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionId: integer("question_id")
      .notNull()
      .references(() => examQuestions.id, { onDelete: "cascade" }),
    participantId: integer("participant_id").references(() => examParticipants.id, {
      onDelete: "set null",
    }),
    selectedIndex: integer("selected_index").notNull(),
    isCorrect: integer("is_correct", { mode: "number" }).notNull().$type<0 | 1>(),
    answeredAt: integer("answered_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    questionIdIdx: index("exam_answer_logs_question_id_idx").on(t.questionId),
    participantIdIdx: index("exam_answer_logs_participant_id_idx").on(t.participantId),
    answeredAtIdx: index("exam_answer_logs_answered_at_idx").on(t.answeredAt),
    questionAnsweredAtIdx: index("exam_answer_logs_question_answered_at_idx").on(
      t.questionId,
      desc(t.answeredAt),
    ),
  }),
);
