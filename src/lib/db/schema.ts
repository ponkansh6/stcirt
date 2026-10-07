import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
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

// A certification submission is the stable five-question answer set. Edits
// update these rows in place; operation rows make retries safe and detect a
// reused operation ID with a different payload.
export const examAnswerSubmissions = sqliteTable("exam_answer_submissions", {
  id: text("id").primaryKey(),
  participantId: integer("participant_id")
    .notNull()
    .references(() => examParticipants.id, { onDelete: "cascade" }),
  questionIds: text("question_ids", { mode: "json" }).notNull().$type<number[]>(),
  revision: integer("revision").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const examSubmissionAnswers = sqliteTable(
  "exam_submission_answers",
  {
    submissionId: text("submission_id")
      .notNull()
      .references(() => examAnswerSubmissions.id, { onDelete: "cascade" }),
    questionId: integer("question_id")
      .notNull()
      .references(() => examQuestions.id, { onDelete: "cascade" }),
    selectedIndex: integer("selected_index"),
    freeText: text("free_text"),
    answerKind: text("answer_kind").notNull().default("selected"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.submissionId, t.questionId] }),
  }),
);

// One durable row per current free-response revision. Pending rows are retried
// by the authenticated internal worker; stale revisions cannot be applied.
export const examAnswerAssessments = sqliteTable(
  "exam_answer_assessments",
  {
    submissionId: text("submission_id")
      .notNull()
      .references(() => examAnswerSubmissions.id, { onDelete: "cascade" }),
    questionId: integer("question_id")
      .notNull()
      .references(() => examQuestions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    answerText: text("answer_text").notNull(),
    state: text("state").notNull(),
    claimToken: text("claim_token"),
    rawScore: real("raw_score"),
    normalizedScore: real("normalized_score"),
    confidence: real("confidence"),
    model: text("model"),
    rubricVersion: text("rubric_version").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }),
    gradedAt: integer("graded_at", { mode: "timestamp" }),
    errorCode: text("error_code"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.submissionId, t.questionId] }),
    dueIdx: index("exam_answer_assessments_due_idx").on(t.state, t.nextAttemptAt),
  }),
);

export const examSubmissionOperations = sqliteTable("exam_submission_operations", {
  operationId: text("operation_id").primaryKey(),
  submissionId: text("submission_id")
    .notNull()
    .references(() => examAnswerSubmissions.id, { onDelete: "cascade" }),
  payload: text("payload").notNull(),
  revision: integer("revision").notNull(),
});

// One durable presentation run is active at a time. Questions and entries are
// copied into immutable child rows when it starts so later exam edits or
// answer revisions cannot change the announced results.
export const presentationSessions = sqliteTable("presentation_sessions", {
  id: integer("id").primaryKey(),
  state: text("state").notNull(),
  version: integer("version").notNull(),
  questionIndex: integer("question_index").notNull(),
  questionCount: integer("question_count").notNull(),
  projectionHidden: integer("projection_hidden", { mode: "boolean" }).notNull().default(false),
  presentationMode: text("presentation_mode").notNull().default("full"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const presentationQuestions = sqliteTable(
  "presentation_questions",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => presentationSessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    sourceQuestionId: integer("source_question_id").notNull(),
    question: text("question").notNull(),
    choices: text("choices", { mode: "json" }).notNull().$type<string[]>(),
    correctIndex: integer("correct_index").notNull(),
    explanation: text("explanation"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sessionId, t.position] }) }),
);

export const presentationEntries = sqliteTable(
  "presentation_entries",
  {
    sessionId: integer("session_id")
      .notNull()
      .references(() => presentationSessions.id, { onDelete: "cascade" }),
    participantId: integer("participant_id").notNull(),
    displayName: text("display_name").notNull(),
    score: real("score").notNull(),
    rank: integer("rank").notNull(),
    answers: text("answers", { mode: "json" }).notNull().$type<
      {
        questionId: number;
        answerKind: "selected" | "freeText" | "legacy" | "unanswered";
        selectedIndex: number | null;
        freeText: string | null;
        rawScore: number | null;
        normalizedScore: number | null;
      }[]
    >(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sessionId, t.participantId] }) }),
);

export const presentationOperations = sqliteTable("presentation_operations", {
  operationId: text("operation_id").primaryKey(),
  action: text("action").notNull(),
  mode: text("mode"),
  version: integer("version").notNull(),
});

// Participant-facing result visibility is independent from the presentation
// screen's progression and standby state.
export const participantResultSettings = sqliteTable("participant_result_settings", {
  id: integer("id").primaryKey(),
  visible: integer("visible", { mode: "boolean" }).notNull().default(false),
});
