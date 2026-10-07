// @vitest-environment node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const checkerPath = join(root, "scripts/check-coverage-completeness.mjs");
const sourceRoot = join(root, "src");
const metrics = ["statements", "branches", "functions", "lines"] as const;
const temporaryDirectories: string[] = [];

function collectIncludedSources(directory = sourceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectIncludedSources(path);
    if (!entry.isFile() || ![".ts", ".tsx", ".css"].includes(extname(path))) return [];

    const relativePath = relative(root, path).split("\\").join("/");
    if (
      relativePath === "src/lib/db/schema.ts" ||
      relativePath.startsWith("src/lib/db/migrations/")
    ) {
      return [];
    }
    return [path];
  });
}

const includedSources = collectIncludedSources();
const pureTypeSource = join(root, "src/types/quiz.ts");

function metric(total: number, covered: number) {
  return { total, covered, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 };
}

function makeReport(options: { omit?: string; zero?: string[]; uncovered?: string[] } = {}) {
  const report: Record<string, unknown> = {};
  const zeroPaths = new Set(options.zero ?? []);
  const uncoveredPaths = new Set(options.uncovered ?? []);
  const globalTotals = Object.fromEntries(
    metrics.map((name) => [name, { total: 0, covered: 0 }]),
  ) as Record<(typeof metrics)[number], { total: number; covered: number }>;

  for (const sourcePath of includedSources) {
    if (sourcePath === options.omit) continue;
    const isZero = zeroPaths.has(sourcePath);
    const covered = uncoveredPaths.has(sourcePath) ? 0 : 1;
    for (const name of metrics) {
      globalTotals[name].total += isZero ? 0 : 1;
      globalTotals[name].covered += isZero ? 0 : covered;
    }
    report[sourcePath] = Object.fromEntries(
      metrics.map((name) => [name, metric(isZero ? 0 : 1, isZero ? 0 : covered)]),
    );
  }

  report.total = Object.fromEntries(
    metrics.map((name) => [name, metric(globalTotals[name].total, globalTotals[name].covered)]),
  );
  return report;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "coverage-completeness-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeReport(directory: string, report: unknown) {
  const path = join(directory, "coverage-summary.json");
  await writeFile(path, JSON.stringify(report));
  return path;
}

function runNode(args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    signal: result.signal,
    command: process.execPath,
    args,
  };
}

function runChecker(reportPath: string) {
  return runNode([checkerPath, reportPath]);
}

function childDiagnostic(result: ReturnType<typeof runChecker>) {
  return [
    `command: ${result.command} ${result.args.join(" ")}`,
    `error: ${result.error?.stack ?? "none"}`,
    `signal: ${result.signal ?? "none"}`,
    `stdout: ${JSON.stringify(result.stdout)}`,
    `stderr: ${JSON.stringify(result.stderr)}`,
  ].join("\n");
}

function expectExit(result: ReturnType<typeof runChecker>, status: number) {
  expect(result.error, childDiagnostic(result)).toBeUndefined();
  expect(result.signal, childDiagnostic(result)).toBeNull();
  expect(result.status, childDiagnostic(result)).toBe(status);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("coverage completeness checker", () => {
  it("reports a missing coverage report", async () => {
    const directory = await temporaryDirectory();
    const result = runChecker(join(directory, "missing.json"));

    expectExit(result, 1);
  });

  it("rejects an empty report without a global summary", async () => {
    const path = await writeReport(await temporaryDirectory(), {});
    const result = runChecker(path);

    expectExit(result, 1);
  });

  it("reports an included source that is absent from the summary", async () => {
    const missingSource = includedSources[0]!;
    expect(missingSource).toBeDefined();
    const path = await writeReport(await temporaryDirectory(), makeReport({ omit: missingSource }));
    const result = runChecker(path);

    expectExit(result, 1);
  });

  it("accepts a well-formed summary containing the included source manifest", async () => {
    const path = await writeReport(await temporaryDirectory(), makeReport());
    const result = runChecker(path);

    expectExit(result, 0);
  });

  it("allows CSS files with zero totals", async () => {
    const cssPath = includedSources.find((path) => extname(path) === ".css")!;
    expect(cssPath).toBeDefined();
    const path = await writeReport(await temporaryDirectory(), makeReport({ zero: [cssPath] }));
    const result = runChecker(path);

    expectExit(result, 0);
  });

  it("allows a pure type-only TS/TSX source with zero totals", async () => {
    expect(includedSources).toContain(pureTypeSource);
    const path = await writeReport(
      await temporaryDirectory(),
      makeReport({ zero: [pureTypeSource] }),
    );
    const result = runChecker(path);

    expectExit(result, 0);
  });

  it("rejects an executable source with zero totals", async () => {
    const executableSource = includedSources.find(
      (path) => extname(path) !== ".css" && path !== pureTypeSource,
    )!;
    expect(executableSource).toBeDefined();
    const path = await writeReport(
      await temporaryDirectory(),
      makeReport({ zero: [executableSource] }),
    );
    const result = runChecker(path);

    expectExit(result, 1);
  });

  it("accepts valid nonzero totals with 0% coverage because Vitest thresholds enforce percentages", async () => {
    const path = await writeReport(
      await temporaryDirectory(),
      makeReport({ uncovered: includedSources }),
    );
    const result = runChecker(path);

    expectExit(result, 0);
  });
});
