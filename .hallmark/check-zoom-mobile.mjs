import { writeFile } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
const report = [];
try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktop.goto("http://127.0.0.1:3001/answer", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await desktop.locator('input[name="name"]').waitFor({ state: "visible", timeout: 15000 });
  const readViewport = () =>
    desktop.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportScale: window.visualViewport?.scale ?? null,
    }));
  const before = await readViewport();
  let zoomShortcut = "Control+Equal";
  for (let index = 0; index < 8; index++) {
    await desktop.keyboard.press(zoomShortcut).catch(() => {});
    await desktop.waitForTimeout(100);
  }
  const after = await readViewport();
  report.push(
    `Browser zoom shortcut attempt (headless Chromium, desktop viewport 1280×800): before=${JSON.stringify(before)}; after=${JSON.stringify(after)}; shortcut=${zoomShortcut}; browser chrome itself is not exposed to Playwright.`,
  );
  const cdp = await desktop.context().newCDPSession(desktop);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 }).catch(() => {});
  const pinchScale = await readViewport();
  report.push(
    `CDP page-scale emulation at factor 2 (pinch/visual scale, not desktop browser zoom): ${JSON.stringify(pinchScale)}; layout reflow equivalence is not claimed.`,
  );
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }).catch(() => {});
  await cdp.detach();

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  await mobile.goto("http://127.0.0.1:3001/answer", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await mobile.locator('input[name="name"]').waitFor({ state: "visible", timeout: 15000 });
  await mobile.locator('input[name="name"]').focus();
  const mobileState = await mobile.evaluate(() => ({
    isMobileViewport: matchMedia("(pointer: coarse)").matches,
    virtualKeyboardApi: "virtualKeyboard" in navigator,
    activeElement:
      document.activeElement?.getAttribute("name") || document.activeElement?.tagName || "none",
    innerHeight: window.innerHeight,
    visualViewportHeight: window.visualViewport?.height ?? null,
    visualViewportScale: window.visualViewport?.scale ?? null,
  }));
  report.push(
    `Mobile emulation/focused input (not an OS keyboard): ${JSON.stringify(mobileState)}.`,
  );
  report.push(
    "Headless Playwright cannot display an operating-system virtual keyboard; any viewport/keyboard behavior from this context would be an emulation only.",
  );
  await mobileContext.close();
} finally {
  await browser.close();
}
const contents = `${report.join("\n")}\n`;
await writeFile(".hallmark/zoom-mobile.txt", contents);
process.stdout.write(contents);
