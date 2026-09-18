import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";

/**
 * The README's screenshots, taken from the seeded app: the live tournament
 * screen at 1280 and 390, the bracket at 1280 and the standings at 390 (2×),
 * plus Home, the open score sheet and the organizer console at both widths (1×)
 * for the design record. Run against a server started from the seed
 * (`npm run seed && npm run build && npm run start`, or the e2e server on
 * port 3100):
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/screenshots.ts
 *
 * The sheet and the console need a session, taken through `POST /api/dev/login`;
 * a server without that route (a production build without `SIDEOUT_DEV_LOGIN`)
 * skips those shots and says so. The files are checked in under
 * docs/screenshots/ so the README renders without a browser; re-run after a
 * visual change. `OUT` overrides the output directory.
 */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const OUT = process.env.OUT ?? join(process.cwd(), "docs", "screenshots");
const LIVE = "sandbar-classic-2026";
/** The seeded organizer (e2e/helpers.ts uses the same number). */
const ORGANIZER_PHONE = "+15550109000";

interface Shot {
  name: string;
  path: string;
  width: number;
  height: number;
  mobile: boolean;
  scale?: number;
  /** Sign in first: as an organizer, or as a member of team B of a match awaiting scores (the path then becomes that match). */
  as?: "organizer" | "awaiting-scores";
  /** A button to press before the capture (opens the score sheet). */
  press?: string;
}

const SHOTS: Shot[] = [
  { name: "live-tournament-1280.png", path: `/t/${LIVE}`, width: 1280, height: 860, mobile: false },
  { name: "live-tournament-390.png", path: `/t/${LIVE}`, width: 390, height: 844, mobile: true },
  { name: "bracket-1280.png", path: `/t/${LIVE}/bracket`, width: 1280, height: 860, mobile: false },
  { name: "standings-390.png", path: `/t/${LIVE}/standings`, width: 390, height: 844, mobile: true },
  { name: "home-1280.png", path: "/", width: 1280, height: 860, mobile: false, scale: 1 },
  { name: "home-390.png", path: "/", width: 390, height: 844, mobile: true, scale: 1 },
  { name: "score-sheet-1280.png", path: "", width: 1280, height: 860, mobile: false, scale: 1, as: "awaiting-scores", press: "Confirm the result" },
  { name: "score-sheet-390.png", path: "", width: 390, height: 844, mobile: true, scale: 1, as: "awaiting-scores", press: "Confirm the result" },
  { name: "console-1280.png", path: "/organizer/events", width: 1280, height: 860, mobile: false, scale: 1, as: "organizer" },
  { name: "console-390.png", path: "/organizer/events", width: 390, height: 844, mobile: true, scale: 1, as: "organizer" },
];

interface Session {
  organizerId: string | null;
  awaiting: { matchId: string; userId: string } | null;
}

/** Who to sign in as, from the public API and the seed's organizer phone; null when the dev login route is not compiled in. */
async function session(page: Page): Promise<Session | null> {
  const probe = await page.request.post(`${BASE_URL}/api/dev/login`, { data: {} });
  if (probe.status() === 404) return null;
  const detail = (await (await page.request.get(`${BASE_URL}/api/tournaments/${LIVE}`)).json()) as {
    data: { bracket: { matches: Array<{ match: { id: string; status: string }; teamB: { members: Array<{ userId: string }> } | null }> } };
  };
  const m = detail.data.bracket.matches.find((x) => x.match.status === "awaiting_scores");
  const member = m?.teamB?.members[0];
  const organizer = await page.request.post(`${BASE_URL}/api/dev/login`, { data: { phone: ORGANIZER_PHONE } });
  const organizerId = organizer.ok() ? (((await organizer.json()) as { data?: { user?: { id?: string } } }).data?.user?.id ?? null) : null;
  return { organizerId, awaiting: m && member ? { matchId: m.match.id, userId: member.userId } : null };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const probe = await browser.newPage();
    const who = await session(probe);
    await probe.close();
    for (const shot of SHOTS) {
      const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: shot.scale ?? 2, isMobile: shot.mobile, hasTouch: shot.mobile, colorScheme: "light" });
      const page = await context.newPage();
      let path = shot.path;
      if (shot.as) {
        if (!who) {
          process.stdout.write(`${shot.name}: skipped (no dev login route on this server)\n`);
          await context.close();
          continue;
        }
        const userId = shot.as === "organizer" ? who.organizerId : who.awaiting?.userId;
        if (!userId) throw new Error(`${shot.name}: no ${shot.as} session available from the seed`);
        if (shot.as === "awaiting-scores" && who.awaiting) path = `/m/${who.awaiting.matchId}`;
        const login = await page.request.post(`${BASE_URL}/api/dev/login`, { data: { userId } });
        if (!login.ok()) throw new Error(`${shot.name}: dev login answered ${login.status()}`);
      }
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
      await page.locator("main .animate-pulse").waitFor({ state: "detached" }).catch(() => undefined);
      if (shot.press) {
        await page.getByRole("button", { name: shot.press }).click();
        await page.waitForTimeout(600);
      }
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
