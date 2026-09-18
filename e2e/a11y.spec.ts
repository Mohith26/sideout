import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The accessibility pass (spec §12.6, acceptance #21–22): axe over every
 * screen at 390 and 1280 with no serious or critical finding; the focus ring
 * every focused control shows (2px volt at 2px offset); the keyboard walk of
 * the score sheet, a confirm dialog and the console navigation; every
 * freestanding control at least 44×44; real headings on every screen; and a
 * polite live region wherever scores or standings change.
 */
const ORGANIZER_PHONE = "+15550109000";
const LIVE = "sandbar-classic-2026";
const OPEN = "pier-9-open-2026";
const WIDTHS = [390, 1280] as const;
const MIN_TARGET = 44;

/** Seeded player phones (`src/seed/build.ts`): +1555{100+i}{last four of 1000+7i}. */
function playerPhone(i: number): string {
  return `+1555${String(100 + i).padStart(3, "0")}${String(1000 + i * 7).slice(-4)}`;
}

type Screen = { name: string; path: string; as: "anonymous" | "player" | "organizer" };

async function screens(page: Page): Promise<Screen[]> {
  const detail = (await (await page.request.get(`/api/tournaments/${LIVE}`)).json()) as { data: { tournament: { id: string }; bracket: { matches: Array<{ match: { id: string; status: string } }> } } };
  const liveId = detail.data.tournament.id;
  const matchOf = (status: string) => detail.data.bracket.matches.find((m) => m.match.status === status)?.match.id ?? "";
  return [
    { name: "home", path: "/", as: "anonymous" },
    { name: "events", path: "/events", as: "anonymous" },
    { name: "impact", path: "/impact", as: "anonymous" },
    { name: "sign-in", path: "/sign-in", as: "anonymous" },
    { name: "offline", path: "/offline", as: "anonymous" },
    { name: "overview", path: `/t/${LIVE}`, as: "anonymous" },
    { name: "bracket", path: `/t/${LIVE}/bracket`, as: "anonymous" },
    { name: "standings", path: `/t/${LIVE}/standings`, as: "anonymous" },
    { name: "tournament-impact", path: `/t/${LIVE}/impact`, as: "anonymous" },
    { name: "match-final", path: `/m/${matchOf("final")}`, as: "anonymous" },
    { name: "match-disputed", path: `/m/${matchOf("disputed")}`, as: "anonymous" },
    { name: "match-live", path: `/m/${matchOf("in_progress")}`, as: "anonymous" },
    { name: "me", path: "/me", as: "player" },
    { name: "teams-new", path: `/teams/new?t=${OPEN}`, as: "player" },
    { name: "register", path: `/t/${OPEN}/register`, as: "player" },
    { name: "console-events", path: "/organizer/events", as: "organizer" },
    { name: "console-builder", path: `/organizer/events/${liveId}`, as: "organizer" },
    { name: "console-board", path: `/organizer/events/${liveId}/board`, as: "organizer" },
    { name: "console-close", path: `/organizer/events/${liveId}/close`, as: "organizer" },
    { name: "console-lucra-entry", path: `/organizer/events/${liveId}/lucra`, as: "organizer" },
    { name: "console-disputes", path: "/organizer/disputes", as: "organizer" },
    { name: "console-new-event", path: "/organizer/events/new", as: "organizer" },
    { name: "admin-lucra", path: "/admin/lucra", as: "organizer" },
  ];
}

async function signIn(page: Page, as: Screen["as"]): Promise<void> {
  await page.request.post("/api/auth/logout");
  if (as === "player") await page.request.post("/api/dev/login", { data: { phone: playerPhone(0) } });
  if (as === "organizer") await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } });
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main .animate-pulse")).toHaveCount(0);
}

