import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getMatch } from "@/app/api/matches/[id]/route";
import { GET as getTournament } from "@/app/api/tournaments/[slug]/route";
import { GET as getImpact } from "@/app/api/tournaments/[slug]/impact/route";
import { GET as getStandings } from "@/app/api/tournaments/[slug]/standings/route";
import { GET as listTournaments } from "@/app/api/tournaments/route";
import { computeStandings } from "@/domain/standings";
import { SLUGS } from "@/seed/build";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

type Summary = { tournament: { id: string; slug: string; status: string; maxTeams: number }; activeTeams: number; raisedCents: number; donorCount: number; sponsorCount: number };
type Envelope<T> = { ok: true; data: T };

describe("public tournament routes", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
  });
  afterEach(() => app.close());

  const succeeded = (tournamentId: string) =>
    app.data.donations.filter((d) => d.tournamentId === tournamentId && d.status === "succeeded").reduce((s, d) => s + d.amountCents, 0);

  it("lists every event with figures derived from rows, filterable by status", async () => {
    const res = await app.call<Envelope<Summary[]>>(listTournaments, "/api/tournaments");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=10");
    expect(res.body.ok).toBe(true);
    expect(res.body.data.map((s) => s.tournament.status).sort()).toEqual(["live", "registration_open", "settled"]);
    for (const s of res.body.data) {
      expect(s.raisedCents).toBe(succeeded(s.tournament.id));
      expect(s.activeTeams).toBe(app.data.teams.filter((t) => t.tournamentId === s.tournament.id && (t.status === "registered" || t.status === "checked_in")).length);
    }
    const upcoming = res.body.data.find((s) => s.tournament.slug === SLUGS.upcoming);
    expect(upcoming?.activeTeams).toBe(8);

    const live = await app.call<Envelope<Summary[]>>(listTournaments, "/api/tournaments?status=live");
    expect(live.body.data.map((s) => s.tournament.slug)).toEqual([SLUGS.live]);
    const two = await app.call<Envelope<Summary[]>>(listTournaments, "/api/tournaments?status=live,settled");
    expect(two.body.data).toHaveLength(2);
    expectFailure(await app.call(listTournaments, "/api/tournaments?status=bogus"), 400, "bad_request");
  });

  it("returns the full detail: teams, pools with standings, bracket", async () => {
    const res = await app.call<
      Envelope<{
        tournament: { slug: string };
        teams: Array<{ status: string; members: unknown[] }>;
        pools: Array<{ label: string; teams: unknown[]; standings: Array<{ rank: number }>; played: number; total: number; matches: unknown[] }>;
        bracket: { rounds: number; matches: Array<{ match: { round: number; status: string } }> };
        sponsors: unknown[];
      }>
    >(getTournament, `/api/tournaments/${SLUGS.live}`, { params: { slug: SLUGS.live } });
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.tournament.slug).toBe(SLUGS.live);
    expect(data.teams).toHaveLength(24);
    expect(data.teams.every((t) => t.members.length === 2)).toBe(true);
    expect(data.pools).toHaveLength(6);
    for (const pool of data.pools) {
      expect(pool.teams).toHaveLength(4);
      expect(pool.standings.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
      expect(pool.played).toBe(6);
      expect(pool.total).toBe(6);
      expect(pool.matches).toHaveLength(6);
    }
    expect(data.bracket.rounds).toBe(4);
    expect(data.bracket.matches).toHaveLength(15);
    expect(data.bracket.matches[0]?.match.status).toBe("bye");
    expect(data.sponsors).toHaveLength(3);

    // The forming team in the open event is not part of the public roster.
    const open = await app.call<Envelope<{ teams: Array<{ status: string }> }>>(getTournament, `/api/tournaments/${SLUGS.upcoming}`, { params: { slug: SLUGS.upcoming } });
    expect(open.body.data.teams.some((t) => t.status === "forming")).toBe(false);
    expect(open.body.data.teams).toHaveLength(9);

    expectFailure(await app.call(getTournament, "/api/tournaments/nope", { params: { slug: "nope" } }), 404, "not_found");
  });

  it("computes standings from sets rows and marks them cacheable for 10 seconds", async () => {
    const res = await app.call<Envelope<{ pools: Array<{ poolId: string; rows: Array<{ teamId: string; wins: number; pointDiff: number; rank: number }> }> }>>(
      getStandings,
      `/api/tournaments/${SLUGS.live}/standings`,
      { params: { slug: SLUGS.live } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=10, s-maxage=10");
    expect(res.body.data.pools).toHaveLength(6);
    for (const pool of res.body.data.pools) {
      const ids = app.data.poolTeams.filter((pt) => pt.poolId === pool.poolId).map((pt) => pt.teamId);
      const expected = computeStandings(
        ids,
        app.data.matches
          .filter((m) => m.poolId === pool.poolId && m.status === "final")
          .map((m) => ({
            teamAId: m.teamAId ?? "",
            teamBId: m.teamBId ?? "",
            winnerTeamId: m.winnerTeamId ?? "",
            sets: app.data.sets.filter((s) => s.matchId === m.id && s.agreed).map((s) => ({ teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints })),
          })),
      );
      expect(pool.rows).toEqual(expected);
    }
    const none = await app.call<Envelope<{ pools: unknown[] }>>(getStandings, `/api/tournaments/${SLUGS.upcoming}/standings`, { params: { slug: SLUGS.upcoming } });
    expect(none.body.data.pools).toEqual([]);
  });

  it("reports impact as the sum of succeeded donations against the goal", async () => {
    const live = app.tournament(SLUGS.live);
    const res = await app.call<Envelope<{ breakdown: { raisedCents: number; goalCents: number; donorCount: number; fraction: number }; donorWall: unknown[]; charity: { name: string } }>>(
      getImpact,
      `/api/tournaments/${SLUGS.live}/impact`,
      { params: { slug: SLUGS.live } },
    );
    expect(res.status).toBe(200);
    const { breakdown, donorWall, charity } = res.body.data;
    // The stub provider settles pending donations older than its delay on read,
    // so the seeded pending row is succeeded by now and audited as such.
    const pendingInSeed = app.data.donations.filter((d) => d.tournamentId === live.id && d.status === "pending");
    expect(pendingInSeed.length).toBeGreaterThan(0);
    for (const d of pendingInSeed) expect(app.audits(d.id, "donation.succeeded")).toHaveLength(1);
    expect(breakdown.raisedCents).toBe(succeeded(live.id) + pendingInSeed.reduce((sum, d) => sum + d.amountCents, 0));
    expect(breakdown.goalCents).toBe(live.fundraisingGoalCents);
    expect(breakdown.fraction).toBeCloseTo(breakdown.raisedCents / live.fundraisingGoalCents, 6);
    expect(donorWall).toHaveLength(breakdown.donorCount);
    expect(charity.name).toBe("Open Court Project");
  });

  it("returns a match with participants, sets, consensus state and its next seat", async () => {
    const disputed = app.data.matches.find((m) => m.status === "disputed");
    const res = await app.call<Envelope<{ match: { id: string; status: string }; teamA: { members: unknown[] } | null; consensusState: string | null; next: { slot: string } | null; tournament: { slug: string } }>>(
      getMatch,
      `/api/matches/${disputed?.id}`,
      { params: { id: disputed?.id ?? "" } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data.match.status).toBe("disputed");
    expect(res.body.data.consensusState).toBe("disputed");
    expect(res.body.data.teamA?.members).toHaveLength(2);
    expect(res.body.data.next?.slot).toMatch(/^[ab]$/);
    expect(res.body.data.tournament.slug).toBe(SLUGS.live);
    expectFailure(await app.call(getMatch, "/api/matches/nope", { params: { id: "nope" } }), 404, "not_found");
  });
});
