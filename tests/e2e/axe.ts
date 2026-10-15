import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "./fixtures/test";

const ACCESSIBILITY_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
];

export async function expectNoAccessibilityViolations(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(ACCESSIBILITY_TAGS).analyze();

  const details = violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => `  ${node.target.join(", ")}\n    ${node.failureSummary ?? node.html}`)
        .join("\n");
      return `${violation.id} (${violation.impact ?? "unknown impact"}): ${violation.help}\n${nodes}`;
    })
    .join("\n\n");

  expect(violations, `axe violations in ${state}${details ? `:\n${details}` : ""}`).toEqual([]);
}
