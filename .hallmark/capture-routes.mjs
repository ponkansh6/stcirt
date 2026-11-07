import { mkdir } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const base = "http://127.0.0.1:3001";
const output = process.argv[2] || ".hallmark/before";
const routes = [
  ["answer", "/answer"],
  ["results", "/results"],
  ["presentation", "/presentation"],
  ["admin-presentation", "/admin/presentation"],
  ["reference-participants", "/admin/presentation/reference-participants"],
  ["shared-results-token", "/shared-results/plan113"],
];
const widths = [320, 1280, 1920];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
try {
  for (const [name, route] of routes) {
    for (const width of widths) {
      const page = await browser.newPage({
        viewport: { width, height: width === 1920 ? 1080 : 800 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.evaluate(() => document.fonts?.ready);
      if (route === "/answer") {
        await page.locator('input[name="name"]').waitFor({ state: "visible", timeout: 10000 });
        await page.locator('input[name="pin"]').waitFor({ state: "visible", timeout: 10000 });
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
      const title = await page
        .locator("h1")
        .first()
        .textContent()
        .catch(() => "");
      process.stdout.write(
        `${name} ${width}px: ${title?.trim() || "(no heading)"}${errors.length ? `; page error: ${errors[0]}` : ""}\n`,
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}