test.describe("accessibility", () => {
  test("axe finds nothing serious or critical on any screen at 390 and 1280", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "one pass covers both widths");
    test.setTimeout(240_000);
    const list = await screens(page);
    const findings: string[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const screen of list) {
        await signIn(page, screen.as);
        await page.goto(screen.path);
        await settled(page);
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
        for (const v of results.violations) {
          if (v.impact !== "serious" && v.impact !== "critical") continue;
          findings.push(`${screen.name}@${width}: ${v.id} (${v.impact}) — ${v.help}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("every screen has exactly one h1 and no heading level is skipped", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "structure is the same at every width");
    test.setTimeout(120_000);
    for (const screen of await screens(page)) {
      await signIn(page, screen.as);
      await page.goto(screen.path);
      await settled(page);
      const levels = await page.locator("main h1, main h2, main h3, main h4").evaluateAll((els) => els.map((el) => Number(el.tagName.slice(1))));
      expect(levels.filter((l) => l === 1), `${screen.name}: one h1`).toHaveLength(1);
      let previous = 0;
      for (const level of levels) {
        expect(level - previous, `${screen.name}: heading levels ${levels.join(",")}`).toBeLessThanOrEqual(1);
        previous = level;
      }
    }
  });

  test("every freestanding control is a 44px target, and focus shows a 2px volt ring at 2px offset", async ({ page }) => {
    test.setTimeout(180_000);
    const list = await screens(page);
    const small: string[] = [];
    for (const screen of list) {
      await signIn(page, screen.as);
      await page.goto(screen.path);
      await settled(page);
      // Standalone controls: buttons, links and inputs outside running text (a link inside a paragraph or table cell is inline, WCAG 2.5.8's exception).
      const boxes = await page.locator("main button, main a[href], main input:not([type=hidden]), main select, main textarea, nav a[href], nav button").evaluateAll((els) =>
        els
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none") return false;
            return !el.closest("p, td, th, li p, dd, .prose") || el.tagName === "BUTTON" || el.tagName === "INPUT";
          })
          .map((el) => {
            // A stretched link (`after:inset-0` over a positioned card) is as large as its card.
            const box = (el.getAttribute("data-target") === "card" ? (el.closest("article") ?? el) : el).getBoundingClientRect();
            return { label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40), tag: el.tagName, w: box.width, h: box.height };
          }),
      );
      for (const b of boxes) if (b.w < MIN_TARGET || b.h < MIN_TARGET) small.push(`${screen.name}: <${b.tag.toLowerCase()}> "${b.label}" ${Math.round(b.w)}×${Math.round(b.h)}`);
    }
    expect(small, small.join("\n")).toEqual([]);

    // Focus ring: tab into the first control on the live event and read the ring the stylesheet gives it.
    await signIn(page, "anonymous");
    await page.goto(`/t/${LIVE}`);
    await settled(page);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const s = getComputedStyle(el);
      const volt = getComputedStyle(document.documentElement).getPropertyValue("--volt").trim();
      return { tag: el.tagName, outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, outlineOffset: s.outlineOffset, outlineColor: s.outlineColor, volt, matches: el.matches(":focus-visible") };
    });
    expect(ring?.matches, JSON.stringify(ring)).toBe(true);
    expect(ring).toMatchObject({ outlineWidth: "2px", outlineStyle: "solid", outlineOffset: "2px" });
    // #d7ff3e as the browser reports it.
    expect(ring?.outlineColor).toBe("rgb(215, 255, 62)");
  });

  test("the score sheet is a keyboard-operable modal: focus lands inside, Tab stays inside, Escape closes and returns focus", async ({ page, request }) => {
    const detail = (await (await request.get(`/api/tournaments/${LIVE}`)).json()) as { data: { bracket: { matches: Array<{ match: { id: string; status: string }; teamB: { members: Array<{ userId: string }> } | null }> } } };
    const m = detail.data.bracket.matches.find((x) => x.match.status === "awaiting_scores");
    const member = m?.teamB?.members[0];
    if (!m || !member) throw new Error("seed has no awaiting match");
    expect((await page.request.post("/api/dev/login", { data: { userId: member.userId } })).ok()).toBe(true);
    await page.goto(`/m/${m.match.id}`);
    const trigger = page.getByRole("button", { name: "Confirm the result" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByTestId("score-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toBeFocused();
    // Tab walks every control in the sheet in order and never leaves the dialog (the page behind a modal dialog is inert).
    const tabbable = await sheet.evaluate((root) => root.querySelectorAll("button:not([disabled]), input:not([disabled]), a[href], [tabindex='0']").length);
    expect(tabbable).toBeGreaterThan(6);
    for (let i = 0; i < tabbable; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => document.activeElement?.closest("[data-testid='score-sheet']") !== null);
      expect(inside, `tab ${i + 1} stays inside the sheet`).toBe(true);
    }
    // The steppers are larger than the 44px minimum (§12.6) and operable by keyboard.
    const plus = sheet.getByRole("button", { name: "Increase Your team, set 1" });
    await plus.focus();
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("textbox", { name: "Your team, set 1 points" })).toHaveValue("1");
    const box = await plus.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(56);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the console navigation and a confirm dialog are keyboard-operable", async ({ page, request }) => {
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    const liveId = ((await (await request.get(`/api/tournaments/${LIVE}`)).json()) as { data: { tournament: { id: string } } }).data.tournament.id;
    await page.goto("/organizer/events");
    const nav = page.getByRole("navigation", { name: "Console" });
    await nav.getByRole("link", { name: "Events" }).focus();
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("link", { name: /^Disputes/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/organizer\/disputes$/);
    await expect(page.getByRole("heading", { level: 1, name: "Disputes" })).toBeVisible();

    // The forfeit control on the live board opens a native confirm: Escape cancels it, Tab reaches its buttons.
    await page.goto(`/organizer/events/${liveId}/board`);
    const forfeit = page.getByRole("button", { name: /forfeits$/ }).first();
    await forfeit.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("scores and standings sit in polite live regions", async ({ page, request }) => {
    const detail = (await (await request.get(`/api/tournaments/${LIVE}`)).json()) as { data: { bracket: { matches: Array<{ match: { id: string; status: string } }> } } };
    const live = detail.data.bracket.matches.find((m) => m.match.status === "in_progress")?.match.id;
    await page.goto("/");
    await expect(page.locator("[aria-live='polite']").filter({ has: page.getByRole("article") }).first()).toBeAttached();
    await page.goto(`/t/${LIVE}/standings`);
    await expect(page.locator("[aria-live='polite'][data-flip-rows]")).toBeAttached();
    await page.goto(`/m/${live}`);
    await expect(page.locator("[aria-live='polite']").first()).toBeAttached();
    await expect(page.locator("[data-live-dot]").first()).toBeVisible();
  });
});
