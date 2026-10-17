#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// Keep this list in sync with the named projects in playwright.config.ts. A
// missing project or a project with no registered tests must block the suite.
const projects = [
  { name: "chromium", tag: "@chromium", reportDir: "playwright-report/e2e-push-chromium" },
  {
    name: "Mobile Chrome",
    tag: "@mobile",
    reportDir: "playwright-report/e2e-push-mobile-chrome",
  },
];
const recognizedTags = projects.map(({ tag }) => tag);
const unionTagPattern = recognizedTags.join("|");
const listTotalPattern = /^Total: (\d+) tests? in (\d+) files?$/gm;

function caseRows(output, name, description) {
  const totals = [...output.matchAll(listTotalPattern)];
  if (totals.length !== 1) {
    throw new Error(
      `Could not parse Playwright --list summary for ${description} in project ${JSON.stringify(name)}.`,
    );
  }

  const count = Number(totals[0][1]);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(
      `Playwright --list found no cases for ${description} in project ${JSON.stringify(name)}.`,
    );
  }

  const rows = output.split(/\r?\n/).filter((line) => /^  \[/.test(line));
  if (rows.length !== count) {
    throw new Error(
      `Could not validate Playwright --list cases for ${description} in project ${JSON.stringify(name)}: ` +
        `summary reported ${count}, parsed ${rows.length}.`,
    );
  }
  return rows;
}

function parseCaseRow(line) {
  const match = line.match(/^  \[(.*?)\] › .+:\d+:\d+ › (.+)$/);
  if (!match) return null;

  const title = match[2];
  const tags = recognizedTags.filter((tag) => new RegExp(`(?:^|\\s)${tag}(?:\\s|$)`).test(title));
  return { project: match[1], title, tags };
}

function validateTaggedRows(rows, { name, tag }, description, { requireExpectedTag = true } = {}) {
  const invalid = rows.find((line) => {
    const parsed = parseCaseRow(line);
    return (
      !parsed ||
      parsed.project !== name ||
      parsed.tags.length !== 1 ||
      (requireExpectedTag && parsed.tags[0] !== tag)
    );
  });
  if (invalid) {
    throw new Error(
      `Playwright --list returned a case outside project ${JSON.stringify(name)} ` +
        `or without exactly one recognized project tag${requireExpectedTag ? ` ${tag}` : ""} ` +
        `in ${description}: ${invalid}`,
    );
  }
}

function runPlaywright(args, { capture = false, reportDir } = {}) {
  const result = spawnSync("playwright", ["test", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PLAYWRIGHT_HTML_OPEN: "never",
      ...(reportDir ? { PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir } : {}),
    },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw new Error(`Could not start Playwright: ${result.error.message}`);
  }

  return result;
}

if (
  new Set(projects.map(({ name }) => name)).size !== projects.length ||
  projects.some(({ name, tag, reportDir }) => !name || !tag || !reportDir)
) {
  console.error(
    "[e2e:push] Expected project names, tags, and report directories must be unique and non-empty.",
  );
  process.exit(1);
}

for (const project of projects) {
  try {
    const selectors = [`--project=${project.name}`, `--grep=${project.tag}`];
    const lists = [
      { label: "unfiltered", args: [`--project=${project.name}`] },
      { label: "tag union", args: [`--project=${project.name}`, `--grep=${unionTagPattern}`] },
      { label: "selected", args: selectors },
    ];
    const outputs = new Map();

    for (const list of lists) {
      const result = runPlaywright(["--list", ...list.args], { capture: true });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status !== 0) {
        console.error(
          `[e2e:push] Playwright --list (${list.label}) failed for ${JSON.stringify(project.name)}.`,
        );
        process.stderr.write(output);
        process.exit(result.status ?? 1);
      }
      outputs.set(list.label, result.stdout ?? "");
    }

    const unfilteredRows = caseRows(outputs.get("unfiltered"), project.name, "unfiltered listing");
    const unionRows = caseRows(outputs.get("tag union"), project.name, "tag union listing");
    const selectedRows = caseRows(outputs.get("selected"), project.name, "selected listing");

    if (unfilteredRows.length !== unionRows.length) {
      throw new Error(
        `Tag union omitted E2E cases in project ${JSON.stringify(project.name)}: ` +
          `${unionRows.length} tagged of ${unfilteredRows.length} registered.`,
      );
    }
    if (unfilteredRows.some((row, index) => row !== unionRows[index])) {
      throw new Error(
        `Tag union does not match the unfiltered case listing for project ${JSON.stringify(project.name)}.`,
      );
    }

    validateTaggedRows(unionRows, project, "tag union listing", { requireExpectedTag: false });
    validateTaggedRows(selectedRows, project, "selected listing");
    console.log(
      `[e2e:push] ${project.name}: ${selectedRows.length} registered case(s) tagged ${project.tag}; ` +
        `all ${unfilteredRows.length} cases have exactly one recognized project tag`,
    );
  } catch (error) {
    console.error(`[e2e:push] ${error.message}`);
    process.exit(1);
  }
}

for (const project of projects) {
  console.log(
    `[e2e:push] Running ${project.name} cases tagged ${project.tag} ` +
      `(HTML report: ${project.reportDir}).`,
  );
  const selectors = [`--project=${project.name}`, `--grep=${project.tag}`];
  const result = runPlaywright([...selectors, "--workers=1", "--reporter=list,html"], {
    reportDir: project.reportDir,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
