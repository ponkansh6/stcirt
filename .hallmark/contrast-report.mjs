import { writeFile } from "node:fs/promises";
import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const routes = [
  ["/answer", "Participant state error and login form"],
  ["/results", "Results session recovery"],
  ["/presentation", "Current award slide"],
  ["/admin/presentation", "Admin PIN recovery"],
  ["/admin/presentation/reference-participants", "Reference settings"],
  ["/shared-results/plan113", "Invalid share token"],
];
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
const rows = [];
try {
  for (const [route, state] of routes) {
    for (const width of [320, 1280, 1920]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(`http://127.0.0.1:3001${route}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      if (route === "/answer") {
        await page.locator('input[name="name"]').waitFor({ state: "visible", timeout: 10000 });
        await page.locator('input[name="pin"]').waitFor({ state: "visible", timeout: 10000 });
      }
      await page.waitForTimeout(1600);
      const data = await page.evaluate(() => {
        const color = (value) => {
          const m = value.match(
            /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*\/\s*([\d.]+)|\s*,\s*([\d.]+))?\)/,
          );
          return m ? [+m[1], +m[2], +m[3], +(m[4] ?? m[5] ?? 1)] : null;
        };
        const composite = (top, bottom) =>
          top.map((v, i) => Math.round(v * top[3] + bottom[i] * (1 - top[3]))).concat(1);
        const linear = (v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (c) =>
          0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
        const ratio = (a, b) => {
          const x = luminance(a),
            y = luminance(b);
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        const background = (el) => {
          const chain = [];
          for (let n = el; n; n = n.parentElement) chain.push(n);
          let current = [255, 255, 255, 1];
          for (const n of chain.reverse()) {
            const value = color(getComputedStyle(n).backgroundColor);
            if (value && value[3] > 0) current = composite(value, current);
          }
          return current;
        };
        const visible = (el) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          return (
            r.width > 0 &&
            r.height > 0 &&
            s.display !== "none" &&
            s.visibility !== "hidden" &&
            s.opacity !== "0"
          );
        };
        const items = [
          ...document.querySelectorAll("h1,h2,h3,p,button,a,label,input,textarea,dd,dt"),
        ]
          .filter(visible)
          .map((el) => {
            const s = getComputedStyle(el),
              fg = color(s.color),
              bg = background(el),
              opacity = Number(s.opacity || 1);
            if (!fg) return null;
            fg[3] *= opacity;
            const effectiveFg = composite(fg, bg);
            const size = parseFloat(s.fontSize);
            const large = size >= 24 || (size >= 18.67 && Number.parseInt(s.fontWeight, 10) >= 700);
            const threshold = large ? 3 : 4.5;
            return {
              type: el.tagName.toLowerCase(),
              text: (el.innerText || el.getAttribute("aria-label") || el.value || "")
                .trim()
                .replace(/\s+/g, " ")
                .slice(0, 48),
              size,
              fg: s.color,
              bg: `rgb(${bg.slice(0, 3).join(" ")})`,
              ratio: ratio(effectiveFg, bg),
              threshold,
            };
          })
          .filter(Boolean);
        const controls = [...document.querySelectorAll("input,textarea,select,button")]
          .filter(visible)
          .map((el) => {
            const s = getComputedStyle(el),
              border = color(s.borderTopColor),
              fill = color(s.backgroundColor),
              outside = background(el.parentElement),
              opacity = Number(s.opacity || 1);
            if (fill) fill[3] *= opacity;
            const boundary = Math.max(
              border ? ratio(composite(border, outside), outside) : 0,
              fill ? ratio(composite(fill, outside), outside) : 0,
            );
            return {
              text: (
                el.innerText ||
                el.getAttribute("aria-label") ||
                el.name ||
                el.placeholder ||
                ""
              )
                .trim()
                .slice(0, 36),
              border: s.borderTopColor,
              ratio: boundary || null,
            };
          });
        return {
          items: items
            .filter((x) => x.text)
            .sort((a, b) => a.ratio - b.ratio)
            .slice(0, 8),
          controls,
        };
      });
      await page.keyboard.press("Tab").catch(() => {});
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const parse = (v) => {
          const m = v.match(
            /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*\/\s*([\d.]+)|\s*,\s*([\d.]+))?\)/,
          );
          return m ? [+m[1], +m[2], +m[3], +(m[4] ?? m[5] ?? 1)] : null;
        };
        const srgb = (x) => {
          x /= 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        const y = (c) => 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]);
        const comp = (a, b) => a.map((x, i) => Math.round(x * a[3] + b[i] * (1 - a[3]))).concat(1);
        const stack = [];
        for (let n = el.parentElement; n; n = n.parentElement) stack.push(n);
        let bg = [255, 255, 255, 1];
        for (const n of stack.reverse()) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c[3]) bg = comp(c, bg);
        }
        const ring = parse(getComputedStyle(el).outlineColor);
        if (!ring) return null;
        const ratio = (Math.max(y(ring), y(bg)) + 0.05) / (Math.min(y(ring), y(bg)) + 0.05);
        return {
          target: el.tagName.toLowerCase(),
          name: el.getAttribute("aria-label") || el.name || el.innerText?.trim().slice(0, 36) || "",
          ring: getComputedStyle(el).outlineColor,
          ratio,
        };
      });
      rows.push({ route, state, width, ...data });
      rows[rows.length - 1].focus = focus;
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const report = rows
  .map((row) =>
    [
      `${row.route} · ${row.width}px · ${row.state}`,
      ...row.items.map(
        (x) =>
          `  text ${x.ratio.toFixed(2)}:1 (${x.threshold}:1 target): <${x.type}> ${x.text} · ${x.fg} over ${x.bg}`,
      ),
      ...row.controls
        .filter((x) => x.ratio !== null)
        .map((x) => `  control edge ${x.ratio.toFixed(2)}:1: ${x.text || "unnamed"} · ${x.border}`),
      ...(row.focus
        ? [
            `  keyboard focus ${row.focus.ratio.toFixed(2)}:1: <${row.focus.target}> ${row.focus.name} · ${row.focus.ring}`,
          ]
        : []),
    ].join("\n"),
  )
  .join("\n\n");
await writeFile(
  ".hallmark/contrast.txt",
  `${report}\n\nMethod: browser computed foreground and ancestor-composited solid CSS background colors at each visible element. Opacity is composited against that background. CSS images/pseudo-element pixels are not sampled; the formal sloplint pixel probe did not run. Only the rendered state per route was present, not every transient state.\n`,
);
process.stdout.write(`saved .hallmark/contrast.txt (${rows.length} route/width samples)\n`);
