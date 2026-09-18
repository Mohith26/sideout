import { expect, test } from "@playwright/test";

/**
 * Smoke over the Lucra surfaces against the production build in mock mode:
 * `/admin/lucra` lists the seeded attempt rows with their exact JSON, the
 * audit route filters, the mock's state route exists in a mock build and is
 * organizer-gated, and `/health` reports the pin and the matcher reading.
 * Read-only: nothing here writes to Lucra.
 */
const ORGANIZER_PHONE = "+15550109000";

test.describe("Lucra audit surfaces", () => {
  test("/health reports the pinned SDK version and the matcher interpretation", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { data: { lucraMode: string; lucraSdkVersion: string; lucraSdk: { package: string; source: string }; lucraMatcherInterpretation: string } };
    expect(body.data.lucraMode).toBe("mock");
    expect(body.data.lucraSdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.data.lucraSdk).toMatchObject({ package: "lucra-web-sdk", source: expect.stringContaining("github:Lucra-Sports/lucra-web-sdk#v") });
    expect(body.data.lucraMatcherInterpretation).toBe("literal");
  });

  test("/admin/lucra shows every seeded attempt with the exact request and response, every outcome, and the targeting state", async ({ page }) => {
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    await page.goto("/admin/lucra");
    await expect(page.getByRole("heading", { level: 1, name: "Lucra writes" })).toBeVisible();
    await expect(page.getByTestId("lucra-health")).toContainText("mock");
    // Three seeded events (another spec may add a draft to the shared database).
    expect(await page.getByTestId("lucra-tournament").count()).toBeGreaterThanOrEqual(3);
    const rows = page.getByTestId("lucra-submission");
    expect(await rows.count()).toBeGreaterThan(50);
    for (const label of ["Accepted", "Partial", "Rejected", "Transport error"]) {
      await expect(rows.filter({ hasText: label }).first()).toBeVisible();
    }
    // Open a rejected attempt: the documented body is there verbatim, the key is not.
    const rejected = rows.filter({ hasText: "Rejected" }).first();
    await rejected.locator("summary").click();
    await expect(rejected).toContainText('"error": "Matchup not found"');
    await expect(rejected).toContainText('"X-Lucra-Api-Key": "[redacted]"');
    await expect(rejected).toContainText("/api/rest/pool-tournament/user-score");
    await expect(rejected).not.toContainText("sideout-mock-backend-key");

    // The outcome filter narrows the list.
    await page.goto("/admin/lucra?outcome=partial");
    await expect(page.getByTestId("lucra-submission")).toHaveCount(1);
    await expect(page.getByTestId("lucra-submission")).toContainText("Partial");
  });

  test("the audit route and the mock state route are organizer-gated; the mock holds the overlapping matchups", async ({ page, request }) => {
    expect((await request.get("/api/admin/lucra/submissions")).status()).toBe(401);
    expect((await request.get("/api/rest/_mock/state")).status()).toBe(401);
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    const audit = await page.request.get("/api/admin/lucra/submissions?outcome=rejected");
    expect(audit.ok()).toBe(true);
    const body = (await audit.json()) as { data: { submissions: Array<{ row: { outcome: string; httpStatus: number | null } }> } };
    expect(body.data.submissions).toHaveLength(1);
    expect(body.data.submissions[0]?.row).toMatchObject({ outcome: "rejected", httpStatus: 404 });

    const state = await page.request.get("/api/rest/_mock/state");
    expect(state.ok()).toBe(true);
    const mock = (await state.json()) as { data: { matchups: Array<{ kind: string; metadata: { season?: string; externalId?: string } }> } };
    expect(mock.data.matchups.filter((m) => m.metadata.season === "2026-spring")).toHaveLength(3);
    expect(mock.data.matchups.filter((m) => m.kind === "recreational")).toHaveLength(2);
    expect(JSON.stringify(mock)).not.toContain("LUCRA_BACKEND");
  });
});

