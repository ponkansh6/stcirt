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
    expect(parsed.reduce((count, table) => count + table.columns.length, 0)).toBe(104);
  });
});
