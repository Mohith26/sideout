import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as me } from "@/app/api/me/route";
import { POST as joinTeam } from "@/app/api/teams/[id]/join/route";
import { POST as createTeam } from "@/app/api/teams/route";
import { GET as getImpact } from "@/app/api/tournaments/[slug]/impact/route";
import { POST as register } from "@/app/api/tournaments/[slug]/register/route";
import { donations, teams, tournaments } from "@/db/schema";
import { settleDueDonations, STUB_SETTLE_DELAY_MS } from "@/server/donations/stub-provider";
import { SLUGS } from "@/seed/build";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

type Envelope<T> = { ok: true; data: T };
type TeamData = { id: string; status: string; name: string; members: Array<{ userId: string; role: string }>; invites: Array<{ status: string; phoneE164: string }> };
type Profile = {
  user: { id: string; role: string };
  lucra: { verificationState: string } | null;
  teams: Array<{ team: { id: string; status: string }; tournament: { slug: string }; donation: { status: string; amountCents: number } | null }>;
  invites: Array<{ team: { id: string }; tournament: { slug: string } }>;
  rewards: unknown[];
};

describe("teams, invites and registration", () => {
  let app: TestApp;
  let captain: TestApp["data"]["users"][number];
  let partner: TestApp["data"]["users"][number];

  beforeEach(() => {
    app = createTestApp();
    // Two seeded players with no team in the open event.
    const open = app.tournament(SLUGS.upcoming);
    const busy = new Set(app.data.teamMembers.filter((m) => app.data.teams.some((t) => t.id === m.teamId && t.tournamentId === open.id)).map((m) => m.userId));
    const invitedPhones = new Set(app.data.teamInvites.map((i) => i.phoneE164));
    const free = app.data.users.filter((u) => u.role === "player" && !busy.has(u.id) && !invitedPhones.has(u.phoneE164 ?? ""));
    const [a, b] = free;
    if (!a || !b) throw new Error("seed needs two free players");
    captain = a;
    partner = b;
  });
  afterEach(() => app.close());

  async function createOpenTeam(name = "Rivera / Okafor"): Promise<TeamData> {
    const res = await app.call<Envelope<TeamData>>(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(captain.id),
      body: { tournamentSlug: SLUGS.upcoming, name, partnerPhone: partner.phoneE164 },
    });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  it("requires a session", async () => {
    expectFailure(await app.call(createTeam, "/api/teams", { method: "POST", body: {} }), 401, "unauthorized");
    expectFailure(await app.call(joinTeam, "/api/teams/x/join", { method: "POST", params: { id: "x" } }), 401, "unauthorized");
    expectFailure(await app.call(register, "/api/tournaments/x/register", { method: "POST", params: { slug: "x" }, body: { teamId: "x" } }), 401, "unauthorized");
    expectFailure(await app.call(me, "/api/me"), 401, "unauthorized");
  });

  it("creates a forming team with the captain and a pending invite, once per player per event", async () => {
    const team = await createOpenTeam();
    expect(team.status).toBe("forming");
    expect(team.members).toEqual([{ userId: captain.id, displayName: captain.displayName, role: "captain" }]);
    expect(team.invites).toHaveLength(1);
    expect(team.invites[0]).toMatchObject({ status: "pending", phoneE164: partner.phoneE164 });
    expect(app.audits(team.id).map((a) => a.action)).toEqual(["team.created", "team.invite_sent"]);

    const again = await app.call(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(captain.id),
      body: { tournamentSlug: SLUGS.upcoming, name: "Second try", partnerPhone: "+15550109999" },
    });
    expectFailure(again, 409, "conflict");

    const self = await app.call(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(partner.id),
      body: { tournamentSlug: SLUGS.upcoming, name: "Solo", partnerPhone: partner.phoneE164 },
    });
    expectFailure(self, 400, "bad_request");

    const closed = await app.call(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(partner.id),
      body: { tournamentSlug: SLUGS.live, name: "Too late", partnerPhone: "+15550109999" },
    });
    expect(expectFailure(closed, 409, "conflict").message).toMatch(/not open/);

    const invalid = await app.call(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(partner.id),
      body: { tournamentSlug: SLUGS.upcoming, name: "X", partnerPhone: "nope" },
    });
    expectFailure(invalid, 400, "bad_request");
  });

  it("lets only the invited phone join, then enforces the two-member rule", async () => {
    const team = await createOpenTeam();
    const stranger = app.data.users.find((u) => u.role === "player" && u.id !== captain.id && u.id !== partner.id);
    const wrong = await app.call(joinTeam, `/api/teams/${team.id}/join`, { method: "POST", params: { id: team.id }, cookie: app.cookieFor(stranger?.id ?? "") });
    expectFailure(wrong, 403, "forbidden");

    // The invitee sees the invite on their profile before joining.
    const before = await app.call<Envelope<Profile>>(me, "/api/me", { cookie: app.cookieFor(partner.id) });
    expect(before.body.data.invites.map((i) => i.team.id)).toEqual([team.id]);

    const joined = await app.call<Envelope<TeamData>>(joinTeam, `/api/teams/${team.id}/join`, { method: "POST", params: { id: team.id }, cookie: app.cookieFor(partner.id) });
    expect(joined.status).toBe(200);
    expect(joined.body.data.members.map((m) => m.role)).toEqual(["captain", "player"]);
    expect(joined.body.data.invites[0]?.status).toBe("accepted");
    expect(app.audits(team.id, "team.member_joined")).toHaveLength(1);

    const twice = await app.call(joinTeam, `/api/teams/${team.id}/join`, { method: "POST", params: { id: team.id }, cookie: app.cookieFor(partner.id) });
    expectFailure(twice, 403, "forbidden");
    expectFailure(await app.call(joinTeam, "/api/teams/nope/join", { method: "POST", params: { id: "nope" }, cookie: app.cookieFor(partner.id) }), 404, "not_found");
  });

  it("registers a complete team in an open window with capacity, creating a pending stub donation", async () => {
    const team = await createOpenTeam();
    const incomplete = await app.call(register, `/api/tournaments/${SLUGS.upcoming}/register`, {
      method: "POST",
      params: { slug: SLUGS.upcoming },
      cookie: app.cookieFor(captain.id),
      body: { teamId: team.id },
    });
    expect(expectFailure(incomplete, 409, "conflict").message).toMatch(/not complete/);

    await app.call(joinTeam, `/api/teams/${team.id}/join`, { method: "POST", params: { id: team.id }, cookie: app.cookieFor(partner.id) });
    const outsider = app.data.users.find((u) => u.role === "player" && u.id !== captain.id && u.id !== partner.id);
    const notMember = await app.call(register, `/api/tournaments/${SLUGS.upcoming}/register`, {
      method: "POST",
      params: { slug: SLUGS.upcoming },
      cookie: app.cookieFor(outsider?.id ?? ""),
      body: { teamId: team.id },
    });
    expectFailure(notMember, 403, "forbidden");

    const res = await app.call<Envelope<{ team: TeamData; donation: { id: string; status: string; provider: string; amountCents: number } | null; lucraEntry: { state: string } }>>(
      register,
      `/api/tournaments/${SLUGS.upcoming}/register`,
      { method: "POST", params: { slug: SLUGS.upcoming }, cookie: app.cookieFor(partner.id), body: { teamId: team.id } },
    );
    expect(res.status).toBe(201);
    const open = app.tournament(SLUGS.upcoming);
    expect(res.body.data.team.status).toBe("registered");
    expect(res.body.data.donation).toMatchObject({ status: "pending", provider: "stub", amountCents: open.entryDonationCents });
    expect(res.body.data.lucraEntry.state).toBe("not_available");
    expect(app.audits(team.id, "team.registered")).toHaveLength(1);
    expect(app.audits(res.body.data.donation?.id ?? "", "donation.created")).toHaveLength(1);

    // Registered teams now count toward capacity and appear on the profile with the donation.
    const profile = await app.call<Envelope<Profile>>(me, "/api/me", { cookie: app.cookieFor(captain.id) });
    const mine = profile.body.data.teams.find((t) => t.team.id === team.id);
    expect(mine).toMatchObject({ team: { status: "registered" }, tournament: { slug: SLUGS.upcoming }, donation: { status: "pending" } });

    const again = await app.call(register, `/api/tournaments/${SLUGS.upcoming}/register`, {
      method: "POST",
      params: { slug: SLUGS.upcoming },
      cookie: app.cookieFor(captain.id),
      body: { teamId: team.id },
    });
    expectFailure(again, 409, "conflict");

    // The stub provider settles after its delay on the injected clock, deterministically.
    const donationId = res.body.data.donation?.id ?? "";
    const createdAt = app.conn.db.select().from(donations).where(eq(donations.id, donationId)).get()?.createdAt ?? 0;
    expect(settleDueDonations(app.conn.db, createdAt + STUB_SETTLE_DELAY_MS - 1)).toBe(0);
    expect(app.conn.db.select().from(donations).where(eq(donations.id, donationId)).get()?.status).toBe("pending");
    expect(settleDueDonations(app.conn.db, createdAt + STUB_SETTLE_DELAY_MS)).toBe(1);
    expect(app.conn.db.select().from(donations).where(eq(donations.id, donationId)).get()?.status).toBe("succeeded");
    expect(app.audits(donationId, "donation.succeeded")).toHaveLength(1);
    const impact = await app.call<Envelope<{ breakdown: { entryCount: number } }>>(getImpact, `/api/tournaments/${SLUGS.upcoming}/impact`, { params: { slug: SLUGS.upcoming } });
    expect(impact.body.data.breakdown.entryCount).toBe(9);
  });

  it("refuses registration when the event is full or the window is closed", async () => {
    const team = await createOpenTeam();
    await app.call(joinTeam, `/api/teams/${team.id}/join`, { method: "POST", params: { id: team.id }, cookie: app.cookieFor(partner.id) });
    const open = app.tournament(SLUGS.upcoming);
    app.conn.db.update(tournaments).set({ maxTeams: 8 }).where(eq(tournaments.id, open.id)).run();
    const full = await app.call(register, `/api/tournaments/${SLUGS.upcoming}/register`, {
      method: "POST",
      params: { slug: SLUGS.upcoming },
      cookie: app.cookieFor(captain.id),
      body: { teamId: team.id },
    });
    expect(expectFailure(full, 409, "conflict").message).toMatch(/full/);
    expect(app.conn.db.select().from(teams).where(eq(teams.id, team.id)).get()?.status).toBe("forming");

    app.conn.db.update(tournaments).set({ maxTeams: 20, status: "registration_closed" }).where(eq(tournaments.id, open.id)).run();
    const closed = await app.call(register, `/api/tournaments/${SLUGS.upcoming}/register`, {
      method: "POST",
      params: { slug: SLUGS.upcoming },
      cookie: app.cookieFor(captain.id),
      body: { teamId: team.id },
    });
    expect(expectFailure(closed, 409, "conflict").message).toMatch(/not open/);
    expect(app.conn.db.select().from(donations).where(eq(donations.teamId, team.id)).all()).toEqual([]);
    expectFailure(
      await app.call(register, `/api/tournaments/${SLUGS.live}/register`, { method: "POST", params: { slug: SLUGS.live }, cookie: app.cookieFor(captain.id), body: { teamId: team.id } }),
      404,
      "not_found",
    );
  });

  it("serves the profile with Lucra link state, team history and rewards", async () => {
    const settled = app.tournament(SLUGS.settled);
    const champion = app.data.rewards.find((r) => r.tournamentId === settled.id && r.placement === 1);
    const member = app.data.teamMembers.find((m) => m.teamId === champion?.teamId);
    const res = await app.call<Envelope<Profile>>(me, "/api/me", { cookie: app.cookieFor(member?.userId ?? "") });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.data.user.id).toBe(member?.userId);
    expect(res.body.data.lucra?.verificationState).toBeDefined();
    expect(res.body.data.teams.some((t) => t.tournament.slug === SLUGS.settled)).toBe(true);
    expect(res.body.data.rewards).toHaveLength(app.data.rewards.filter((r) => r.teamId === champion?.teamId).length);
    // Organizers have no Lucra link and no teams.
    const organizer = await app.call<Envelope<Profile>>(me, "/api/me", { cookie: app.cookieFor(app.organizer().id) });
    expect(organizer.body.data).toMatchObject({ user: { role: "organizer" }, lucra: null, teams: [], rewards: [] });
  });
});