/** Seeded player phones (`src/seed/build.ts`): +1555{100+i}{last four of 1000+7i}. */
function playerPhone(i: number): string {
  return `+1555${String(100 + i).padStart(3, "0")}${String(1000 + i * 7).slice(-4)}`;
}
/** Index 5 and 11 in the seed: the one `not_allowed` and the one `demographics_missing` player. */
const NOT_ALLOWED_PHONE = playerPhone(5);
const DEMOGRAPHICS_PHONE = playerPhone(11);
const OPEN = "pier-9-open-2026";

type Reconciliation = { data: { missing: Array<{ userId: string; displayName: string; teamId: string }>; matched: Array<{ userId: string; teamId: string }>; extra: unknown[]; unlinked: unknown[] } };
type Entry = { data: { players: Array<{ userId: string; you: boolean; entered: boolean | null }>; complete: boolean } };

/**
 * Phase 4b in the browser, against the mock stand-in for the Web SDK: the
 * registration step's entry through Lucra's sign-in, location grant and join,
 * proven by the server's read-back and the organizer's reconciliation; and
 * the profile's terminal `NotAllowed` row for the seeded blocked player.
 */
test.describe("Lucra in the browser (mock stand-in)", () => {
  test("registration step 2 enters the tournament through Lucra and the read-back confirms it", async ({ page }) => {
    // The seed skipped one registered player's auto-join (§7.5): the organizer's reconciliation names them.
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    const tournament = (await (await page.request.get(`/api/tournaments/${OPEN}`)).json()) as { data: { tournament: { id: string } } };
    const before = (await (await page.request.get(`/api/admin/tournaments/${tournament.data.tournament.id}/lucra/participants`)).json()) as Reconciliation;
    // Both projects run this against one server; whoever is second finds the join already done and asserts the finished state.
    // The seeded gap is one player whose partner Lucra already lists; a team another spec registered after boot is missing both.
    const missing = before.data.missing.find((m) => before.data.matched.some((x) => x.teamId === m.teamId));
    let phone: string | null = null;
    for (let i = 0; i < 48 && !phone; i += 1) {
      const candidate = playerPhone(i);
      const login = (await (await page.request.post("/api/dev/login", { data: { phone: candidate } })).json()) as { data: { user: { id: string } } };
      if (missing ? login.data.user.id === missing.userId : false) phone = candidate;
      if (!missing) {
        const entry = await page.request.get(`/api/tournaments/${OPEN}/lucra/entry`);
        if (entry.ok() && ((await entry.json()) as Entry).data.complete) phone = candidate;
      }
    }
    expect(phone, "a registered player of the open event").not.toBeNull();
    await page.addInitScript(() => localStorage.clear());
    await page.goto(`/t/${OPEN}/register`);
    const step2 = page.getByRole("region", { name: /Step 2: Enter the tournament with Lucra/ });
    await expect(step2).toContainText("Run by Lucra");
    await expect(step2.getByTestId("entry-player")).toHaveCount(2);

    if (missing) {
      const enter = step2.getByTestId("lucra-enter");
      await expect(enter).toHaveText("Sign in with Lucra and enter");
      await enter.click();
      // Lucra's own sign-in (the stand-in's sheet), then its location grant, then the join.
      const login = page.getByRole("dialog", { name: "Sign in to Lucra" });
      await expect(login).toBeVisible();
      await login.getByRole("button", { name: "Continue with this phone" }).click();
      const grant = page.getByRole("dialog", { name: "Allow location access" });
      await expect(grant).toBeVisible();
      await grant.getByRole("button", { name: "Allow location" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    // What the card shows is the server's read-back of Lucra's participant list, never the join's answer.
    await expect(step2.getByTestId("lucra-entry-step")).toHaveAttribute("data-complete", "true", { timeout: 15_000 });
    await expect(step2).toContainText("Both players are in");
    await expect(step2.getByTestId("lucra-enter")).toHaveCount(0);
    const entry = (await (await page.request.get(`/api/tournaments/${OPEN}/lucra/entry`)).json()) as Entry;
    expect(entry.data.players.every((p) => p.entered === true)).toBe(true);

    // The organizer's reconciliation is the proof: the player who just entered is matched and no longer missing
    // (a team another spec registers in this event meanwhile is missing until its players enter; that is not this player).
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    const after = (await (await page.request.get(`/api/admin/tournaments/${tournament.data.tournament.id}/lucra/participants`)).json()) as Reconciliation;
    const enteredIds = entry.data.players.map((p) => p.userId);
    expect(after.data.missing.filter((m) => enteredIds.includes(m.userId))).toHaveLength(0);
    for (const id of enteredIds) expect(after.data.matched.some((m) => m.userId === id), `${id} matched`).toBe(true);
    expect(after.data.matched.length).toBeGreaterThanOrEqual(before.data.matched.length);
    await page.goto(`/organizer/events/${tournament.data.tournament.id}/lucra`);
    await expect(page.getByRole("heading", { level: 1, name: "Lucra entry" })).toBeVisible();
    await expect(page.getByTestId("reconciliation-matched")).not.toHaveAttribute("data-count", "0");
  });

  test("the profile shows the seeded not_allowed player a terminal explanation with a support path and no retry", async ({ page }) => {
    expect((await page.request.post("/api/dev/login", { data: { phone: NOT_ALLOWED_PHONE } })).ok()).toBe(true);
    await page.addInitScript(() => localStorage.clear());
    await page.goto("/me");
    const row = page.getByTestId("verification-row");
    await expect(row).toHaveAttribute("data-state", "not_allowed");
    await expect(row).toContainText("Lucra can't offer play to this account");
    await expect(row).toContainText("nothing to retry");
    await expect(row.getByRole("link", { name: "Contact Lucra support" })).toHaveAttribute("href", /^mailto:/);
    await expect(row.getByRole("button")).toHaveCount(0);
    // The wallet chip stays a sign-in affordance until a Lucra session exists; signing in shows the balance with the responsible-play links beneath it.
    const chip = page.getByTestId("wallet-chip");
    await expect(chip).toHaveAttribute("data-state", "signed-out");
    await chip.getByRole("button", { name: "Sign in with Lucra" }).click();
    await page.getByRole("dialog", { name: "Sign in to Lucra" }).getByRole("button", { name: "Continue with this phone" }).click();
    await expect(chip).toHaveAttribute("data-state", "signed-in");
    await expect(chip.getByTestId("wallet-balance")).toHaveText("$0.00");
    await expect(chip.getByTestId("responsible-play")).toContainText("Responsible gaming policy");
    await expect(chip.getByTestId("responsible-play")).toContainText("Set limits in Lucra");
    // Still terminal after Lucra itself reports the account: no action appeared.
    await expect(row).toHaveAttribute("data-state", "not_allowed");
    await expect(row.getByRole("button")).toHaveCount(0);
    // Real money is off: Lucra's wallet screen only, never add funds or withdraw.
    await expect(chip.getByRole("button", { name: "Wallet" })).toBeVisible();
    await expect(chip.getByRole("button", { name: "Add funds" })).toHaveCount(0);
  });

  test("the demographic form completes through the stand-in and the row re-reads the state the webhook wrote", async ({ page }) => {
    expect((await page.request.post("/api/dev/login", { data: { phone: DEMOGRAPHICS_PHONE } })).ok()).toBe(true);
    await page.addInitScript(() => localStorage.clear());
    await page.goto("/me");
    const row = page.getByTestId("verification-row");
    // Both projects share the database: the second run finds the first's outcome.
    const state = await row.getAttribute("data-state");
    if (state === "demographics_missing") {
      await row.getByRole("button", { name: "Complete Lucra's form" }).click();
      await page.getByRole("dialog", { name: "Sign in to Lucra" }).getByRole("button", { name: "Continue with this phone" }).click();
      const form = page.getByRole("dialog", { name: "A few details for free-to-play" });
      await expect(form).toBeVisible();
      await form.getByRole("button", { name: "Save details" }).click();
    }
    await expect(row).toHaveAttribute("data-state", "verified", { timeout: 15_000 });
    await expect(row).toContainText("Verified with Lucra");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const me = (await (await page.request.get("/api/me")).json()) as { data: { lucra: { verificationState: string } } };
    expect(me.data.lucra.verificationState).toBe("verified");
  });
});
