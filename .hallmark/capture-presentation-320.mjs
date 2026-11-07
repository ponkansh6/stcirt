import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const output = ".hallmark/shots/presentation-first-prize-320.png";
await mkdir(".hallmark/shots", { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 800 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/presentation") {
      void request.respond({
        contentType: "application/json",
        body: JSON.stringify({ state: "first_prize" }),
      });
      return;
    }
    void request.continue();
  });

  await page.goto("http://127.0.0.1:3001/presentation", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => Boolean(document.querySelector("[class*='firstPrizeHeader'] h1")),
    { timeout: 30000 },
  );
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
    { timeout: 30000 },
  );

  const metrics = await page.evaluate(() => {
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
    const canvas = document.querySelector("[data-testid='presentation-canvas']");
    const fitLayer = document.querySelector("[data-testid='presentation-fit-layer']");
    const description = document.querySelector("[class*='firstPrizeDescription']");
    if (!canvas || !fitLayer || !description) {
      throw new Error("Required presentation measurement targets were not found.");
    }

    const fitScale = Number.parseFloat(
      getComputedStyle(fitLayer).getPropertyValue("--presentation-fit-scale"),
    );
    const descriptionFontSize = Number.parseFloat(getComputedStyle(description).fontSize);
    return {
      fitScale: +fitScale.toFixed(3),
      descriptionCssFontSize: +descriptionFontSize.toFixed(1),
      descriptionRenderedFontSize: +(descriptionFontSize * fitScale).toFixed(1),
      descriptionBounds: box(description),
      canvasBounds: box(canvas),
      horizontalOverflow:
        document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    };
  });

  const canvas = await page.$("[data-testid='presentation-canvas']");
  if (!canvas) throw new Error("Presentation canvas was not found.");
  await canvas.screenshot({ path: output });
  process.stdout.write(`${JSON.stringify(metrics)}\n`);
  await page.close();
} finally {
  await browser.close();
}
