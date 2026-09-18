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
    const body = (await list.json()) as { ok: boolean; data: Array<{ tournament: { slug: string }; activeTeams: number; raisedCents: number }> };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.tournament.slug).toBe("sandbar-classic-2026");
    expect(body.data[0]?.activeTeams).toBe(24);
    expect(body.data[0]?.raisedCents).toBeGreaterThan(0);

    const standings = await request.get("/api/tournaments/sandbar-classic-2026/standings");
    expect(standings.headers()["cache-control"]).toBe("public, max-age=10, s-maxage=10");
    const st = (await standings.json()) as { data: { pools: Array<{ rows: Array<{ rank: number }> }> } };
    expect(st.data.pools).toHaveLength(6);
    expect(st.data.pools[0]?.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);

    const missing = await request.get("/api/tournaments/does-not-exist");
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("a production build keeps the sign-in code out of the response", async ({ request }) => {
    const code = await request.post("/api/auth/request-code", { data: { phone: PLAYER_PHONE } });
    expect(code.ok()).toBe(true);
    const codeBody = (await code.json()) as { ok: boolean; data: { expiresAt: number; devCode?: string } };
    expect(codeBody.data.expiresAt).toBeGreaterThan(Date.now());
    expect(codeBody.data.devCode).toBeUndefined();
    const wrong = await request.post("/api/auth/verify", { data: { phone: PLAYER_PHONE, code: "000000" } });
    expect(wrong.status()).toBe(401);
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
