import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("preserves anonymous answer rows when migration 0002 adds participant attribution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stcirt-migration-test-"));
    const client = createClient({ url: `file:${dir}/migration.db` });
    try {
      await client.execute(`
        CREATE TABLE exam_questions (
          id integer PRIMARY KEY NOT NULL,
          question_key text NOT NULL,
          question text NOT NULL,
          choices text NOT NULL,
          correct_index integer NOT NULL,
          explanation text,
          created_at integer DEFAULT (unixepoch()) NOT NULL
        );
      `);
      await client.execute(`
        CREATE TABLE exam_answer_logs (
          id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          question_id integer NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
          selected_index integer NOT NULL,
          is_correct integer NOT NULL,
          answered_at integer DEFAULT (unixepoch()) NOT NULL
        );
      `);
      await client.execute(
        "INSERT INTO exam_questions (id, question_key, question, choices, correct_index) VALUES (1, 'q1', 'Question?', '[\"A\",\"B\"]', 0)",
      );
      await client.execute(
        "INSERT INTO exam_answer_logs (question_id, selected_index, is_correct) VALUES (1, 1, 0)",
      );

      const migration = readFileSync(
        join(process.cwd(), "src/lib/db/migrations/0002_nifty_eddie_brock.sql"),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.execute(statement);
      }
      const batchMigration = readFileSync(
        join(process.cwd(), "src/lib/db/migrations/0003_calm_five.sql"),
        "utf8",
      );
      for (const statement of batchMigration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.execute(statement);
      }

      const result = await client.execute(
        "SELECT id, question_id, selected_index, is_correct, participant_id FROM exam_answer_logs",
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        id: 1,
        question_id: 1,
        selected_index: 1,
        is_correct: 0,
        participant_id: null,
      });
      const batchTables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('exam_answer_submissions', 'exam_submission_answers', 'exam_submission_operations') ORDER BY name",
      );
      expect(batchTables.rows.map((row) => row.name)).toEqual([
        "exam_answer_submissions",
        "exam_submission_answers",
        "exam_submission_operations",
      ]);
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies migration 0003 to a new database after the base migrations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stcirt-migration-fresh-"));
    const client = createClient({ url: `file:${dir}/migration.db` });
    try {
      for (const file of [
        "0001_brainy_lizard.sql",
        "0002_nifty_eddie_brock.sql",
        "0003_calm_five.sql",
      ]) {
        const sql = readFileSync(join(process.cwd(), "src/lib/db/migrations", file), "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim()) await client.execute(statement);
        }
      }
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'exam_submission_%' ORDER BY name",
      );
      expect(tables.rows.map((row) => row.name)).toEqual([
        "exam_submission_answers",
        "exam_submission_operations",
      ]);
      const submissions = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'exam_answer_submissions'",
      );
      expect(submissions.rows).toHaveLength(1);
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills saved question-five choices as legacy without converting their index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stcirt-fifth-question-migration-"));
    const client = createClient({ url: `file:${dir}/migration.db` });
    try {
      await client.execute(
        `CREATE TABLE exam_questions (id integer PRIMARY KEY, question_key text NOT NULL, question text NOT NULL, choices text NOT NULL, correct_index integer NOT NULL, explanation text, created_at integer DEFAULT (unixepoch()) NOT NULL);`,
      );
      await client.execute(
        `CREATE TABLE exam_answer_submissions (id text PRIMARY KEY, participant_id integer NOT NULL, question_ids text NOT NULL, revision integer NOT NULL, created_at integer DEFAULT (unixepoch()) NOT NULL, updated_at integer DEFAULT (unixepoch()) NOT NULL);`,
      );
      await client.execute(
        `CREATE TABLE exam_submission_answers (submission_id text NOT NULL, question_id integer NOT NULL, selected_index integer NOT NULL, PRIMARY KEY(submission_id, question_id));`,
      );
      await client.execute(
        `INSERT INTO exam_questions (id, question_key, question, choices, correct_index) VALUES (4, 'it-literacy-004', 'Q4', '["A","B"]', 0), (5, 'it-literacy-005', 'Old Q5', '["Old A","Old B"]', 1)`,
      );
      await client.execute(
        "INSERT INTO exam_answer_submissions (id, participant_id, question_ids, revision) VALUES ('submission', 1, '[4,5]', 1)",
      );
      await client.execute(
        "INSERT INTO exam_submission_answers (submission_id, question_id, selected_index) VALUES ('submission', 4, 1), ('submission', 5, 1)",
      );

      const migration = readFileSync(
        join(process.cwd(), "src/lib/db/migrations/0007_fifth_free_response_jev.sql"),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.execute(statement);
      }

      const rows = await client.execute(
        "SELECT question_id, selected_index, free_text, answer_kind FROM exam_submission_answers ORDER BY question_id",
      );
      expect(rows.rows).toEqual([
        { question_id: 4, selected_index: 1, free_text: null, answer_kind: "selected" },
        { question_id: 5, selected_index: 1, free_text: null, answer_kind: "legacy" },
      ]);
      const question = await client.execute(
        "SELECT question, choices FROM exam_questions WHERE id = 5",
      );
      expect(question.rows[0]?.choices).toBe("[]");
      expect(question.rows[0]?.question).toContain("文章で説明してください");
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migration 0011 clears old answers and presentation snapshots while keeping operation history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stcirt-reset-migration-test-"));
    const client = createClient({ url: `file:${dir}/migration.db` });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await client.execute(
        "CREATE TABLE exam_answer_logs (id integer PRIMARY KEY, selected_index integer NOT NULL)",
      );
      await client.execute(
        "CREATE TABLE exam_answer_submissions (id text PRIMARY KEY, participant_id integer NOT NULL)",
      );
      await client.execute("CREATE TABLE presentation_sessions (id integer PRIMARY KEY)");
      await client.execute(`
        CREATE TABLE presentation_questions (
          session_id integer NOT NULL REFERENCES presentation_sessions(id) ON DELETE CASCADE,
          position integer NOT NULL,
          PRIMARY KEY (session_id, position)
        )
      `);
      await client.execute(`
        CREATE TABLE presentation_entries (
          session_id integer NOT NULL REFERENCES presentation_sessions(id) ON DELETE CASCADE,
          participant_id integer NOT NULL,
          PRIMARY KEY (session_id, participant_id)
        )
      `);
      await client.execute("CREATE TABLE presentation_operations (operation_id text PRIMARY KEY)");
      await client.execute(
        "CREATE TABLE participant_result_settings (id integer PRIMARY KEY, visible integer NOT NULL)",
      );
      await client.execute("INSERT INTO exam_answer_logs VALUES (1, 2)");
      await client.execute("INSERT INTO exam_answer_submissions VALUES ('submission-1', 7)");
      await client.execute("INSERT INTO presentation_sessions VALUES (1)");
      await client.execute("INSERT INTO presentation_questions VALUES (1, 0)");
      await client.execute("INSERT INTO presentation_entries VALUES (1, 7)");
      await client.execute("INSERT INTO presentation_operations VALUES ('operation-1')");
      await client.execute("INSERT INTO participant_result_settings VALUES (1, 1)");

      const migration = readFileSync(
        join(process.cwd(), "src/lib/db/migrations/0011_reset_exam_submissions.sql"),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.execute(statement);
      }

      for (const table of [
        "exam_answer_logs",
        "exam_answer_submissions",
        "presentation_sessions",
        "presentation_questions",
        "presentation_entries",
      ]) {
        const rows = await client.execute(`SELECT * FROM ${table}`);
        expect(rows.rows, `${table} should be cleared`).toHaveLength(0);
      }
      const settings = await client.execute(
        "SELECT visible FROM participant_result_settings WHERE id = 1",
      );
      expect(settings.rows[0]?.visible).toBe(0);
      const operations = await client.execute("SELECT operation_id FROM presentation_operations");
      expect(operations.rows).toEqual([{ operation_id: "operation-1" }]);
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
