import Database from "better-sqlite3";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Behaviour the phase-2b screens promise beyond rendering, against the same
 * production build as `screens.spec.ts`: the draw panel writes exactly what it
 * previewed, the bracket canvas tells a pan from a tap and yields to the page
 * (wheel and vertical touch), every freestanding control meets the 44px target,
 * the bracket and console badge stay on the type scale, the live board's
 * courts have accessible names, and saving an event without touching sponsors
 * leaves no sponsors audit row behind.
 */
const ORGANIZER_PHONE = "+15550109000";
const LIVE = "sandbar-classic-2026";
const OPEN = "pier-9-open-2026";
/** The database the e2e server writes (`playwright.config.ts`), read back for persisted state. */
const DATABASE = "data/sideout.e2e.db";
const MIN_TARGET = 44;
const LABEL_PX = 13;
const BODY_PX = 15;

type Envelope<T> = { ok: boolean; data: T };
type MeData = {
  teams: Array<{ tournament: { slug: string; status: string }; team: { status: string }; donation: unknown }>;
  invites: Array<{ tournament: { slug: string } }>;
  rewards: unknown[];
};

async function devLogin(request: APIRequestContext, phone: string): Promise<void> {
  const res = await request.post("/api/dev/login", { data: { phone } });
  expect(res.ok(), `dev login for ${phone}`).toBe(true);
}

