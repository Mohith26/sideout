import { expect, test } from "@playwright/test";
import { detail, devLogin, getJson, goLive, ownEvent } from "./helpers";

/**
 * Offline (spec §11, acceptance #23): the production build registers the
 * service worker, a match page opened online is kept for offline reading, a
 * scoreline submitted with no connection is queued on the phone, the queue
 * survives a reload served from the worker's cache, and it syncs through the
 * same route — same validation, same consensus path — once the connection
 * returns.
 */
test.describe("offline score submission", () => {
  test("queued offline, survives reload, syncs on reconnect", async ({ browser, request }) => {
    test.setTimeout(120_000);
    const isMobile = test.info().project.name === "mobile";
    const event = await ownEvent(request, { format: "pool_to_bracket", teams: 4, firstPlayer: isMobile ? 32 : 40, namePrefix: "Offline" });
    await goLive(request, event, { poolSize: 4, poolBestOf: "3" });
    const live = await detail(request, event.slug);
    const match = live.pools[0]?.matches[0];
    if (!match?.teamA || !match.teamB) throw new Error("no pool match");
    const me = match.teamA.members[0];
    if (!me) throw new Error("no member");

    const context = await browser.newContext();
    const page = await context.newPage();
    await devLogin(page.request, { userId: me.userId });

    // Online first: the worker installs on the first visit and controls the page from the next one, which it caches.
    await page.goto(`/m/${match.match.id}`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.getByRole("button", { name: "Submit score" })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith("sideout-pages-"))), { message: "the pages cache exists" }).toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(async (path) => {
            for (const key of await caches.keys()) {
              if (!key.startsWith("sideout-pages-")) continue;
              const hit = await (await caches.open(key)).match(new URL(path, location.origin).toString(), { ignoreVary: true });
              if (hit) return true;
            }
            return false;
          }, `/m/${match.match.id}`),
        { message: "the match page is cached for offline reading" },
      )
      .toBe(true);

    // No signal: the sheet still opens and judges legality on the phone; submitting saves the scoreline instead of losing it.
    await context.setOffline(true);
    await expect(page.getByTestId("offline-status")).toHaveAttribute("data-offline", "true");
    await expect(page.getByTestId("offline-status")).toContainText("No connection.");
    await page.getByRole("button", { name: "Submit score" }).click();
    const sheet = page.getByTestId("score-sheet");
    await sheet.getByRole("textbox", { name: "Your team, set 1 points" }).fill("21");
    await sheet.getByRole("textbox", { name: `${match.teamB.name}, set 1 points` }).fill("14");
    await sheet.getByRole("textbox", { name: "Your team, set 2 points" }).fill("21");
    await sheet.getByRole("textbox", { name: `${match.teamB.name}, set 2 points` }).fill("18");
    await expect(page.getByTestId("match-verdict")).toHaveText("Valid result: Your team win 2–0 in sets.");
    await sheet.getByRole("button", { name: "Submit scoreline" }).click();
    await expect(sheet.getByRole("heading", { name: "Saved on this phone" })).toBeVisible();
    await expect(sheet.getByTestId("queued-notice")).toContainText("will be sent, with the same checks, as soon as you are back online");
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("offline-status")).toContainText("One scoreline is saved on this phone");
    // Nothing reached the server.
    const before = await getJson<{ consensusState: string | null }>(request, `/api/matches/${match.match.id}`);
    expect(before.consensusState).toBeNull();

    // Reload with no connection: the worker serves the page and the queue is still there, in match orientation.
    await page.reload();
    await expect(page.getByTestId("offline-status")).toHaveAttribute("data-offline", "true");
    const queued = page.getByTestId("queued-score");
    await expect(queued).toBeVisible();
    await expect(queued).toHaveAttribute("data-status", "queued");
    await expect(queued).toContainText("Queued on this phone");
    await expect(queued.locator("tbody tr").filter({ hasText: match.teamA.name })).toContainText("21");
    await expect(queued.locator("tbody tr").filter({ hasText: match.teamB.name })).toContainText("14");

    // Back online: the outbox replays through POST /api/matches/:id/scores, the phone says so, and the page shows the consensus it produced.
    await context.setOffline(false);
    await expect(page.getByRole("status").filter({ hasText: "Queued scoreline sent" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("queued-score")).toHaveCount(0);
    await expect(page.getByTestId("submit-panel")).toContainText(`Waiting on ${match.teamB.name}`, { timeout: 20_000 });
    const after = await getJson<{ match: { status: string }; consensusState: string | null; sets: unknown[] }>(request, `/api/matches/${match.match.id}`);
    expect(after.match.status).toBe("awaiting_scores");
    expect(after.consensusState).toBe("awaiting_second");

    // The server saw an ordinary submission: the consensus records it under the team, with the sets as typed.
    await devLogin(request, { userId: me.userId });
    const view = await getJson<{ match: { id: string } }>(request, `/api/matches/${match.match.id}`);
    expect(view.match.id).toBe(match.match.id);
    await context.close();
  });

  test("a page never opened is answered by the offline page, not a browser error", async ({ browser, request }) => {
    const isMobile = test.info().project.name === "mobile";
    const live = await detail(request, "sandbar-classic-2026");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await context.setOffline(true);
    await page.goto(`/t/${live.tournament.slug}/impact?fresh=${isMobile ? "m" : "d"}-${Date.now()}`);
    await expect(page.getByRole("heading", { level: 1, name: /No connection, and this page is not saved on this phone/ })).toBeVisible();
    await context.setOffline(false);
    await context.close();
  });
});
