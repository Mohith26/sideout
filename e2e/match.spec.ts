import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Smoke over the consensus surfaces against the production build: the match
 * page for the seeded states, the score sheet for a signed-in team member,
 * the organizer's dispute queue and the close flow's blocking list. Read-only:
 * the mobile and desktop projects share one database, so nothing here
 * submits a score. The full player and organizer flows are phase 5.
 */
const ORGANIZER_PHONE = "+15550109000";

type MatchView = { match: { id: string; status: string; teamAId: string | null; teamBId: string | null }; teamA: { name: string; members: Array<{ userId: string }> } | null; teamB: { name: string; members: Array<{ userId: string }> } | null };
type Detail = { tournament: { id: string; name: string }; bracket: { matches: MatchView[] } };

async function liveDetail(request: APIRequestContext): Promise<Detail> {
  const res = await request.get("/api/tournaments/sandbar-classic-2026");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { data: Detail }).data;
}

function matchWithStatus(detail: Detail, status: string): MatchView {
  const m = detail.bracket.matches.find((x) => x.match.status === status);
  if (!m) throw new Error(`seed has no ${status} bracket match`);
  return m;
}

/**
 * Both teams' set-1 steppers lie inside the viewport and no scroll container
 * under `scope` can be scrolled sideways: the score sheet has to be usable by
 * thumb at 390px without a horizontal swipe (spec §11.3, acceptance #18).
 */
async function expectSteppersFit(page: Page, scope: Locator): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport size unknown");
  const increase = scope.getByRole("button", { name: /^Increase .*, set 1$/ });
  await expect(increase).toHaveCount(2);
  for (const button of await increase.all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  }
  const sideways = await scope.evaluate((root) =>
    [root, ...root.querySelectorAll<HTMLElement>("*")]
      .filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth)
      .map((el) => `${el.tagName.toLowerCase()} ${el.scrollWidth}>${el.clientWidth}`),
  );
  expect(sideways).toEqual([]);
}

test.describe("Match page", () => {
  test("shows a final match with its agreed sets and the score history", async ({ page, request }) => {
    const detail = await liveDetail(request);
    const m = matchWithStatus(detail, "final");
    await page.goto(`/m/${m.match.id}`);
    await expect(page.getByText("Final", { exact: true }).first()).toBeVisible();
    // Seeded finals were agreed and then written to Lucra (phase 4): the badge shows the accepted write.
    await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
    await expect(page.getByText("Lucra accepted the agreed result.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agreed result" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Score history" })).toBeVisible();
    await expect(page.getByRole("link", { name: detail.tournament.name })).toBeVisible();
  });

  test("shows a disputed match neutrally to the public, without either scoreline", async ({ page, request }) => {
    const detail = await liveDetail(request);
    const m = matchWithStatus(detail, "disputed");
    await page.goto(`/m/${m.match.id}`);
    await expect(page.getByText("The two scorelines differ. The organizer will settle it with both teams.")).toBeVisible();
    await expect(page.getByTestId("dispute-compare")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Submit score|Confirm the result/ })).toHaveCount(0);
  });

  test("a signed-in member of the waiting team gets the score sheet with large steppers and live legality", async ({ page, request }) => {
    const detail = await liveDetail(request);
    const m = matchWithStatus(detail, "awaiting_scores");
    // Team A submitted in the seed; a member of team B is the second submitter.
    const member = m.teamB?.members[0];
    if (!member) throw new Error("awaiting match has no team B member");
    expect((await page.request.post("/api/dev/login", { data: { userId: member.userId } })).ok()).toBe(true);

    await page.goto(`/m/${m.match.id}`);
    await expect(page.getByTestId("submit-panel")).toContainText(`${m.teamA?.name} has submitted`);
    await page.getByRole("button", { name: "Confirm the result" }).click();
    const sheet = page.getByTestId("score-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Your result" })).toBeVisible();

    // Best of 3: two rows to start, steppers at least 56px, submit disabled until legal.
    await expect(sheet.getByRole("listitem")).toHaveCount(2);
    const plus = sheet.getByRole("button", { name: "Increase Your team, set 1" });
    const box = await plus.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(56);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    // Both sides' steppers sit inside the viewport and nothing in the sheet scrolls
    // sideways (spec §11.3 "thumb-reachable", acceptance #18 "usable one-handed at 390px").
    await expectSteppersFit(page, sheet);
    const submit = sheet.getByRole("button", { name: "Submit scoreline" });
    await expect(submit).toBeDisabled();

    await sheet.getByRole("textbox", { name: "Your team, set 1 points" }).fill("21");
    await sheet.getByRole("textbox", { name: `${m.teamA?.name}, set 1 points` }).fill("20");
    await expect(sheet.getByText("Set 1: Sets are won by 2; 21–20 is not a finished set.")).toBeVisible();
    await expect(submit).toBeDisabled();
    await sheet.getByRole("textbox", { name: `${m.teamA?.name}, set 1 points` }).fill("18");
    await sheet.getByRole("textbox", { name: "Your team, set 2 points" }).fill("21");
    await sheet.getByRole("textbox", { name: `${m.teamA?.name}, set 2 points` }).fill("16");
    await expect(page.getByTestId("match-verdict")).toHaveText("Legal result: Your team win 2–0 in sets.");
    await expect(submit).toBeEnabled();
    // Read-only smoke: close without sending.
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
  });
});

test.describe("Organizer consensus screens", () => {
  test("the dispute queue and the close flow name exactly what is blocking", async ({ page, request }) => {
    const detail = await liveDetail(request);
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);

    await page.goto("/organizer/disputes");
    await expect(page.getByRole("heading", { level: 1, name: "Disputes" })).toBeVisible();
    const card = page.getByTestId("dispute-card").first();
    await expect(card).toContainText("Quarterfinals");
    await expect(card.locator("[data-differs]")).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Resolve as organizer" })).toBeDisabled();
    // The organizer's resolve editor is the same stepper layout and must fit a phone too.
    await expectSteppersFit(page, card);

    await page.goto(`/organizer/events/${detail.tournament.id}/close`);
    await expect(page.getByRole("heading", { level: 1, name: /Close Sandbar Classic/ })).toBeVisible();
    const blocking = page.getByTestId("blocking-list");
    await expect(blocking).toBeVisible();
    await expect(blocking.getByText("Resolve the dispute", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue to confirm/ })).toHaveCount(0);
  });

  test("a player is refused the organizer console", async ({ page, request }) => {
    const detail = await liveDetail(request);
    const anyMember = detail.bracket.matches.flatMap((m) => m.teamA?.members ?? [])[0];
    if (!anyMember) throw new Error("no member");
    expect((await page.request.post("/api/dev/login", { data: { userId: anyMember.userId } })).ok()).toBe(true);
    // The console layout 404s the whole of /organizer/** for anyone but an organizer (see `src/app/organizer/_lib.ts`).
    const asPlayer = await page.goto("/organizer/disputes");
    expect(asPlayer?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Organizer access required" })).toHaveCount(0);
    const api = await page.request.get("/api/admin/disputes");
    expect(api.status()).toBe(403);
  });
});
