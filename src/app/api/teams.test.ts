import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as me } from "@/app/api/me/route";
import { POST as joinTeam } from "@/app/api/teams/[id]/join/route";
import { POST as createTeam } from "@/app/api/teams/route";
import { GET as getTournament } from "@/app/api/tournaments/[slug]/route";
import { GET as getImpact } from "@/app/api/tournaments/[slug]/impact/route";
import { POST as register } from "@/app/api/tournaments/[slug]/register/route";
import { donations, teamInvites, teams, tournaments } from "@/db/schema";
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

  /** Team ids the public detail lists for the open event. */
  async function publicRoster(): Promise<Array<{ id: string; status: string }>> {
    const res = await app.call<Envelope<{ teams: Array<{ id: string; status: string }> }>>(getTournament, `/api/tournaments/${SLUGS.upcoming}`, { params: { slug: SLUGS.upcoming } });
    expect(res.status).toBe(200);
    return res.body.data.teams;
  }

  it("lets a captain recover from a mistyped partner phone by creating the team again", async () => {
    const rosterBefore = await publicRoster();
    const mistyped = await app.call<Envelope<TeamData>>(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(captain.id),
      body: { tournamentSlug: SLUGS.upcoming, name: "Rivera / Okafor", partnerPhone: "+15550109999" },
    });
    expect(mistyped.status).toBe(201);
    const old = mistyped.body.data;

    // The second attempt supersedes the first: old invite revoked, old team disbanded, both audited.
    const retry = await createOpenTeam("Rivera / Okafor");
    expect(retry.id).not.toBe(old.id);
    expect(retry.status).toBe("forming");
    expect(retry.invites).toEqual([expect.objectContaining({ status: "pending", phoneE164: partner.phoneE164 })]);
    expect(app.conn.db.select({ status: teams.status }).from(teams).where(eq(teams.id, old.id)).get()?.status).toBe("disbanded");
    const oldInvites = app.conn.db.select().from(teamInvites).where(eq(teamInvites.teamId, old.id)).all();
    expect(oldInvites.map((i) => [i.status, i.respondedAt !== null])).toEqual([["revoked", true]]);
    expect(app.audits(old.id).map((a) => a.action)).toEqual(["team.created", "team.invite_sent", "team.invite_revoked", "team.disbanded"]);
    expect(JSON.parse(app.audits(old.id, "team.disbanded")[0]?.detailJson ?? "{}")).toEqual({ from: "forming", to: "disbanded", supersededBy: retry.id, released: [captain.id] });
    expect(JSON.parse(app.audits(retry.id, "team.created")[0]?.detailJson ?? "{}")).toMatchObject({ supersedes: old.id });
    // Neither the abandoned team nor the forming one reaches the public roster; withdrawn entries stay as they were.
    expect(await publicRoster()).toEqual(rosterBefore);
    expect(rosterBefore.some((t) => t.status === "withdrawn")).toBe(true);

    // The mistyped number no longer has a pending invite anywhere; the right partner does.
    const profile = await app.call<Envelope<Profile>>(me, "/api/me", { cookie: app.cookieFor(partner.id) });
    expect(profile.body.data.invites.map((i) => i.team.id)).toEqual([retry.id]);

    // Even after the partner has joined, an unregistered team is superseded and the partner released.
    const joined = await app.call(joinTeam, `/api/teams/${retry.id}/join`, { method: "POST", params: { id: retry.id }, cookie: app.cookieFor(partner.id) });
    expect(joined.status).toBe(200);
    const third = await app.call<Envelope<TeamData>>(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(captain.id),
      body: { tournamentSlug: SLUGS.upcoming, name: "Third try", partnerPhone: "+15550109998" },
    });
    expect(third.status).toBe(201);
    expect(app.conn.db.select({ status: teams.status }).from(teams).where(eq(teams.id, retry.id)).get()?.status).toBe("disbanded");
    expect(app.audits(retry.id).map((a) => a.action)).toEqual(["team.created", "team.invite_sent", "team.member_joined", "team.disbanded"]);
    expect(JSON.parse(app.audits(retry.id, "team.disbanded")[0]?.detailJson ?? "{}")).toMatchObject({ released: expect.arrayContaining([captain.id, partner.id]) });
    // The released partner is free again: they can be re-invited by the captain's next team.
    const fourth = await createOpenTeam("Rivera / Okafor, take four");
    expect(fourth.invites[0]).toMatchObject({ status: "pending", phoneE164: partner.phoneE164 });
    expect(await publicRoster()).toEqual(rosterBefore);

    // A registered team is final: 409 afterwards, for both members.
    await app.call(joinTeam, `/api/teams/${fourth.id}/join`, { method: "POST", params: { id: fourth.id }, cookie: app.cookieFor(partner.id) });
    const registered = await app.call(register, `/api/tournaments/${SLUGS.upcoming}/register`, {
      method: "POST",
      params: { slug: SLUGS.upcoming },
      cookie: app.cookieFor(captain.id),
      body: { teamId: fourth.id },
    });
    expect(registered.status).toBe(201);
    const blocked = await app.call(createTeam, "/api/teams", { method: "POST", cookie: app.cookieFor(captain.id), body: { tournamentSlug: SLUGS.upcoming, name: "Fifth", partnerPhone: "+15550109998" } });
    expect(expectFailure(blocked, 409, "conflict").detail).toEqual({ teamId: fourth.id });
    expectFailure(
      await app.call(createTeam, "/api/teams", { method: "POST", cookie: app.cookieFor(partner.id), body: { tournamentSlug: SLUGS.upcoming, name: "Breakaway", partnerPhone: "+15550109998" } }),
      409,
      "conflict",
    );
    expect((await publicRoster()).map((t) => t.id)).toContain(fourth.id);
  });

  it("resolves crossed invites: accepting one disbands the joiner's own forming team", async () => {
    // Each invites the other, so each holds a solo forming team and a pending invite.
    const byCaptain = await createOpenTeam("Rivera / Okafor");
    const byPartner = await app.call<Envelope<TeamData>>(createTeam, "/api/teams", {
      method: "POST",
      cookie: app.cookieFor(partner.id),
      body: { tournamentSlug: SLUGS.upcoming, name: "Okafor / Rivera", partnerPhone: captain.phoneE164 },
    });
    expect(byPartner.status).toBe(201);
    const captainProfile = await app.call<Envelope<Profile>>(me, "/api/me", { cookie: app.cookieFor(captain.id) });
    expect(captainProfile.body.data.invites.map((i) => i.team.id)).toEqual([byPartner.body.data.id]);

    // The partner accepts the captain's invite; their own team dissolves in the same step.
    const joined = await app.call<Envelope<TeamData>>(joinTeam, `/api/teams/${byCaptain.id}/join`, { method: "POST", params: { id: byCaptain.id }, cookie: app.cookieFor(partner.id) });
    expect(joined.status).toBe(200);
    expect(joined.body.data.members.map((m) => [m.userId, m.role])).toEqual([
      [captain.id, "captain"],
      [partner.id, "player"],
    ]);
    expect(app.conn.db.select({ status: teams.status }).from(teams).where(eq(teams.id, byPartner.body.data.id)).get()?.status).toBe("disbanded");
    expect(app.conn.db.select({ status: teamInvites.status }).from(teamInvites).where(eq(teamInvites.teamId, byPartner.body.data.id)).all()).toEqual([{ status: "revoked" }]);
    expect(app.audits(byPartner.body.data.id).map((a) => a.action)).toEqual(["team.created", "team.invite_sent", "team.invite_revoked", "team.disbanded"]);
    expect(JSON.parse(app.audits(byPartner.body.data.id, "team.disbanded")[0]?.detailJson ?? "{}")).toEqual({ from: "forming", to: "disbanded", supersededBy: byCaptain.id, released: [partner.id] });
    expect(JSON.parse(app.audits(byCaptain.id, "team.member_joined")[0]?.detailJson ?? "{}")).toMatchObject({ supersedes: byPartner.body.data.id });

    // The captain's invite from the dissolved team is gone, and the stale team cannot be joined.
    const after = await app.call<Envelope<Profile>>(me, "/api/me", { cookie: app.cookieFor(captain.id) });
    expect(after.body.data.invites).toEqual([]);
    expectFailure(await app.call(joinTeam, `/api/teams/${byPartner.body.data.id}/join`, { method: "POST", params: { id: byPartner.body.data.id }, cookie: app.cookieFor(captain.id) }), 403, "forbidden");

    // The pair registers as one team.
    const registered = await app.call(register, `/api/tournaments/${SLUGS.upcoming}/register`, {
      method: "POST",
      params: { slug: SLUGS.upcoming },
      cookie: app.cookieFor(captain.id),
      body: { teamId: byCaptain.id },
    });
    expect(registered.status).toBe(201);
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
    expect(res.body.data.lucraEntry.state).toBe("awaiting_sdk_join");
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
