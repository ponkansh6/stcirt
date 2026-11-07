import { writeFile } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
const rows = [];
try {
  for (const [width, height] of [
    [320, 800],
    [1280, 800],
    [1920, 1080],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto("http://127.0.0.1:3001/presentation", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(1600);
    rows.push(
      await page.evaluate(() => {
        const box = (el) => {
          const r = el?.getBoundingClientRect();
          return r
            ? {
                x: +r.x.toFixed(1),
                y: +r.y.toFixed(1),
                width: +r.width.toFixed(1),
                height: +r.height.toFixed(1),
              }
            : null;
        };
        const layer = document.querySelector("[data-testid='presentation-natural-layer']");
        const transform = document.querySelector("[data-testid='presentation-fit-layer']");
        const canvas = document.querySelector("[class*='canvas']");
        const title = document.querySelector("[class*='firstPrizeHeader'] h1");
        const description = document.querySelector("[class*='firstPrizeDescription']");
        const images = [...document.querySelectorAll("[class*='firstPrizeImages'] img")].map(
          (el) => ({
            alt: el.getAttribute("alt"),
            box: box(el),
            fontSize: getComputedStyle(el).fontSize,
            opacity: getComputedStyle(el).opacity,
            loaded: el.complete && el.naturalWidth > 0,
          }),
        );
        return {
          viewport: { width: innerWidth, height: innerHeight },
          state: document.querySelector("h1")?.innerText.trim() || "(no heading)",
          scale: getComputedStyle(transform).getPropertyValue("--presentation-fit-scale").trim(),
          canvas: box(canvas),
          naturalLayer: layer
            ? {
                box: box(layer),
                offsetWidth: layer.offsetWidth,
                offsetHeight: layer.offsetHeight,
                scrollWidth: layer.scrollWidth,
                scrollHeight: layer.scrollHeight,
              }
            : null,
          title: title
            ? {
                text: title.innerText.trim(),
                box: box(title),
                fontSize: getComputedStyle(title).fontSize,
              }
            : null,
          description: description
            ? {
                text: description.innerText.trim(),
                box: box(description),
                fontSize: getComputedStyle(description).fontSize,
              }
            : null,
          images,
          horizontalOverflow:
            document.documentElement.scrollWidth > innerWidth ||
            document.body.scrollWidth > innerWidth,
        };
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
const report = `${JSON.stringify(rows, null, 2)}\n`;
await writeFile(".hallmark/presentation-fit-metrics.json", report);
process.stdout.write(report);
