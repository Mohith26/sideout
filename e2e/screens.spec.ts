import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Phase-2b screens against the production build: a screenshot pass of every
 * new screen at 390, 768 and 1280 (saved under test-results/screens for
 * review, with a no-horizontal-overflow assertion at 390), the bracket's
 * keyboard walkthrough, the team → invite → register flow, and the console's
 * role gate. Only the mobile project runs the viewport pass so each width is
 * captured once.
 */
const ORGANIZER_PHONE = "+15550109000";
const LIVE = "sandbar-classic-2026";
const OPEN = "pier-9-open-2026";
const WIDTHS = [390, 768, 1280] as const;

async function devLogin(request: APIRequestContext, phone: string): Promise<void> {
  const res = await request.post("/api/dev/login", { data: { phone } });
  expect(res.ok(), `dev login for ${phone}`).toBe(true);
}

/** Seeded player phones (`src/seed/build.ts`): +1555{100+i}{last four of 1000+7i}. */
function playerPhone(i: number): string {
  return `+1555${String(100 + i).padStart(3, "0")}${String(1000 + i * 7).slice(-4)}`;
}

type Me = { data: { teams: Array<{ tournament: { slug: string }; team: { status: string } }>; invites: Array<{ tournament: { slug: string } }> } };

/**
 * Two seeded players with no live team and no pending invite in the open event.
 * Both projects run the team flow in parallel against one database, so each
 * scans from its own end of the roster: picking the same captain twice would
 * make the second team supersede the first (`src/server/teams.ts`).
 */
async function freePlayers(request: APIRequestContext): Promise<[string, string]> {
  const free: string[] = [];
  const fromTheEnd = test.info().project.name === "desktop";
  for (let n = 0; n < 48 && free.length < 2; n += 1) {
    const phone = playerPhone(fromTheEnd ? 47 - n : n);
    await devLogin(request, phone);
    const me = (await (await request.get("/api/me")).json()) as Me;
    const busy = me.data.teams.some((t) => t.tournament.slug === OPEN && t.team.status !== "disbanded" && t.team.status !== "withdrawn");
    const invited = me.data.invites.some((inv) => inv.tournament.slug === OPEN);
    if (!busy && !invited) free.push(phone);
  }
  await request.post("/api/auth/logout");
  if (free.length < 2) throw new Error("seed has fewer than two free players");
  return [free[0] as string, free[1] as string];
}

/** The streamed screen has replaced the route's loading skeleton, so a capture shows the screen itself. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator("main .animate-pulse")).toHaveCount(0);
}

/**
 * The page itself never scrolls sideways at any of the three widths (spec §11): a
 * table may scroll inside its own box, but nothing may widen the document. Measured
 * against the layout viewport (`clientWidth`): under mobile emulation `innerWidth`
 * stretches to the overflowing content, so comparing against it never fails.
 */
async function noHorizontalOverflow(page: Page, what: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, `${what}: page must not scroll sideways`).toBeLessThanOrEqual(clientWidth);
}

