import { mkdir } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const output = ".hallmark/reduced-motion";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
try {
  for (const [name, route, width, height] of [
    ["answer-320", "/answer", 320, 800],
    ["presentation-320", "/presentation", 320, 800],
    ["presentation-1920", "/presentation", 1920, 1080],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:3001${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.evaluate(() => document.fonts?.ready);
    if (route === "/answer") {
      await page.locator('input[name="name"]').waitFor({ state: "visible", timeout: 15000 });
      await page.locator('input[name="pin"]').waitFor({ state: "visible", timeout: 5000 });
      await page.keyboard.press("Tab");
    }
    await page.waitForTimeout(800);
    const media = await page.evaluate(() => ({
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      heading: document.querySelector("h1")?.innerText.trim() || "(no heading)",
      activeAnimations: document
        .getAnimations()
        .filter((animation) => animation.playState === "running")
        .map((animation) => ({
          type: animation.constructor.name,
          name: animation.animationName || animation.transitionProperty || "(unnamed)",
          target:
            animation.effect?.target?.className?.toString?.() ||
            animation.effect?.target?.tagName ||
            "(none)",
        })),
    }));
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    process.stdout.write(`${name}: ${JSON.stringify(media)}\n`);
    await page.close();
  }
} finally {
  await browser.close();
}
