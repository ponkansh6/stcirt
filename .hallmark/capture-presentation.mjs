import { writeFile } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const output = process.argv[2] || ".hallmark/shots";
const evidence = [];
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
try {
  for (const [width, height] of [
    [320, 800],
    [1280, 800],
    [1920, 1080],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const startedAt = Date.now();
    await page.goto("http://127.0.0.1:3001/presentation", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForFunction(
      () => {
        const images = [...document.querySelectorAll("[class*='firstPrizeImages'] img")];
        return (
          images.length === 2 &&
          images.every(
            (image) =>
              image.complete &&
              image.naturalWidth > 0 &&
              Number(getComputedStyle(image).opacity) >= 0.99,
          )
        );
      },
      undefined,
      { timeout: 30000 },
    );
    const waitMs = Date.now() - startedAt;
    const state = await page.evaluate(() => {
      const slide = document.querySelector("main");
      const box = (element) => {
        const rect = element?.getBoundingClientRect();
        return rect
          ? {
              x: +rect.x.toFixed(1),
              y: +rect.y.toFixed(1),
              width: +rect.width.toFixed(1),
              height: +rect.height.toFixed(1),
            }
          : null;
      };
      const fit = document.querySelector("[data-testid='presentation-fit-layer']");
      const natural = document.querySelector("[data-testid='presentation-natural-layer']");
      return {
        heading: slide?.querySelector("h1")?.innerText.trim() || "(no heading)",
        visibleHeadings: [...(slide?.querySelectorAll("h1,h2,h3") || [])].map((el) =>
          el.innerText.trim(),
        ),
        slideText: slide?.innerText.trim() || "",
        certificate:
          slide?.querySelector("[class*='certificateLabel']")?.textContent?.trim() || null,
        slide: slide?.getAttribute("aria-label") || null,
        firstPrizePresent: Boolean(slide?.querySelector("[class*='firstPrize']")),
        canvas: box(document.querySelector("[class*='canvas']")),
        fitViewport: box(document.querySelector("[data-testid='presentation-fit-viewport']")),
        naturalContent: natural
          ? {
              box: box(natural),
              scrollWidth: natural.scrollWidth,
              scrollHeight: natural.scrollHeight,
            }
          : null,
        fitScale: fit
          ? getComputedStyle(fit).getPropertyValue("--presentation-fit-scale").trim()
          : null,
        images: [...(slide?.querySelectorAll("img") || [])].map((image) => ({
          alt: image.alt,
          src: image.getAttribute("src"),
          loaded: image.complete && image.naturalWidth > 0,
          naturalWidth: image.naturalWidth,
          opacity: getComputedStyle(image).opacity,
          box: box(image),
          hidden:
            getComputedStyle(image).visibility === "hidden" ||
            getComputedStyle(image).display === "none",
        })),
      };
    });
    evidence.push({ width, waitForFontsAndFirstPrizeImagesSettledMs: waitMs, ...state });
    await page.screenshot({ path: `${output}/presentation-${width}.png`, fullPage: true });
    process.stdout.write(`${width}px: ${JSON.stringify(state)}\n`);
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(
  `${output}/presentation-capture-state.json`,
  `${JSON.stringify(
    {
      route: "/presentation",
      protocol:
        "domcontentloaded + document.fonts.ready + actual current first-prize images loaded at opacity >= 0.99; no state forced",
      states: evidence,
    },
    null,
    2,
  )}\n`,
);
