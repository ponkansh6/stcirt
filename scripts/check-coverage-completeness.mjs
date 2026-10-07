#!/usr/bin/env node

/**
 * Ensures Vitest's coverage summary includes every configured TS/TSX/CSS source
 * file and that the report contains measurable coverage data.
 *
 * Usage:
 *   node scripts/check-coverage-completeness.mjs
 *   node scripts/check-coverage-completeness.mjs path/to/coverage-summary.json
 *   COVERAGE_JSON=path/to/coverage-summary.json node scripts/check-coverage-completeness.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_ROOT = resolve(ROOT, "src");
const METRICS = ["statements", "branches", "functions", "lines"];
const INCLUDED_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const EXCLUDED_RELATIVE_PATHS = new Set(["src/lib/db/schema.ts"]);
const EXCLUDED_RELATIVE_PREFIXES = ["src/lib/db/migrations/"];

function normalizePath(path) {
  const absolutePath = resolve(ROOT, path);
  return absolutePath.split(sep).join("/");
}

function sourceRelativePath(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function isIncludedSource(path) {
  const relativePath = sourceRelativePath(path);
  if (!relativePath.startsWith("src/")) return false;
  if (!INCLUDED_EXTENSIONS.has(extname(path))) return false;
  if (EXCLUDED_RELATIVE_PATHS.has(relativePath)) return false;
  return !EXCLUDED_RELATIVE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function collectSources(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      collectSources(path, files);
    } else if (entry.isFile() && isIncludedSource(path)) {
      files.push(path);
    }
  }
  return files;
}

/** Remove comments while preserving strings and line boundaries for the conservative scanner. */
function stripComments(source) {
  let result = "";
  let quote = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      if (index < source.length) result += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") result += "\n";
        index += 1;
      }
      if (index >= source.length) return null;
      index += 1;
      result += " ";
    } else {
      result += char;
    }
  }

  if (quote) return null;
  return result;
}

function isTypeOnlyImportLine(line) {
  return /^import\s+type\s+(?:[$\w]+\s*,\s*)?(?:[$\w]+|\{[^{}]+\})\s+from\s+(["'])[^"']+\1\s*;?$/.test(
    line,
  );
}

function isTypeAliasLine(line) {
  return /^(?:export\s+)?type\s+[$\w]+(?:\s*<[^{};]+>)?\s*=\s*[^{};]+;?$/.test(line);
}

function isInterfacePropertyLine(line) {
  return /^(?:readonly\s+)?(?:[$\w]+|["'][^"']+["'])\??\s*:\s*[A-Za-z0-9_$.[\]()<>,? |&:'"-]+;?$/.test(
    line,
  );
}

/**
 * Allow zero-count files only when a conservative scanner recognizes every
 * non-comment line as a type-only import, alias, or interface property.
 * Unsupported syntax fails closed instead of depending on a TS parser API.
 */
function isPureTypeSource(path) {
  const uncommented = stripComments(readFileSync(path, "utf8"));
  if (uncommented === null) return false;
  const lines = uncommented
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  let insideInterface = false;
  let foundDeclaration = false;
  for (const line of lines) {
    if (insideInterface) {
      if (line === "}" || line === "};") {
        insideInterface = false;
      } else if (!isInterfacePropertyLine(line)) {
        return false;
      }
      continue;
    }

    if (isTypeOnlyImportLine(line) || isTypeAliasLine(line)) {
      foundDeclaration = true;
      continue;
    }

    if (
      /^(?:export\s+)?interface\s+[$\w]+(?:\s+extends\s+[$\w.]+(?:\s*,\s*[$\w.]+)*)?\s*\{$/.test(
        line,
      )
    ) {
      insideInterface = true;
      foundDeclaration = true;
      continue;
    }

    return false;
  }

  return foundDeclaration && !insideInterface;
}

function getCoveragePath(args) {
  const positional = [];
  let optionPath;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--coverage-json") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: "--coverage-json requires a path value." };
      }
      if (optionPath !== undefined) return { error: "Specify --coverage-json only once." };
      optionPath = value;
      index += 1;
    } else if (arg.startsWith("--coverage-json=")) {
      const value = arg.slice("--coverage-json=".length);
      if (!value || value.startsWith("-")) {
        return { error: "--coverage-json requires a path value." };
      }
      if (optionPath !== undefined) return { error: "Specify --coverage-json only once." };
      optionPath = value;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) return { error: "Specify only one positional coverage report path." };
  if (optionPath !== undefined && positional.length > 0) {
    return { error: "Use either a positional report path or --coverage-json, not both." };
  }

  const configuredPath =
    optionPath || positional[0] || process.env.COVERAGE_JSON || "coverage/coverage-summary.json";
  return { path: resolve(ROOT, configuredPath) };
}

