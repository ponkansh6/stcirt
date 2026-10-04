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
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
