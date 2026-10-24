import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseExpectedSchema } = require("../../scripts/prod-schema-parser.cjs") as {
  parseExpectedSchema: (schemaContent: string) => Array<{
    tableName: string;
    columns: string[];
  }>;
};

const expectedSchemaManifest = [
  { tableName: "knowledge", columns: ["id", "title", "source_text", "created_at"] },
  {
    tableName: "questions",
    columns: [
      "id",
      "knowledge_id",
      "question",
      "choices",
      "correct_index",
      "explanation",
      "created_at",
    ],
  },
  {
    tableName: "answer_logs",
    columns: ["id", "question_id", "selected_index", "is_correct", "answered_at"],
  },
  {
    tableName: "exam_questions",
    columns: [
      "id",
      "question_key",
      "question",
      "choices",
      "correct_index",
      "explanation",
      "question_version",
      "created_at",
    ],
  },
  {
    tableName: "exam_participants",
    columns: ["id", "normalized_name", "display_name", "created_at"],
  },
  {
    tableName: "assisted_participants",
    columns: ["owner_participant_id", "target_participant_id", "created_at"],
  },
  {
    tableName: "participant_rate_limits",
    columns: ["fingerprint", "attempts", "window_started_at"],
  },
  {
    tableName: "exam_answer_logs",
    columns: ["id", "question_id", "participant_id", "selected_index", "is_correct", "answered_at"],
  },
  {
    tableName: "exam_answer_submissions",
    columns: [
      "id",
      "participant_id",
      "question_ids",
      "question_versions",
      "revision",
      "created_at",
      "updated_at",
    ],
  },
  {
    tableName: "exam_submission_answers",
    columns: ["submission_id", "question_id", "selected_index", "free_text", "answer_kind"],
  },
  {
    tableName: "exam_answer_assessments",
    columns: [
      "submission_id",
      "question_id",
      "revision",
      "answer_text",
      "question_version",
      "state",
      "claim_token",
      "raw_score",
      "normalized_score",
      "confidence",
      "model",
      "rubric_version",
      "attempts",
      "next_attempt_at",
      "graded_at",
      "error_code",
    ],
  },
  {
    tableName: "exam_submission_operations",
    columns: ["operation_id", "submission_id", "payload", "revision"],
  },
  {
    tableName: "presentation_sessions",
    columns: [
      "id",
      "state",
      "version",
      "question_index",
      "question_count",
      "snapshot_revision",
      "question_versions",
      "rubric_versions",
      "projection_hidden",
      "presentation_mode",
      "created_at",
    ],
  },
  {
    tableName: "presentation_questions",
    columns: [
      "session_id",
      "position",
      "source_question_id",
      "question",
      "choices",
      "correct_index",
      "explanation",
    ],
  },
  {
    tableName: "presentation_entries",
    columns: [
      "session_id",
      "participant_id",
      "display_name",
      "score",
      "rank",
      "answers",
      "is_aggregation_target",
    ],
  },
  {
    tableName: "presentation_operations",
    columns: ["operation_id", "action", "mode", "version", "aggregation_summary"],
  },
  {
    tableName: "participant_result_settings",
    columns: ["id", "visible", "ever_published"],
  },
];

const normalizeManifest = (manifest: typeof expectedSchemaManifest) =>
  manifest
    .map(({ tableName, columns }) => ({ tableName, columns: [...columns].sort() }))
    .sort((left, right) => left.tableName.localeCompare(right.tableName));

describe("production schema parser", () => {
  it("parses sqliteTable declarations split across multiple lines", () => {
    const parsed = parseExpectedSchema(`
      export const sample = sqliteTable(
        "sample_table",
        {
          id: integer(
            "id",
          ).primaryKey(),
          displayName: text("display_name").notNull(),
        },
      );
    `);

    expect(parsed).toEqual([{ tableName: "sample_table", columns: ["id", "display_name"] }]);
  });

  it("parses every table and column in the production schema source", () => {
    const schema = readFileSync(join(process.cwd(), "src/lib/db/schema.ts"), "utf8");
    const parsed = parseExpectedSchema(schema);

    expect(parsed).toHaveLength(17);
    expect(parsed.reduce((count, table) => count + table.columns.length, 0)).toBe(105);
    expect(normalizeManifest(parsed)).toEqual(normalizeManifest(expectedSchemaManifest));
  });
});