test.describe("screens", () => {
  test("every new screen renders at 390, 768 and 1280 without sideways scroll", async ({ page, request }) => {
    test.skip(test.info().project.name !== "mobile", "one viewport pass is enough");
    test.setTimeout(120_000);
    const liveId = ((await (await request.get(`/api/tournaments/${LIVE}`)).json()) as { data: { tournament: { id: string } } }).data.tournament.id;
    const asPlayer = [
      { name: "bracket", path: `/t/${LIVE}/bracket` },
      { name: "standings", path: `/t/${LIVE}/standings` },
      { name: "bracket-pools-pending", path: `/t/${OPEN}/bracket` },
      { name: "sign-in", path: "/sign-in", anonymous: true },
      { name: "me", path: "/me" },
      { name: "teams-new", path: `/teams/new?t=${OPEN}` },
      { name: "register", path: `/t/${OPEN}/register` },
    ];
    const asOrganizer = [
      { name: "console-events", path: "/organizer/events" },
      { name: "console-builder", path: `/organizer/events/${liveId}` },
      { name: "console-board", path: `/organizer/events/${liveId}/board` },
      { name: "console-new-event", path: "/organizer/events/new" },
    ];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.request.post("/api/auth/logout");
      await page.request.post("/api/dev/login", { data: { phone: playerPhone(0) } });
      for (const screen of asPlayer) {
        if (screen.anonymous) await page.request.post("/api/auth/logout");
        await page.goto(screen.path);
        await expect(page.locator("main")).toBeVisible();
        await settled(page);
        await page.screenshot({ path: `test-results/screens/${screen.name}-${width}.png`, fullPage: true });
        await noHorizontalOverflow(page, `${screen.name} at ${width}`);
        if (screen.anonymous) await page.request.post("/api/dev/login", { data: { phone: playerPhone(0) } });
      }
      await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } });
      for (const screen of asOrganizer) {
        await page.goto(screen.path);
        await expect(page.getByRole("navigation", { name: "Console" })).toBeVisible();
        await settled(page);
        await page.screenshot({ path: `test-results/screens/${screen.name}-${width}.png`, fullPage: true });
        await noHorizontalOverflow(page, `${screen.name} at ${width}`);
      }
    }
  });

  test("the bracket is a keyboard-operable list of rounds with an honest bye and a pinned live match", async ({ page }) => {
    await page.goto(`/t/${LIVE}/bracket`);
    await expect(page.getByRole("list", { name: /rounds$/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Round of 16 matches" })).toBeAttached();
    await expect(page.getByRole("link", { name: /advances on a bye/ })).toBeAttached();
    await expect(page.getByText("On the sand")).toBeVisible();

    // One tab stop, then the arrow keys walk the bracket; Enter follows the match link.
    const start = page.locator("[data-node-id][tabindex='0']");
    await expect(start).toHaveCount(1);
    await expect(start).toHaveAttribute("data-status", "in_progress");
    await start.focus();
    const focusedId = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.nodeId ?? null);
    const startId = await focusedId();
    expect(startId).not.toBeNull();
    await page.keyboard.press("ArrowLeft");
    const left = await focusedId();
    expect(left).not.toBe(startId);
    expect(await page.locator(`[data-node-id="${left}"]`).getAttribute("data-round")).toBe("2");
    await page.keyboard.press("ArrowRight");
    expect(await focusedId()).toBe(startId);
    await page.keyboard.press("ArrowRight");
    const final = await focusedId();
    expect(await page.locator(`[data-node-id="${final}"]`).getAttribute("data-round")).toBe("4");
    await page.keyboard.press("ArrowRight");
    expect(await focusedId()).toBe(final);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    expect(await page.locator(`[data-node-id="${await focusedId()}"]`).getAttribute("data-round")).toBe("4");
    // Enter opens the focused match at /m/[id] (that page is the consensus task's).
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/m/${final}$`));
  });

  test("standings show each pool with tabular figures and the tiebreak footnote", async ({ page }) => {
    await page.goto(`/t/${LIVE}/standings`);
    await expect(page.getByRole("table", { name: /Pool A standings/ })).toBeVisible();
    const ranks = page.getByRole("table", { name: /Pool A standings/ }).locator("tbody tr");
    await expect(ranks).toHaveCount(4);
    await expect(ranks.first()).toHaveAttribute("data-rank", "1");
    await expect(page.getByText(/Ties break in order: 1\. match wins/)).toBeVisible();
    await expect(page.locator("[aria-live='polite']").first()).toBeAttached();
  });

  test("sign-in explains a deployment with no SMS provider and sends a signed-in visitor back", async ({ page }) => {
    await page.goto("/sign-in?next=%2Fme");
    await page.getByLabel("Phone number").fill("5550100100");
    await page.getByRole("button", { name: "Text me a code" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Text messages" })).toContainText("Text messages are not available here yet");
    await page.request.post("/api/dev/login", { data: { phone: playerPhone(1) } });
    await page.goto("/sign-in?next=%2Fme");
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("create a team, accept the invite, and register with the donation step distinct from Lucra entry", async ({ browser, request }) => {
    test.setTimeout(90_000);
    const [captainPhone, partnerPhone] = await freePlayers(request);
    const teamName = `E2E ${test.info().project.name} ${Date.now() % 100000}`;

    const captain = await browser.newContext();
    const captainPage = await captain.newPage();
    await devLogin(captainPage.request, captainPhone);
    await captainPage.goto(`/teams/new?t=${OPEN}`);
    await captainPage.getByLabel("Team name").fill(teamName);
    await captainPage.getByLabel("Partner's phone").fill(partnerPhone);
    await captainPage.getByRole("button", { name: /Create team for/ }).click();
    await expect(captainPage).toHaveURL(new RegExp(`/t/${OPEN}/register$`));
    await expect(captainPage.getByText("Waiting for your partner")).toBeVisible();
    await expect(captainPage.getByRole("heading", { name: /Charitable donation/ })).toBeVisible();
    await expect(captainPage.getByRole("heading", { name: /Enter the tournament with Lucra/ })).toBeVisible();
    await expect(captainPage.getByText("Opens after step 1")).toBeVisible();

    const partner = await browser.newContext();
    const partnerPage = await partner.newPage();
    await devLogin(partnerPage.request, partnerPhone);
    await partnerPage.goto("/me");
    await expect(partnerPage.getByText(`invited you to play as “${teamName}”`)).toBeVisible();
    await partnerPage.getByRole("button", { name: "Accept invite" }).click();
    await expect(partnerPage.getByRole("status").filter({ hasText: `You are on ${teamName}` })).toBeVisible();
    await expect(partnerPage.getByRole("article", { name: `${teamName} at Pier 9 Open` })).toContainText("Both players are in");

    await captainPage.goto(`/t/${OPEN}/register`);
    const donate = captainPage.getByRole("button", { name: /Donate \$75 and register/ });
    await expect(donate).toBeVisible();
    await donate.click();
    // Exact: the success toast's body carries the same sentence with a full stop.
    await expect(captainPage.getByText("Your donation is being processed", { exact: true })).toBeVisible();
    await expect(captainPage.getByText("Processing")).toBeVisible();
    // Step 2 unlocks as its own card, run by Lucra: the roster's entry state and one action, nothing assumed.
    const step2 = captainPage.getByRole("region", { name: /Step 2: Enter the tournament with Lucra/ });
    await expect(step2).toContainText("Run by Lucra");
    await expect(step2.getByTestId("entry-player")).toHaveCount(2);
    // The seed lists one player Lucra knows who is on no team (§7.5's "extra"); if the captain is that player the read-back already shows them entered.
    const mine = step2.getByTestId("entry-player").filter({ hasText: "you" });
    if (((await mine.getAttribute("data-entered")) ?? "") === "true") await expect(step2.getByTestId("lucra-enter")).toHaveCount(0);
    else await expect(step2.getByTestId("lucra-enter")).toHaveText("Sign in with Lucra and enter");
    // The registration is real: the team now counts on the public roster and the donation is a pending stub intent.
    const me = (await (await captainPage.request.get("/api/me")).json()) as { data: { teams: Array<{ team: { name: string; status: string }; donation: { status: string; amountCents: number } | null }> } };
    const entry = me.data.teams.find((t) => t.team.name === teamName);
    expect(entry?.team.status).toBe("registered");
    expect(entry?.donation).toMatchObject({ status: "pending", amountCents: 7500 });
    await captain.close();
    await partner.close();
  });

  test("the console is a 404 for players and anonymous visitors, and opens for organizers", async ({ page, request }) => {
    expect((await request.get("/organizer/events")).status()).toBe(404);
    await page.request.post("/api/dev/login", { data: { phone: playerPhone(2) } });
    const asPlayer = await page.goto("/organizer/events");
    expect(asPlayer?.status()).toBe(404);
    await expect(page.getByRole("link", { name: "Console" })).toHaveCount(0);

    await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } });
    const asOrganizer = await page.goto("/organizer");
    expect(asOrganizer?.status()).toBe(200);
    await expect(page).toHaveURL(/\/organizer\/events$/);
    await expect(page.getByRole("heading", { level: 1, name: "Events" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Console" }).first()).toBeVisible();
    // The event cell is one 44px link whose name also carries the division/format line (the status pill on a phone).
    await page.getByRole("link", { name: /^Sandbar Classic/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Sandbar Classic" })).toBeVisible();
    await expect(page.getByText("Close tournament")).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Sandbar Classic");
    await page.getByRole("link", { name: "Live board" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Live board" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Court 1" })).toBeVisible();
  });
});
