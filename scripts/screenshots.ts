import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

/**
 * The README's screenshots, taken from the seeded app: the live tournament
 * screen at 1280 and 390, and the standings at 390. Run against a server
 * started from the seed (`npm run seed && npm run build && npm run start`,
 * or the e2e server on port 3100):
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/screenshots.ts
 *
 * The files are checked in under docs/screenshots/ so the README renders
 * without a browser; re-run after a visual change.
 */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const OUT = join(process.cwd(), "docs", "screenshots");
const LIVE = "sandbar-classic-2026";

const SHOTS: Array<{ name: string; path: string; width: number; height: number; mobile: boolean }> = [
  { name: "live-tournament-1280.png", path: `/t/${LIVE}`, width: 1280, height: 860, mobile: false },
  { name: "live-tournament-390.png", path: `/t/${LIVE}`, width: 390, height: 844, mobile: true },
  { name: "bracket-1280.png", path: `/t/${LIVE}/bracket`, width: 1280, height: 860, mobile: false },
  { name: "standings-390.png", path: `/t/${LIVE}/standings`, width: 390, height: 844, mobile: true },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const shot of SHOTS) {
      const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 2, isMobile: shot.mobile, hasTouch: shot.mobile, colorScheme: "dark" });
      const page = await context.newPage();
      await page.goto(`${BASE_URL}${shot.path}`, { waitUntil: "networkidle" });
      await page.locator("main .animate-pulse").waitFor({ state: "detached" }).catch(() => undefined);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, shot.name), fullPage: false });
      process.stdout.write(`${shot.name}\n`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

void main();
