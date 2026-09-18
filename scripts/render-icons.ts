import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

/**
 * Rasterize the app icon for the web manifest and the iOS home screen from
 * the two SVG sources in public/: `icon.svg` (rounded, purpose "any") and
 * `icons/icon-maskable.svg` (full-bleed, glyph inside the safe zone). Run with
 * `npx tsx scripts/render-icons.ts` after changing either; the PNGs are
 * checked in so a clone needs no browser to build.
 */
const ROOT = process.cwd();
const TARGETS: Array<{ source: string; out: string; size: number }> = [
  { source: "public/icon.svg", out: "public/icons/icon-192.png", size: 192 },
  { source: "public/icon.svg", out: "public/icons/icon-512.png", size: 512 },
  { source: "public/icon.svg", out: "public/icons/apple-touch-icon.png", size: 180 },
  { source: "public/icons/icon-maskable.svg", out: "public/icons/icon-maskable-192.png", size: 192 },
  { source: "public/icons/icon-maskable.svg", out: "public/icons/icon-maskable-512.png", size: 512 },
];

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    for (const target of TARGETS) {
      const svg = readFileSync(join(ROOT, target.source), "utf8");
      const page = await browser.newPage({ viewport: { width: target.size, height: target.size }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg.replace(/width="64" height="64"/, `width="${target.size}" height="${target.size}"`)}</body></html>`);
      const png = await page.locator("svg").screenshot({ omitBackground: true });
      writeFileSync(join(ROOT, target.out), png);
      await page.close();
      process.stdout.write(`${target.out} ${png.length} bytes\n`);
    }
  } finally {
    await browser.close();
  }
}

void main();
