import { mkdir } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const output = process.argv[2];
if (!output) throw new Error("provide output directory");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
try {
  for (const [width, height] of [
    [320, 800],
    [1280, 800],
    [1920, 1080],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto("http://127.0.0.1:3001/answer", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.locator('input[name="name"]').waitFor({ state: "visible", timeout: 15000 });
    await page.locator('input[name="pin"]').waitFor({ state: "visible", timeout: 5000 });
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => ({
      title: document.querySelector("h1")?.innerText || "(no heading)",
      message:
        document.querySelector("#participant-form-message")?.innerText ||
        document.querySelector('[role="alert"]')?.innerText ||
        "(no form message)",
      labels: [...document.querySelectorAll("label")].map((el) => el.innerText.trim()),
    }));
    await page.screenshot({ path: `${output}/answer-${width}.png`, fullPage: true });
    process.stdout.write(`${width}px: ${JSON.stringify(state)}\n`);
    await page.close();
  }
} finally {
  await browser.close();
}