/** Seeded player phones (`src/seed/build.ts`): +1555{100+i}{last four of 1000+7i}. */
function playerPhone(i: number): string {
  return `+1555${String(100 + i).padStart(3, "0")}${String(1000 + i * 7).slice(-4)}`;
}

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path);
  expect(res.ok(), `${path} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function tournamentId(request: APIRequestContext, slug: string): Promise<string> {
  return (await json<Envelope<{ tournament: { id: string } }>>(request, `/api/tournaments/${slug}`)).data.tournament.id;
}

async function expectTarget(locator: Locator, what: string): Promise<void> {
  await expect(locator, what).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(MIN_TARGET);
  expect(box!.width, `${what} width`).toBeGreaterThanOrEqual(MIN_TARGET);
}

/**
 * A fresh pool-to-bracket event built through the organizer and player APIs so
 * a test has its own event to draw or edit without touching the seeded ones:
 * a draft, or (with `teams`) one holding that many registered pairs with
 * registration closed. `firstPlayer` keeps the two projects on disjoint pairs;
 * the players stay free in every other event.
 */
async function ownEvent(request: APIRequestContext, opts: { teams: number; firstPlayer: number }): Promise<{ id: string; slug: string }> {
  const slug = `own-${test.info().project.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await devLogin(request, ORGANIZER_PHONE);
  const open = (await json<Envelope<{ tournament: { beneficiaryId: string } }>>(request, `/api/tournaments/${OPEN}`)).data.tournament;
  const day = Date.now() + 60 * 24 * 3_600_000;
  const created = await request.post("/api/admin/tournaments", {
    data: {
      slug,
      name: `Own Event ${test.info().project.name}`,
      beneficiaryId: open.beneficiaryId,
      venueName: "Test Courts",
      venueCity: "Santa Cruz",
      venueState: "CA",
      venueTimezone: "America/Los_Angeles",
      startsAt: day,
      endsAt: day + 8 * 3_600_000,
      format: "pool_to_bracket",
      division: "open",
      maxTeams: 16,
      entryDonationCents: 0,
      fundraisingGoalCents: 100000,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = ((await created.json()) as Envelope<{ tournament: { id: string } }>).data.tournament.id;
  if (opts.teams === 0) {
    await request.post("/api/auth/logout");
    return { id, slug };
  }
  expect((await request.patch(`/api/admin/tournaments/${id}`, { data: { status: "registration_open" } })).ok()).toBe(true);

  for (let k = 0; k < opts.teams; k += 1) {
    const captain = playerPhone(opts.firstPlayer + k * 2);
    const partner = playerPhone(opts.firstPlayer + k * 2 + 1);
    await devLogin(request, captain);
    const team = await request.post("/api/teams", { data: { tournamentSlug: slug, name: `Pair ${k + 1}`, partnerPhone: partner } });
    expect(team.status(), await team.text()).toBe(201);
    const teamId = ((await team.json()) as Envelope<{ id: string }>).data.id;
    await devLogin(request, partner);
    const joined = await request.post(`/api/teams/${teamId}/join`);
    expect(joined.ok(), await joined.text()).toBe(true);
    await devLogin(request, captain);
    const registered = await request.post(`/api/tournaments/${slug}/register`, { data: { teamId } });
    expect(registered.status(), await registered.text()).toBe(201);
  }

  await devLogin(request, ORGANIZER_PHONE);
  expect((await request.patch(`/api/admin/tournaments/${id}`, { data: { status: "registration_closed" } })).ok()).toBe(true);
  await request.post("/api/auth/logout");
  return { id, slug };
}

/** Audit actions recorded for a subject, oldest first: persisted state, read from the e2e database file. */
function auditActions(subjectId: string): string[] {
  const db = new Database(DATABASE, { readonly: true });
  try {
    return db
      .prepare("select action from audit_log where subject_id = ? order by created_at, id")
      .all(subjectId)
      .map((r) => (r as { action: string }).action);
  } finally {
    db.close();
  }
}

/**
 * The bracket canvas and its pan/zoom transform, read from the SVG the way the
 * browser lays it out. `ready` waits for hydration: the server renders the
 * identity transform, and the opening view is only derived once the canvas is measured.
 */
function canvasOf(page: Page): { svg: Locator; transform: () => Promise<{ x: number; y: number; k: number }>; ready: () => Promise<void> } {
  const svg = page.locator("svg[aria-label$='canvas. Use the arrow keys to move between matches and Enter to open one.']");
  const attr = () => svg.locator("> g").first().getAttribute("transform");
  return {
    svg,
    transform: async () => {
      const t = await attr();
      const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(t ?? "");
      if (!m) throw new Error(`unexpected transform: ${t}`);
      return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
    },
    ready: async () => {
      await expect(svg).toBeVisible();
      await expect.poll(attr, { message: "bracket hydrated" }).not.toBe("translate(0 0) scale(1)");
    },
  };
}

test.describe("draw panel", () => {
  test("commit writes exactly the previewed draw, and any edit or late preview response withdraws the commit button", async ({ page, request }) => {
    test.setTimeout(90_000);
    const isMobile = test.info().project.name === "mobile";
    const event = await ownEvent(request, { teams: 4, firstPlayer: isMobile ? 8 : 24 });
    await devLogin(page.request, ORGANIZER_PHONE);
    await page.goto(`/organizer/events/${event.id}`);
    await expect(page.getByText("4 teams entered")).toBeVisible();
    const courts = page.getByLabel("Courts", { exact: true });
    // The label reads "Drawing…" while a preview is in flight.
    const previewButton = page.getByRole("button", { name: /^(Preview draw|Drawing…)$/ });
    const commitButton = page.getByRole("button", { name: "Commit this draw" });
    const previewNotice = page.getByRole("status").filter({ hasText: "Preview only" });

    // 1. Preview, then edit a draw input: the stale preview and its commit button go away.
    await courts.fill("2");
    await previewButton.click();
    await expect(previewNotice).toBeVisible();
    await expect(commitButton).toBeVisible();
    await courts.fill("3");
    await expect(commitButton).toBeHidden();
    await expect(previewNotice).toBeHidden();

    // 2. Edit while a preview is in flight: the answer to the older inputs is dropped when it lands.
    let release: (() => void) | null = null;
    const previewRequest = (url: URL) => url.pathname.endsWith("/draw") && url.searchParams.get("preview") === "1";
    await page.route(previewRequest, async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.continue();
    });
    const held = previewButton.click();
    await expect(previewButton).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => release !== null, { message: "the preview request is held" }).toBe(true);
    await courts.fill("2");
    release!();
    await held;
    await page.unroute(previewRequest);
    await expect(previewButton).toHaveAttribute("aria-busy", "false");
    await expect(commitButton).toBeHidden();
    await expect(previewNotice).toBeHidden();

    // 3. Preview and commit: the written draw is the previewed one (seed, courts and pool membership).
    const previewResponse = page.waitForResponse((r) => r.url().includes("/draw?preview=1") && r.request().method() === "POST");
    await previewButton.click();
    const previewed = ((await (await previewResponse).json()) as Envelope<{ preview: { rngSeed: number; plan: { pools: Array<{ label: string; teamIds: string[] }> } } }>).data.preview;
    await expect(previewNotice).toContainText(`seed ${previewed.rngSeed}`);
    await expect(commitButton).toBeVisible();
    await expect(page.getByRole("region", { name: "Pool A" })).toBeVisible();
    const previewedPoolA = await page.getByRole("region", { name: "Pool A" }).locator("tbody tr[data-team-id]").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.teamId));
    expect(previewedPoolA.sort()).toEqual([...(previewed.plan.pools[0]?.teamIds ?? [])].sort());

    const commitResponse = page.waitForResponse((r) => r.url().endsWith("/draw") && r.request().method() === "POST");
    await commitButton.click();
    const dialog = page.getByRole("dialog", { name: "Commit this draw?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Commit draw" }).click();
    const commitBody = (await commitResponse).request().postDataJSON() as { rngSeed?: number; courts?: number };
    expect(commitBody.rngSeed).toBe(previewed.rngSeed);
    expect(commitBody.courts).toBe(2);
    await expect(page.getByRole("status").filter({ hasText: "Draw generated" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Re-draw" })).toBeVisible();

    const standings = await json<Envelope<{ pools: Array<{ label: string; rows: Array<{ teamId: string }> }> }>>(request, `/api/tournaments/${event.slug}/standings`);
    expect(standings.data.pools.map((p) => p.rows.map((r) => r.teamId).sort())).toEqual(previewed.plan.pools.map((p) => [...p.teamIds].sort()));
    expect(standings.data.pools.map((p) => p.label)).toEqual(previewed.plan.pools.map((p) => p.label));
  });
});

test.describe("bracket canvas", () => {
  test("a mouse drag pans without opening a match, a click opens one, and Enter still works after a drag", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "mouse gestures");
    await page.goto(`/t/${LIVE}/bracket`);
    const { svg, transform, ready } = canvasOf(page);
    await ready();
    // Two zoom steps: the content now exceeds the view on both axes, so a pan can move it.
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const node = svg.locator("a[data-node-id][data-status='in_progress']").first();
    const box = (await node.boundingBox())!;
    const nodeId = await node.getAttribute("data-node-id");
    const before = await transform();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) await page.mouse.move(box.x + box.width / 2 - i * 10, box.y + box.height / 2, { steps: 2 });
    await page.mouse.up();
    await expect(page).toHaveURL(/\/bracket$/);
    const after = await transform();
    expect(after.x, "the canvas panned left").toBeLessThan(before.x);
    expect(after.k).toBe(before.k);

    // The drag's swallowed click must not linger: keyboard Enter on the focused match opens it.
    await node.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/m/${nodeId}$`));

    // A plain click (no movement) follows the link.
    await page.goto(`/t/${LIVE}/bracket`);
    const again = svg.locator("a[data-node-id][data-status='in_progress']").first();
    const againId = await again.getAttribute("data-node-id");
    await again.click({ position: { x: 20, y: 20 } });
    await expect(page).toHaveURL(new RegExp(`/m/${againId}$`));
  });

  test("a plain wheel pans the bracket while it can move, then the page scrolls", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "wheel input");
    await page.goto(`/t/${LIVE}/bracket`);
    const { svg, transform, ready } = canvasOf(page);
    await ready();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const scrollY = () => page.evaluate(() => window.scrollY);
    const startScroll = await scrollY();
    const before = await transform();

    await page.mouse.wheel(0, 60);
    await expect.poll(async () => (await transform()).y).toBeLessThan(before.y);
    expect(await scrollY(), "the page held still while the bracket panned").toBe(startScroll);

    // Keep going: once the bracket is against its edge the wheel reaches the page.
    for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, 200);
    await expect.poll(scrollY).toBeGreaterThan(startScroll);
  });

  test("on a phone the canvas is capped so the pool sheets stay reachable and a vertical swipe scrolls the page", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "touch input");
    await page.goto(`/t/${LIVE}/bracket`);
    const { svg, ready } = canvasOf(page);
    await ready();
    const container = svg.locator("xpath=..");
    const style = await container.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { touchAction: cs.touchAction, height: el.getBoundingClientRect().height };
    });
    expect(style.touchAction).toBe("pan-y");
    expect(style.height).toBeLessThanOrEqual(360);
    await expect(page.getByRole("region", { name: "Pool A" })).toBeAttached();

    await svg.scrollIntoViewIfNeeded();
    const box = (await svg.boundingBox())!;
    const x = box.x + box.width / 2;
    const cdp = await page.context().newCDPSession(page);
    const startScroll = await page.evaluate(() => window.scrollY);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: box.y + box.height * 0.75 }] });
    for (let i = 1; i <= 10; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: box.y + box.height * 0.75 - i * 20 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: "a vertical swipe on the canvas scrolls the page" }).toBeGreaterThan(startScroll);
    await expect(page).toHaveURL(/\/bracket$/);

    // The swipe flings: let the inertial scroll settle before the tap, or the match node moves under it.
    const scrollY = () => page.evaluate(() => window.scrollY);
    await expect
      .poll(
        async () => {
          const a = await scrollY();
          await page.waitForTimeout(100);
          return (await scrollY()) - a;
        },
        { message: "the fling has settled" },
      )
      .toBe(0);
    // The cancelled swipe must not swallow the next tap: tapping a match opens it.
    const node = svg.locator("a[data-node-id][data-status='in_progress']").first();
    const nodeId = await node.getAttribute("data-node-id");
    await node.tap();
    await expect(page).toHaveURL(new RegExp(`/m/${nodeId}$`));
  });

  test("nothing in the bracket renders below the 13px label step and team names sit at body size", async ({ page }) => {
    await page.goto(`/t/${LIVE}/bracket`);
    const { svg, ready } = canvasOf(page);
    await ready();
    const sizes = await svg.locator("text, tspan").evaluateAll((els) =>
      els.map((el) => ({ px: parseFloat(getComputedStyle(el).fontSize), name: el.classList.contains("text-body"), text: el.textContent ?? "" })),
    );
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.min(...sizes.map((s) => s.px))).toBeGreaterThanOrEqual(LABEL_PX);
    const names = sizes.filter((s) => s.name);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.px, `team name "${n.text}"`).toBe(BODY_PX);
  });
});

test.describe("console", () => {
  test("every court on the live board is a named region and the dispute badge sits on the type scale", async ({ page, request }) => {
    const liveId = await tournamentId(request, LIVE);
    await devLogin(page.request, ORGANIZER_PHONE);
    await page.goto(`/organizer/events/${liveId}/board`);
    await expect(page.getByRole("heading", { level: 1, name: "Live board" })).toBeVisible();
    const courts = page.getByRole("region", { name: /^Court \d+$/ });
    await expect(courts.first()).toBeVisible();
    const names = await courts.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const name of names) expect(page.getByRole("region", { name: name! }).getByRole("heading", { level: 2, name: name! })).toBeAttached();

    const disputes = page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: /^Disputes/ });
    await expectTarget(disputes, "Disputes nav link");
    const badge = disputes.locator("span").last();
    await expect(badge).toHaveText(/^\d+$/);
    expect(await badge.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(LABEL_PX);
  });

  test("freestanding console links are 44px targets and a whole events row opens the builder on a phone", async ({ page, request }) => {
    const isMobile = test.info().project.name === "mobile";
    const liveId = await tournamentId(request, LIVE);
    await devLogin(page.request, ORGANIZER_PHONE);

    const backToEvents = page.locator("a[href='/organizer/events']:not(nav a)");
    await page.goto(`/organizer/events/${liveId}`);
    await expectTarget(backToEvents, "builder back link");
    await expectTarget(page.getByRole("link", { name: "Live board" }), "builder → board link");
    await page.goto(`/organizer/events/${liveId}/board`);
    await expectTarget(page.locator("main").getByRole("link", { name: /^Sandbar Classic$/ }), "board back link");
    await page.goto("/organizer/events/new");
    await expectTarget(backToEvents, "new-event back link");

    await page.goto("/organizer/events");
    if (isMobile) {
      // Below md each event is a card: the name link is the 44px target and the card itself, a
      // positioned article with a stretched link, is the tap area, so a tap on the card's figures,
      // well outside the link's own box, opens the builder. The table is not rendered at all.
      const viewportWidth = page.viewportSize()!.width;
      await expect(page.getByRole("table", { name: /^Every event/ })).toBeHidden();
      const card = page.getByRole("article").filter({ has: page.getByRole("heading", { level: 2, name: "Sandbar Classic" }) });
      const link = card.getByRole("link", { name: "Sandbar Classic" });
      await expectTarget(link, "events card link");
      await expect(card.getByText("Live", { exact: true }), "status pill on the card").toBeVisible();
      // Centre the card: with more events in the list it can settle under the fixed tab bar, where a tap lands on the Console tab instead.
      await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const cardBox = (await card.boundingBox())!;
      const linkBox = (await link.boundingBox())!;
      expect(cardBox.x + cardBox.width, "card in view").toBeLessThanOrEqual(viewportWidth);
      expect(cardBox.y + cardBox.height, "figures below the link").toBeGreaterThan(linkBox.y + linkBox.height + MIN_TARGET / 2);
      await page.touchscreen.tap(cardBox.x + cardBox.width - 24, cardBox.y + cardBox.height - 16);
    } else {
      const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: /^Sandbar Classic/ }) });
      await expectTarget(row.getByRole("link", { name: /^Sandbar Classic/ }), "events row link");
      await row.getByRole("link", { name: "Open Sandbar Classic" }).click();
    }
    await expect(page).toHaveURL(new RegExp(`/organizer/events/${liveId}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Sandbar Classic" })).toBeVisible();
  });

  test("saving an event without touching sponsors writes no sponsors audit row, and a new sponsor is audited once", async ({ page, request }) => {
    test.setTimeout(60_000);
    const isMobile = test.info().project.name === "mobile";
    const event = await ownEvent(request, { teams: 0, firstPlayer: isMobile ? 16 : 32 });
    // Creating the draft with no sponsor rows audits the creation only.
    expect(auditActions(event.id)).toEqual(["tournament.created"]);
    await devLogin(page.request, ORGANIZER_PHONE);
    const sponsorAudits = () => auditActions(event.id).filter((a) => a === "tournament.sponsors_updated");
    await page.goto(`/organizer/events/${event.id}`);
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeVisible();
    await expect(page.getByText("No sponsors yet.")).toBeVisible();

    const saved = page.getByRole("status").filter({ hasText: "is up to date." });
    await save.click();
    await expect(saved).toBeVisible();
    expect(sponsorAudits(), "no sponsor row for an untouched sponsor list").toHaveLength(0);
    await saved.getByRole("button", { name: "Dismiss" }).click();
    await expect(saved).toBeHidden();

    await page.getByRole("button", { name: "Add sponsor" }).click();
    await page.getByLabel("Sponsor", { exact: true }).fill("Boardwalk Boards");
    await page.getByLabel("Prize contribution").fill("250");
    await save.click();
    await expect(saved).toBeVisible();
    expect(sponsorAudits()).toHaveLength(1);
    await saved.getByRole("button", { name: "Dismiss" }).click();
    await expect(saved).toBeHidden();

    // A second save with the same rows: the draft now carries the stored id, so nothing is resent.
    await save.click();
    await expect(saved).toBeVisible();
    expect(sponsorAudits()).toHaveLength(1);
  });
});