function printUsageError(message) {
  console.error(`[coverage-completeness] ${message}`);
  console.error("Usage: node scripts/check-coverage-completeness.mjs [coverage-summary.json]");
  console.error(
    "   or: node scripts/check-coverage-completeness.mjs --coverage-json coverage-summary.json",
  );
}

function main() {
  const parsedPath = getCoveragePath(process.argv.slice(2));
  if (parsedPath.error) {
    printUsageError(parsedPath.error);
    process.exitCode = 2;
    return;
  }
  const reportPath = parsedPath.path;
  if (!existsSync(reportPath)) {
    console.error(`[coverage-completeness] Coverage report not found: ${reportPath}`);
    console.error("[coverage-completeness] Run 'pnpm test:coverage' first.");
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(
      `[coverage-completeness] Unable to read valid JSON from ${reportPath}: ${error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    !report.total ||
    typeof report.total !== "object"
  ) {
    console.error(
      `[coverage-completeness] Coverage report is empty or missing its global summary: ${reportPath}`,
    );
    process.exitCode = 1;
    return;
  }

  const errors = [];
  const normalizedReport = new Map();
  for (const [key, value] of Object.entries(report)) {
    if (key !== "total") normalizedReport.set(normalizePath(key), value);
  }

  for (const metric of METRICS) {
    const total = report.total[metric]?.total;
    if (!Number.isFinite(total) || total <= 0) {
      errors.push(`Global ${metric} total must be greater than zero (received ${String(total)}).`);
    }
  }

  const sources = collectSources(SOURCE_ROOT).sort();
  if (!sources.some((path) => [".ts", ".tsx"].includes(extname(path)))) {
    errors.push("No included TypeScript sources were found under src/.");
  }

  const manifest = new Set(sources.map(normalizePath));
  for (const reportPathKey of normalizedReport.keys()) {
    if (!manifest.has(reportPathKey)) {
      errors.push(`Unexpected source coverage entry: ${sourceRelativePath(reportPathKey)}`);
    }
  }

  const zeroCountAllowances = [];
  for (const sourcePath of sources) {
    const coverage = normalizedReport.get(normalizePath(sourcePath));
    const relativePath = sourceRelativePath(sourcePath);
    if (!coverage) {
      errors.push(`Missing source coverage entry: ${relativePath}`);
      continue;
    }

    const totals = METRICS.map((metric) => coverage[metric]?.total);
    if (totals.some((total) => !Number.isFinite(total) || total < 0)) {
      errors.push(`Invalid or missing metric totals for ${relativePath}.`);
      continue;
    }

    if (totals.every((total) => total === 0)) {
      if (extname(sourcePath) === ".css") {
        zeroCountAllowances.push(relativePath);
      } else if (isPureTypeSource(sourcePath)) {
        zeroCountAllowances.push(relativePath);
      } else {
        errors.push(`Executable source has zero totals for all metrics: ${relativePath}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("[coverage-completeness] Failed:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[coverage-completeness] Checked ${sources.length} included TS/TSX/CSS sources.`);
  if (zeroCountAllowances.length > 0) {
    console.log(
      `[coverage-completeness] Explicit zero-count allowances (CSS or pure type source): ${zeroCountAllowances.join(", ")}`,
    );
  }
  console.log(
    "[coverage-completeness] Every included source is present and the report contains measurable totals.",
  );
}

main();
