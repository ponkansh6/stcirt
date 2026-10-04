import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    exclude: ["tests/e2e/**", "node_modules", ".next"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**"],
      // Declarative/auto-generated files with no branching logic are excluded:
      // codemap.md (docs), schema.ts (Drizzle table definitions), migrations/** (generated SQL).
      exclude: ["src/**/codemap.md", "src/lib/db/schema.ts", "src/lib/db/migrations/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
