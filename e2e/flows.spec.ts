import { expect, test, type Page } from "@playwright/test";
import { agreeOn, detail, devLogin, getJson, goLive, ORGANIZER_PHONE, ownEvent, playerPhone, submitAs, type MatchRef } from "./helpers";

/**
 * The two end-to-end flows the build is judged on (spec §15, acceptance
 * #25 and #26), against the production build in mock mode with the dev
 * login. Each runs on an event of its own so the seeded events other specs
 * read stay untouched, and the two Playwright projects use disjoint players.
 *
 *  Player:    register team → view pool → submit score → opponent agrees →
 *             match final → standings update.
 *  Organizer: open dispute → resolve → close the tournament through the
 *             frozen preview → Lucra submission row recorded as accepted.
 */

/** Type a scoreline into a `ScorelineEditor` (own points first); `own` is the label of the left column. */
async function typeScoreline(scope: Page | ReturnType<Page["getByTestId"]>, own: string, them: string, sets: Array<[number, number]>): Promise<void> {
  for (const [i, [us, theirs]] of sets.entries()) {
    await scope.getByRole("textbox", { name: `${own}, set ${i + 1} points` }).fill(String(us));
    await scope.getByRole("textbox", { name: `${them}, set ${i + 1} points` }).fill(String(theirs));
  }
}

