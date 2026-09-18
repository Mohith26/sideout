import { expect, test } from "@playwright/test";

/**
 * Smoke over the phase-2 API against the production server the e2e run
 * builds: the envelope shape, derived public reads, and the dev sign-in the
 * phase-5 flows will use (present only because the e2e build sets
 * SIDEOUT_DEV_LOGIN=true). Seeded phones are fixed; ids embed the seed day.
 */
const ORGANIZER_PHONE = "+15550109000";
const PLAYER_PHONE = "+15551001000";

test.describe("API", () => {
  test("public reads return the envelope with numbers derived from rows", async ({ request }) => {
    const list = await request.get("/api/tournaments?status=live");
    expect(list.ok()).toBe(true);
    const body = (await list.json()) as { ok: boolean; data: Array<{ tournament: { slug: string; status: string }; activeTeams: number; raisedCents: number }> };
    expect(body.ok).toBe(true);
    // The flows spec takes events of its own live alongside the seeded one; the filter holds for every entry.
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const entry of body.data) expect(entry.tournament.status).toBe("live");
    const sandbar = body.data.find((s) => s.tournament.slug === "sandbar-classic-2026");
    expect(sandbar?.activeTeams).toBe(24);
    expect(sandbar?.raisedCents ?? 0).toBeGreaterThan(0);

    const standings = await request.get("/api/tournaments/sandbar-classic-2026/standings");
    expect(standings.headers()["cache-control"]).toBe("public, max-age=10, s-maxage=10");
    const st = (await standings.json()) as { data: { pools: Array<{ rows: Array<{ rank: number }> }> } };
    expect(st.data.pools).toHaveLength(6);
    expect(st.data.pools[0]?.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);

    const missing = await request.get("/api/tournaments/does-not-exist");
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("a production build with no SMS provider issues no sign-in code at all", async ({ request }) => {
    // The log-based sender is a development stand-in; production never writes a live code to its log.
    const code = await request.post("/api/auth/request-code", { data: { phone: PLAYER_PHONE } });
    expect(code.status()).toBe(503);
    expect(await code.json()).toMatchObject({ ok: false, error: { code: "unavailable", detail: { code: "sms_unavailable" } } });
    const wrong = await request.post("/api/auth/verify", { data: { phone: PLAYER_PHONE, code: "000000" } });
    expect(wrong.status()).toBe(401);
  });

  test("a draft event is invisible to the public page and API until an organizer opens it", async ({ page, request }) => {
    const slug = `draft-${test.info().project.name}-${Date.now()}`;
    // The organizer creates the draft from the browser context, whose cookies page.goto shares.
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    const open = ((await (await request.get("/api/tournaments?status=registration_open")).json()) as { data: Array<{ tournament: Record<string, unknown> }> }).data[0];
    const created = await page.request.post("/api/admin/tournaments", {
      data: {
        slug,
        name: "Secret Invitational",
        beneficiaryId: open?.tournament.beneficiaryId,
        venueName: "Hidden Cove",
        venueCity: "Malibu",
        venueState: "CA",
        venueTimezone: "America/Los_Angeles",
        startsAt: Date.now() + 90 * 24 * 3_600_000,
        endsAt: Date.now() + 90 * 24 * 3_600_000 + 8 * 3_600_000,
        format: "pool_to_bracket",
        division: "open",
        maxTeams: 16,
        entryDonationCents: 5000,
        fundraisingGoalCents: 100000,
      },
    });
    expect(created.status()).toBe(201);

    // Anonymous: neither the API nor the page knows the event exists.
    expect((await request.get(`/api/tournaments/${slug}`)).status()).toBe(404);
    const anonymousPage = await request.get(`/t/${slug}`);
    expect(anonymousPage.status()).toBe(404);
    expect(await anonymousPage.text()).not.toContain("Secret Invitational");

    // The organizer previews it.
    const preview = await page.goto(`/t/${slug}`);
    expect(preview?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Secret Invitational" })).toBeVisible();
    await expect(page).toHaveTitle(/Secret Invitational/);
  });

  test("dev login signs in seeded users and the session gates the organizer routes", async ({ request }) => {
    expect((await request.get("/api/me")).status()).toBe(401);
    const health = (await (await request.get("/health")).json()) as { data: { devLogin: boolean } };
    expect(health.data.devLogin).toBe(true);

    const tournaments = ((await (await request.get("/api/tournaments")).json()) as { data: Array<{ tournament: { id: string; status: string } }> }).data;
    const open = tournaments.find((t) => t.tournament.status === "registration_open");
    expect(open).toBeDefined();

    // As a player: signed in, but not an organizer.
    const asPlayer = await request.post("/api/dev/login", { data: { phone: PLAYER_PHONE } });
    expect(asPlayer.ok()).toBe(true);
    const me = (await (await request.get("/api/me")).json()) as { data: { user: { role: string } } };
    expect(me.data.user.role).toBe("player");
    expect((await request.patch(`/api/admin/tournaments/${open?.tournament.id}`, { data: {} })).status()).toBe(403);

    // As an organizer: an empty patch is accepted and changes nothing.
    const asOrganizer = await request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } });
    expect(asOrganizer.ok()).toBe(true);
    const patched = await request.patch(`/api/admin/tournaments/${open?.tournament.id}`, { data: {} });
    expect(patched.status()).toBe(200);
    expect(((await patched.json()) as { data: { tournament: { status: string } } }).data.tournament.status).toBe("registration_open");

    expect((await request.post("/api/auth/logout")).ok()).toBe(true);
    expect((await request.get("/api/me")).status()).toBe(401);
  });
});