test.describe("profile and registration targets", () => {
  test("freestanding links on the profile are 44px targets", async ({ page, request }) => {
    // A player with rewards, a live team and a pending invite covers every card the profile renders.
    let rewarded: string | null = null;
    let invited: string | null = null;
    let registeredOpen: string | null = null;
    for (let i = 0; i < 48 && !(rewarded && invited && registeredOpen); i += 1) {
      const phone = playerPhone(i);
      await devLogin(request, phone);
      const me = (await json<Envelope<MeData>>(request, "/api/me")).data;
      if (!rewarded && me.rewards.length > 0) rewarded = phone;
      if (!invited && me.invites.some((inv) => inv.tournament.slug === OPEN)) invited = phone;
      if (!registeredOpen && me.teams.some((t) => t.tournament.slug === OPEN && t.team.status === "registered" && t.donation)) registeredOpen = phone;
    }
    expect(rewarded, "a seeded player with rewards").not.toBeNull();
    expect(invited, "a seeded player with a pending invite").not.toBeNull();
    expect(registeredOpen, "a seeded player registered in the open event").not.toBeNull();

    await devLogin(page.request, rewarded!);
    await page.goto("/me");
    await expectTarget(page.getByRole("table", { name: /rewards/i }).getByRole("link").first(), "rewards event link");
    await expectTarget(page.getByRole("article").first().getByRole("link").first(), "team card tournament link");

    await devLogin(page.request, invited!);
    await page.goto("/me");
    await expectTarget(page.getByRole("region", { name: "Invites waiting on you" }).getByRole("link", { name: "Pier 9 Open" }), "invite card tournament link");

    await devLogin(page.request, registeredOpen!);
    await page.goto("/me");
    await expectTarget(page.getByRole("link", { name: "Details" }).first(), "donation Details link");
  });
});