test.describe("player flow", () => {
  test("register team → view pool → submit score → opponent agrees → match final → standings update", async ({ browser, request }) => {
    test.setTimeout(180_000);
    const isMobile = test.info().project.name === "mobile";
    // Three pairs register through the API; the fourth is the player under test, registering in the browser.
    const base = isMobile ? 0 : 20;
    const event = await ownEvent(request, { format: "pool_to_bracket", teams: 3, firstPlayer: base, entryDonationCents: 2500, leaveOpen: true, namePrefix: "Pool" });
    const captainPhone = playerPhone(base + 6);
    const partnerPhone = playerPhone(base + 7);
    const teamName = `Dune Riders ${test.info().project.name}`;

    // --- Register team: the captain creates it, the partner accepts, the captain donates and registers. ---
    const captainContext = await browser.newContext();
    const captain = await captainContext.newPage();
    await devLogin(captain.request, { phone: captainPhone });
    await captain.goto(`/teams/new?t=${event.slug}`);
    await captain.getByLabel("Team name").fill(teamName);
    await captain.getByLabel("Partner's phone").fill(partnerPhone);
    await captain.getByRole("button", { name: /Create team for/ }).click();
    await expect(captain).toHaveURL(new RegExp(`/t/${event.slug}/register$`));
    await expect(captain.getByText("Waiting for your partner")).toBeVisible();

    const partnerContext = await browser.newContext();
    const partner = await partnerContext.newPage();
    await devLogin(partner.request, { phone: partnerPhone });
    await partner.goto("/me");
    await partner.getByRole("button", { name: "Accept invite" }).click();
    await expect(partner.getByRole("status").filter({ hasText: `You are on ${teamName}` })).toBeVisible();
    await partnerContext.close();

    await captain.goto(`/t/${event.slug}/register`);
    await captain.getByRole("button", { name: /Donate \$25 and register/ }).click();
    await expect(captain.getByText("Your donation is being processed", { exact: true })).toBeVisible();
    const registered = await detail(request, event.slug);
    const ourTeam = registered.teams.find((t) => t.name === teamName);
    expect(ourTeam?.status).toBe("registered");
    expect(registered.teams.filter((t) => t.status === "registered")).toHaveLength(4);

    // --- The organizer closes registration, the Lucra mock gets its tournament, the draw is committed and play starts. ---
    await goLive(request, event, { poolSize: 4, poolBestOf: "3", advance: { perPool: 2, bestRemaining: 0 } });
    const live = await detail(request, event.slug);
    expect(live.tournament.status).toBe("live");
    expect(live.pools).toHaveLength(1);
    const ours = live.pools[0]?.matches.find((m) => m.teamA?.id === ourTeam?.id || m.teamB?.id === ourTeam?.id);
    if (!ours || !ours.teamA || !ours.teamB) throw new Error("our team has no pool match");
    const weAreA = ours.teamA.id === ourTeam?.id;
    const opponent = weAreA ? ours.teamB : ours.teamA;

    // --- View pool: the standings tab lists the pool with our row highlighted, and the bracket tab shows the pool sheet. ---
    await captain.goto(`/t/${event.slug}/standings`);
    const pool = captain.getByRole("table", { name: /Pool A standings/ });
    await expect(pool).toBeVisible();
    await expect(pool.locator("tbody tr")).toHaveCount(4);
    const ourRow = pool.locator(`tbody tr[data-team-id="${ourTeam?.id}"]`);
    await expect(ourRow).toContainText("0–0");
    await expect(ourRow).toHaveClass(/bg-bg-overlay/);
    await captain.goto(`/t/${event.slug}/bracket`);
    await expect(captain.getByRole("region", { name: "Pool A" })).toBeVisible();
    await captain.getByRole("region", { name: "Pool A" }).getByRole("link", { name: new RegExp(`${teamName}.*${opponent.name}|${opponent.name}.*${teamName}`) }).first().click();
    await expect(captain).toHaveURL(new RegExp(`/m/${ours.match.id}$`));

    // --- Submit score from the sand: the sheet, live legality, and "waiting on the opponent" after. ---
    await captain.getByRole("button", { name: "Submit score" }).click();
    const sheet = captain.getByTestId("score-sheet");
    await expect(sheet).toBeVisible();
    await typeScoreline(sheet, "Your team", opponent.name, [
      [21, 17],
      [21, 19],
    ]);
    await expect(captain.getByTestId("match-verdict")).toHaveText("Valid result: Your team win 2–0 in sets.");
    await sheet.getByRole("button", { name: "Submit scoreline" }).click();
    await expect(sheet.getByRole("heading", { name: `Waiting on ${opponent.name}` })).toBeVisible();
    await expect(sheet).toContainText("both teams have to agree before a result counts");
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(captain.getByTestId("submit-panel")).toContainText(`Waiting on ${opponent.name}`);

    // --- The opponent agrees from their own phone: one decisive check, then Final. ---
    const opponentContext = await browser.newContext();
    const other = await opponentContext.newPage();
    const opponentMember = opponent.members[0];
    if (!opponentMember) throw new Error("opponent has no member");
    await devLogin(other.request, { userId: opponentMember.userId });
    await other.goto(`/m/${ours.match.id}`);
    await expect(other.getByTestId("submit-panel")).toContainText(`${teamName} has submitted`);
    await other.getByRole("button", { name: "Confirm the result" }).click();
    const theirSheet = other.getByTestId("score-sheet");
    await typeScoreline(theirSheet, "Your team", teamName, [
      [17, 21],
      [19, 21],
    ]);
    await theirSheet.getByRole("button", { name: "Submit scoreline" }).click();
    await expect(theirSheet.getByRole("heading", { name: "Final" })).toBeVisible();
    await expect(other.getByTestId("confirm-check")).toBeVisible();
    await expect(theirSheet).toContainText("Both teams agree. The match is final.");
    await opponentContext.close();

    // --- Match final, on the captain's phone too (the page refreshes itself while the match is open). ---
    await expect(captain.getByText("Final", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(captain.getByRole("heading", { name: "Agreed result" })).toBeVisible();
    const after = await getJson<{ match: { status: string; winnerTeamId: string | null }; consensusState: string }>(request, `/api/matches/${ours.match.id}`);
    expect(after.match.status).toBe("final");
    expect(after.match.winnerTeamId).toBe(ourTeam?.id);
    // The agreed result went to Lucra through the consensus write and was accepted (every player entered the mock's tournament).
    expect(after.consensusState).toBe("accepted");

    // --- Standings update: our row is now 1–0 at the top of the pool, moved by the FLIP rather than a jump. ---
    await captain.goto(`/t/${event.slug}/standings`);
    const updated = captain.getByRole("table", { name: /Pool A standings/ }).locator(`tbody tr[data-team-id="${ourTeam?.id}"]`);
    await expect(updated).toContainText("1–0");
    await expect(updated).toHaveAttribute("data-rank", "1");
    await expect(captain.locator("[data-flip-rows][aria-live='polite']")).toBeAttached();
    await captainContext.close();
  });
});

test.describe("organizer flow", () => {
  test("open dispute → resolve → close through the frozen preview → Lucra submission row recorded as accepted", async ({ page, request }) => {
    test.setTimeout(180_000);
    const isMobile = test.info().project.name === "mobile";
    const event = await ownEvent(request, { format: "single_elim", teams: 4, firstPlayer: isMobile ? 8 : 28, namePrefix: "Bracket" });
    await goLive(request, event, { bracketBestOf: "3" });
    const live = await detail(request, event.slug);
    const round1 = live.bracket.matches.filter((m) => m.match.round === 1);
    expect(round1).toHaveLength(2);
    const [semiOne, semiTwo] = round1 as [MatchRef, MatchRef];

    // --- Open dispute: the two teams of the first semifinal send readings that differ in set 2. ---
    const a = semiOne.teamA?.members[0];
    const b = semiOne.teamB?.members[0];
    if (!a || !b || !semiOne.teamA || !semiOne.teamB) throw new Error("semifinal missing a team");
    await submitAs(request, a, semiOne.match.id, [
      [21, 18],
      [21, 16],
    ]);
    const second = await submitAs(request, b, semiOne.match.id, [
      [18, 21],
      [19, 21],
    ]);
    expect(second.outcome).toBe("disputed");

    // --- Resolve: the queue shows the dispute, both readings side by side with the differing set marked; the organizer settles it. ---
    await devLogin(page.request, { phone: ORGANIZER_PHONE });
    await page.goto("/organizer/disputes");
    await expect(page.getByRole("heading", { level: 1, name: "Disputes" })).toBeVisible();
    const card = page.getByTestId("dispute-card").filter({ hasText: semiOne.teamA.name }).filter({ hasText: semiOne.teamB.name });
    await expect(card).toBeVisible();
    await expect(card.locator("[data-differs]")).toHaveCount(1);
    await expect(card).not.toContainText(/blame|cheat|lied|wrong team/i);
    await card.getByRole("button", { name: `Start from ${semiOne.teamA.name}` }).click();
    await typeScoreline(card, semiOne.teamA.name, semiOne.teamB.name, [
      [21, 18],
      [21, 16],
    ]);
    await card.getByRole("button", { name: "Resolve as organizer" }).click();
    await expect(card).toContainText("Settled by");
    await expect(card).toContainText("The match is final");
    const resolved = await getJson<{ match: { status: string; winnerTeamId: string | null }; consensusState: string }>(request, `/api/matches/${semiOne.match.id}`);
    expect(resolved.match.status).toBe("final");
    expect(resolved.match.winnerTeamId).toBe(semiOne.teamA.id);
    expect(resolved.consensusState).toBe("accepted");

    // --- The rest of the bracket is played out by the teams themselves. ---
    expect(
      await agreeOn(request, semiTwo, [
        [21, 15],
        [21, 12],
      ]),
    ).toBe("agreed");
    const withFinal = await detail(request, event.slug);
    const final = withFinal.bracket.matches.find((m) => m.match.round === 2);
    if (!final?.teamA || !final.teamB) throw new Error("final not seeded from the semifinals");
    expect(
      await agreeOn(request, final, [
        [21, 19],
        [18, 21],
        [15, 11],
      ]),
    ).toBe("agreed");

    // --- Close through the frozen preview: review, then an explicit second step, then settlement through Lucra. ---
    await devLogin(page.request, { phone: ORGANIZER_PHONE });
    await page.goto(`/organizer/events/${event.id}/close`);
    await expect(page.getByRole("heading", { level: 1, name: `Close ${event.name}` })).toBeVisible();
    await expect(page.getByTestId("blocking-list")).toHaveCount(0);
    // Step 1: the frozen preview — final standings with the champion first, the projected rewards, and the hash the confirm must echo.
    const standings = page.getByRole("region", { name: "Final standings" });
    await expect(standings).toBeVisible();
    const finalResult = await getJson<{ match: { winnerTeamId: string | null } }>(request, `/api/matches/${final.match.id}`);
    const champion = [final.teamA, final.teamB].find((t) => t.id === finalResult.match.winnerTeamId);
    await expect(standings.locator("tbody tr").first()).toContainText(champion?.name ?? "champion");
    await expect(page.getByTestId("preview-hash")).toHaveText(/^[0-9a-f]{64}$/);
    await page.getByRole("button", { name: "Continue to confirm" }).click();
    const confirm = page.getByTestId("close-confirm");
    await expect(confirm.getByRole("heading", { name: `Close ${event.name}?` })).toBeVisible();
    await expect(confirm).toContainText("Freezes the standings for 4 teams");
    await expect(confirm).toContainText("Tournaments never settle on their own");
    await confirm.getByRole("button", { name: "Close tournament" }).click();
    await expect(page.getByText(/is closed and settled through Lucra/)).toBeVisible({ timeout: 20_000 });
    const closed = await detail(request, event.slug);
    expect(closed.tournament.status).toBe("settled");

    // --- Lucra: the resolved match's write is a recorded, accepted row, visible on /admin/lucra with its request and response. ---
    await devLogin(request, { phone: ORGANIZER_PHONE });
    const audit = await getJson<{ submissions: Array<{ row: { matchId: string; outcome: string; attempt: number }; consensusState: string | null }> }>(request, `/api/admin/lucra/submissions?tournamentId=${event.id}`);
    const forResolved = audit.submissions.filter((s) => s.row.matchId === semiOne.match.id);
    expect(forResolved).toHaveLength(1);
    expect(forResolved[0]?.row.outcome).toBe("accepted");
    expect(forResolved[0]?.consensusState).toBe("accepted");
    expect(audit.submissions.map((s) => s.row.outcome)).toEqual(["accepted", "accepted", "accepted"]);
    await page.goto(`/admin/lucra?tournament=${event.id}`);
    const rows = page.getByTestId("lucra-submission");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "Accepted" })).toHaveCount(3);
  });
});
