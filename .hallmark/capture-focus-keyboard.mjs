import { mkdir, readdir, writeFile } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const output = ".hallmark/focus";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
const observations = [];
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  await page.goto("http://127.0.0.1:3001/answer", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.locator('input[name="name"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('input[name="pin"]').waitFor({ state: "visible", timeout: 5000 });
  await page.locator("body").click({ position: { x: 2, y: 2 } });

  const captures = new Map([
    ["name", "answer-name-320.png"],
    ["pin", "answer-pin-320.png"],
    ["start", "answer-start-320.png"],
  ]);
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName?.toLowerCase() ?? "none",
        name: el?.getAttribute("name") || "",
        text: (el?.innerText || el?.getAttribute("aria-label") || el?.placeholder || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60),
        focusVisible: Boolean(el?.matches(":focus-visible")),
      };
    });
    observations.push({ tab: index + 1, ...state });
    const target =
      state.name === "name"
        ? "name"
        : state.name === "pin"
          ? "pin"
          : state.tag === "button" && state.text === "はじめる"
            ? "start"
            : null;
    if (target && state.focusVisible)
      await page.screenshot({ path: `${output}/${captures.get(target)}`, fullPage: true });
    if (target === "start") break;
  }
} finally {
  await browser.close();
}
const report = [
  "Playwright keyboard traversal on /answer, viewport 320×800; no field values entered and no form submitted.",
  ...observations.map(
    (item) =>
      `Tab ${item.tab}: <${item.tag}>${item.name ? ` name=${item.name}` : ""}${item.text ? ` text=${JSON.stringify(item.text)}` : ""}; :focus-visible=${item.focusVisible}`,
  ),
  "Captured targets: " +
    (await readdir(output))
      .filter((name) => name.endsWith(".png"))
      .sort()
      .join(", "),
  "Screenshots show the visible focus treatment for targets that matched :focus-visible.",
].join("\n");
await writeFile(".hallmark/focus-keyboard.txt", `${report}\n`);
process.stdout.write(`${report}\n`);
