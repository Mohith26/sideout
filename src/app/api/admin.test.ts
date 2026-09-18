import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as forfeit } from "@/app/api/admin/matches/[id]/forfeit/route";
import { POST as drawRoute } from "@/app/api/admin/tournaments/[id]/draw/route";
import { PATCH as patchTournament } from "@/app/api/admin/tournaments/[id]/route";
import { POST as createTournament } from "@/app/api/admin/tournaments/route";
import { matches, pools, poolTeams, sponsors, teamMembers, teams, tournaments, type Match, type NewTournament } from "@/db/schema";
import { drawConfigSchema } from "@/domain/draw";
import { uuidv7 } from "@/lib/uuid";
import { SEED_DRAWS, SLUGS } from "@/seed/build";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

type Envelope<T> = { ok: true; data: T };
type Detail = {
  tournament: NewTournament & { id: string };
  sponsors: Array<{ id: string; name: string; tier: string; prizeContributionCents: number }>;
  pools: Array<{ label: string; teams: unknown[]; matches: unknown[] }>;
  bracket: { rounds: number; matches: Array<{ match: Match }> };
  activeTeams: number;
};
type DrawOutcome = {
  preview: {
    stage: string;
    rngSeed: number | null;
    plan: { order: string[]; pools: Array<{ teamIds: string[] }>; matches: Array<{ status: string; round: number }>; bracket: { size: number; advancing: number } | null };
    teams: Record<string, { name: string; seed: number | null }>;
    advancing?: string[];
  };
  detail: Detail | null;
};

const HOUR = 3_600_000;

describe("organizer routes", () => {
  let app: TestApp;
  let organizerCookie: string;
  let playerCookie: string;
  let charityId: string;

  beforeEach(() => {
    app = createTestApp();
    organizerCookie = app.cookieFor(app.organizer().id);
    playerCookie = app.cookieFor(app.player().id);
    charityId = app.data.charities[0]?.id ?? "";
  });
  afterEach(() => app.close());

  const validCreate = (patch: Record<string, unknown> = {}) => ({
    slug: "dawn-patrol-2027",
    name: "Dawn Patrol",
    beneficiaryId: charityId,
    venueName: "Zuma Beach Courts",
    venueCity: "Malibu",
    venueState: "ca",
    venueTimezone: "America/Los_Angeles",
    startsAt: app.anchorMs + 60 * 24 * HOUR,
    endsAt: app.anchorMs + 60 * 24 * HOUR + 9 * HOUR,
    format: "pool_to_bracket",
    division: "open",
    maxTeams: 16,
    entryDonationCents: 5000,
    fundraisingGoalCents: 400000,
    ...patch,
  });

  async function create(patch: Record<string, unknown> = {}): Promise<Detail> {
    const res = await app.call<Envelope<Detail>>(createTournament, "/api/admin/tournaments", { method: "POST", cookie: organizerCookie, body: validCreate(patch) });
    if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  async function patch(id: string, body: Record<string, unknown>) {
    return app.call<Envelope<Detail>>(patchTournament, `/api/admin/tournaments/${id}`, { method: "PATCH", params: { id }, cookie: organizerCookie, body });
  }

  /** Register `n` complete teams straight into the rows, as phase-1 seed data would. */
  function enterTeams(tournamentId: string, n: number, seedFirst = 0): string[] {
    const players = app.data.users.filter((u) => u.role === "player");
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = uuidv7();
      app.conn.db
        .insert(teams)
        .values({ id, tournamentId, name: `Team ${i + 1}`, seed: i < seedFirst ? i + 1 : null, status: "registered", createdAt: app.anchorMs + i })
        .run();
      const a = players[(i * 2) % players.length];
      const b = players[(i * 2 + 1) % players.length];
      app.conn.db.insert(teamMembers).values({ id: uuidv7(), teamId: id, userId: a?.id ?? "", role: "captain" }).run();
      app.conn.db.insert(teamMembers).values({ id: uuidv7(), teamId: id, userId: b?.id ?? "", role: "player" }).run();
      ids.push(id);
    }
    return ids;
  }

  async function drawCall(id: string, body: Record<string, unknown>, preview = false) {
    return app.call<Envelope<DrawOutcome>>(drawRoute, `/api/admin/tournaments/${id}/draw${preview ? "?preview=1" : ""}`, {
      method: "POST",
      params: { id },
      cookie: organizerCookie,
      body,
    });
  }

  describe("role gating", () => {
    it("refuses anonymous and player callers on every admin route", async () => {
      expectFailure(await app.call(createTournament, "/api/admin/tournaments", { method: "POST", body: validCreate() }), 401, "unauthorized");
      expectFailure(await app.call(createTournament, "/api/admin/tournaments", { method: "POST", cookie: playerCookie, body: validCreate() }), 403, "forbidden");
      const live = app.tournament(SLUGS.live);
      expectFailure(await app.call(patchTournament, `/api/admin/tournaments/${live.id}`, { method: "PATCH", params: { id: live.id }, cookie: playerCookie, body: {} }), 403, "forbidden");
      expectFailure(await app.call(drawRoute, `/api/admin/tournaments/${live.id}/draw`, { method: "POST", params: { id: live.id }, cookie: playerCookie, body: {} }), 403, "forbidden");
      expectFailure(await app.call(forfeit, "/api/admin/matches/x/forfeit", { method: "POST", params: { id: "x" }, cookie: playerCookie, body: { teamId: "y" } }), 403, "forbidden");
      expect(app.conn.db.select().from(tournaments).all()).toHaveLength(3);
    });
  });

  describe("create and update", () => {
    it("creates a draft with defaults, a namespaced Lucra external id, sponsors and an audit row", async () => {
      const detail = await create({ sponsors: [{ name: "Pier Coffee", tier: "court", prizeContributionCents: 25000 }] });
      const t = detail.tournament;
      expect(t).toMatchObject({ slug: "dawn-patrol-2027", status: "draft", venueState: "CA", currency: "USD", prizeKind: "free_to_play_rewards", lucraGameId: "SIDEOUT_BEACH_2V2", lucraLocationId: null });
      expect(t.lucraExternalId).toMatch(/^sideout-dawn-patrol-2027-[0-9a-f]{8}$/);
      expect(detail.sponsors).toEqual([expect.objectContaining({ name: "Pier Coffee", tier: "court", prizeContributionCents: 25000 })]);
      expect(app.audits(t.id).map((a) => a.action)).toEqual(["tournament.created", "tournament.sponsors_updated"]);
      expect(app.audits(t.id)[0]?.actorUserId).toBe(app.organizer().id);
    });

    it("validates input at the boundary and refuses duplicates and disabled prize kinds", async () => {
      const bad = async (patchBody: Record<string, unknown>, status: number, code: string) =>
        expectFailure(await app.call(createTournament, "/api/admin/tournaments", { method: "POST", cookie: organizerCookie, body: validCreate(patchBody) }), status, code);
      await bad({ slug: "Bad Slug!" }, 400, "bad_request");
      await bad({ venueTimezone: "Mars/Olympus" }, 400, "bad_request");
      await bad({ endsAt: app.anchorMs }, 400, "bad_request");
      await bad({ beneficiaryId: "nope" }, 400, "bad_request");
      await bad({ format: "swiss" }, 400, "bad_request");
      await bad({ unknownField: 1 }, 400, "bad_request");
      await bad({ prizeKind: "real_money" }, 403, "forbidden");
      await bad({ slug: SLUGS.live }, 409, "conflict");
      expect(app.conn.db.select().from(tournaments).all()).toHaveLength(3);
    });

    it("updates editable fields and replaces the sponsor list by id", async () => {
      const created = await create({ sponsors: [{ name: "Keep Me", tier: "presenting", prizeContributionCents: 100000 }, { name: "Drop Me", tier: "prize", prizeContributionCents: 1000 }] });
      const keep = created.sponsors.find((s) => s.name === "Keep Me");
      const res = await patch(created.tournament.id, {
        name: "Dawn Patrol Invitational",
        subtitle: "Sunrise doubles",
        maxTeams: 24,
        sponsors: [{ id: keep?.id, name: "Kept & Renamed", tier: "presenting", prizeContributionCents: 120000 }, { name: "New One", tier: "court", prizeContributionCents: 5000 }],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tournament).toMatchObject({ name: "Dawn Patrol Invitational", subtitle: "Sunrise doubles", maxTeams: 24 });
      expect(res.body.data.sponsors.map((s) => s.name).sort()).toEqual(["Kept & Renamed", "New One"]);
      expect(res.body.data.sponsors.find((s) => s.name === "Kept & Renamed")?.id).toBe(keep?.id);
      expect(app.conn.db.select().from(sponsors).where(eq(sponsors.tournamentId, created.tournament.id)).all()).toHaveLength(2);
      const audit = app.audits(created.tournament.id, "tournament.updated");
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]?.detailJson ?? "{}")).toEqual({ fields: ["name", "subtitle", "maxTeams"] });
      expectFailure(await patch(created.tournament.id, { sponsors: [{ id: "ghost", name: "X", tier: "court", prizeContributionCents: 0 }] }), 400, "bad_request");
      expectFailure(await patch("nope", { name: "Nobody" }), 404, "not_found");
      expectFailure(await patch(created.tournament.id, { nope: 1 }), 400, "bad_request");
    });

    it("locks fields that rows already depend on", async () => {
      const live = app.tournament(SLUGS.live);
      expectFailure(await patch(live.id, { format: "single_elim" }), 409, "conflict");
      expectFailure(await patch(live.id, { maxTeams: 8 }), 409, "conflict");
      expectFailure(await patch(live.id, { beneficiaryId: "another-charity" }), 409, "conflict");
      expectFailure(await patch(live.id, { currency: "EUR" }), 409, "conflict");
      // The same value is a no-op, not a violation, and writes no audit row.
      const before = app.audits(live.id).length;
      expect((await patch(live.id, { beneficiaryId: charityId, maxTeams: 24 })).status).toBe(200);
      expect(app.audits(live.id)).toHaveLength(before);
      const settled = app.tournament(SLUGS.settled);
      expectFailure(await patch(settled.id, { name: "Rewriting history" }), 409, "conflict");
    });

    it("walks the status machine through PATCH, audits each step, and refuses illegal edges", async () => {
      const created = await create();
      const id = created.tournament.id;
      expectFailure(await patch(id, { status: "live" }), 409, "conflict");
      expectFailure(await patch(id, { status: "settled" }), 409, "conflict");
      expect((await patch(id, { status: "registration_open" })).body.data.tournament.status).toBe("registration_open");
      expectFailure(await patch(id, { status: "draft" }), 409, "conflict");
      expect((await patch(id, { status: "registration_closed" })).body.data.tournament.status).toBe("registration_closed");
      // Live needs a draw.
      expect(expectFailure(await patch(id, { status: "live" }), 409, "conflict").message).toMatch(/draw/);
      enterTeams(id, 8);
      expect((await drawCall(id, { courts: 2 })).status).toBe(201);
      expect((await patch(id, { status: "live" })).body.data.tournament.status).toBe("live");
      expectFailure(await patch(id, { status: "cancelled" }), 409, "conflict");
      expectFailure(await patch(id, { status: "awaiting_settlement" }), 409, "conflict");
      const transitions = app.audits(id, "tournament.status_changed").map((a) => JSON.parse(a.detailJson ?? "{}"));
      expect(transitions).toEqual([
        { from: "draft", to: "registration_open" },
        { from: "registration_open", to: "registration_closed" },
        { from: "registration_closed", to: "live" },
      ]);
      // Cancel from a pre-live state.
      const doomed = await create({ slug: "doomed-2027" });
      expect((await patch(doomed.tournament.id, { status: "cancelled" })).body.data.tournament.status).toBe("cancelled");
      expectFailure(await patch(doomed.tournament.id, { name: "Back from the dead" }), 409, "conflict");
    });
  });

  describe("draw", () => {
    async function readyTournament(n: number, extra: Record<string, unknown> = {}): Promise<string> {
      const created = await create({ slug: `draw-${n}-${Math.random().toString(36).slice(2, 8)}`, ...extra });
      const id = created.tournament.id;
      enterTeams(id, n);
      await patch(id, { status: "registration_open" });
      await patch(id, { status: "registration_closed" });
      return id;
    }

    it("refuses to draw outside registration_closed", async () => {
      const created = await create();
      expect(expectFailure(await drawCall(created.tournament.id, {}), 409, "conflict").message).toMatch(/registration is closed/);
      const live = app.tournament(SLUGS.live);
      expectFailure(await drawCall(live.id, {}), 409, "conflict");
      expectFailure(await drawCall("nope", {}), 404, "not_found");
    });

    it("previews without writing, then commits the same draw for the same rng seed", async () => {
      const id = await readyTournament(24);
      const preview = await drawCall(id, { courts: 6, poolSize: 4, advance: { perPool: 2, bestRemaining: 3 } }, true);
      expect(preview.status).toBe(200);
      const p = preview.body.data;
      expect(p.detail).toBeNull();
      expect(p.preview.stage).toBe("pools");
      expect(p.preview.plan.pools).toHaveLength(6);
      expect(p.preview.plan.bracket).toEqual({ size: 16, rounds: 4, advancing: 15 });
      expect(app.conn.db.select().from(pools).where(eq(pools.tournamentId, id)).all()).toEqual([]);
      expect(app.conn.db.select().from(matches).where(eq(matches.tournamentId, id)).all()).toEqual([]);

      const commit = await drawCall(id, { courts: 6, poolSize: 4, advance: { perPool: 2, bestRemaining: 3 }, rngSeed: p.preview.rngSeed });
      expect(commit.status).toBe(201);
      expect(commit.body.data.preview.plan.pools.map((x) => x.teamIds)).toEqual(p.preview.plan.pools.map((x) => x.teamIds));
      const detail = commit.body.data.detail;
      expect(detail?.pools).toHaveLength(6);
      expect(detail?.pools.every((x) => x.teams.length === 4 && x.matches.length === 6)).toBe(true);
      expect(detail?.bracket.rounds).toBe(4);
      expect(detail?.bracket.matches).toHaveLength(15);
      expect(detail?.bracket.matches.every((m) => m.match.teamAId === null && m.match.status === "scheduled")).toBe(true);
      const poolIds = app.conn.db.select({ id: pools.id }).from(pools).where(eq(pools.tournamentId, id)).all().map((x) => x.id);
      expect(app.conn.db.select().from(poolTeams).all().filter((pt) => poolIds.includes(pt.poolId))).toHaveLength(24);
      // Every next_match_id resolves inside this tournament.
      const rows = app.conn.db.select().from(matches).where(eq(matches.tournamentId, id)).all();
      const ids = new Set(rows.map((m) => m.id));
      for (const m of rows) if (m.nextMatchId) expect(ids.has(m.nextMatchId)).toBe(true);
      expect(app.audits(id, "tournament.draw_generated")).toHaveLength(1);
      expect(JSON.parse(app.audits(id, "tournament.draw_generated")[0]?.detailJson ?? "{}")).toMatchObject({ rngSeed: p.preview.rngSeed, advance: { perPool: 2, bestRemaining: 3 } });
    });

    it("re-draws while nothing has started, and refuses once a match is under way", async () => {
      const id = await readyTournament(8);
      expect((await drawCall(id, { courts: 2, rngSeed: 1 })).status).toBe(201);
      const first = app.conn.db.select().from(matches).where(eq(matches.tournamentId, id)).all();
      const again = await drawCall(id, { courts: 2, rngSeed: 2 });
      expect(again.status).toBe(201);
      const second = app.conn.db.select().from(matches).where(eq(matches.tournamentId, id)).all();
      expect(second).toHaveLength(first.length);
      expect(second.map((m) => m.id).some((x) => first.some((f) => f.id === x))).toBe(false);
      expect(app.audits(id, "tournament.redrawn")).toHaveLength(1);
      const stored = app.conn.db.select({ drawConfigJson: tournaments.drawConfigJson }).from(tournaments).where(eq(tournaments.id, id)).get()?.drawConfigJson;
      expect(drawConfigSchema.parse(JSON.parse(stored ?? "null"))).toMatchObject({ courts: 2, rngSeed: 2, advance: { perPool: 2, bestRemaining: 0 } });

      const started = second.find((m) => m.poolId !== null);
      app.conn.db.update(matches).set({ status: "in_progress" }).where(eq(matches.id, started?.id ?? "")).run();
      expect(expectFailure(await drawCall(id, { courts: 2 }), 409, "conflict").message).toMatch(/already started/);
    });

    it("keeps entry seeds across a pool_to_bracket re-draw with new courts, and never writes bracket order to teams.seed", async () => {
      const id = await readyTournament(8);
      const [a, b] = app.conn.db.select({ id: teams.id }).from(teams).where(eq(teams.tournamentId, id)).all().map((t) => t.id);
      if (!a || !b) throw new Error("expected two teams");
      const poolOf = (teamId: string, detail: Detail | null) => detail?.pools.findIndex((p) => (p.teams as Array<{ id: string }>).some((t) => t.id === teamId));

      const seeded = await drawCall(id, { courts: 2, poolSize: 4, seeds: [{ teamId: a, seed: 1 }, { teamId: b, seed: 2 }], rngSeed: 7 });
      expect(seeded.status).toBe(201);
      expect(seeded.body.data.preview.plan.order.slice(0, 2)).toEqual([a, b]);
      expect(seeded.body.data.preview.teams[a]?.seed).toBe(1);
      expect(poolOf(a, seeded.body.data.detail)).not.toBe(poolOf(b, seeded.body.data.detail));
      const entrySeeds = () =>
        app.conn.db
          .select({ id: teams.id, seed: teams.seed })
          .from(teams)
          .where(and(eq(teams.tournamentId, id), isNotNull(teams.seed)))
          .all()
          .sort((x, y) => (x.seed ?? 0) - (y.seed ?? 0));
      expect(entrySeeds()).toEqual([
        { id: a, seed: 1 },
        { id: b, seed: 2 },
      ]);

      // Re-draw for a different court count, without resending seeds: the stored entry seeds still lead the order.
      const redrawn = await drawCall(id, { courts: 4, poolSize: 4, rngSeed: 8 });
      expect(redrawn.status).toBe(201);
      expect(redrawn.body.data.preview.plan.order.slice(0, 2)).toEqual([a, b]);
      expect(poolOf(a, redrawn.body.data.detail)).not.toBe(poolOf(b, redrawn.body.data.detail));
      expect(entrySeeds()).toEqual([
        { id: a, seed: 1 },
        { id: b, seed: 2 },
      ]);

      // Seeds can be swapped and cleared; teams left out keep theirs.
      const swapped = await drawCall(id, { courts: 4, seeds: [{ teamId: a, seed: 2 }, { teamId: b, seed: 1 }], rngSeed: 8 });
      expect(swapped.status).toBe(201);
      expect(swapped.body.data.preview.plan.order.slice(0, 2)).toEqual([b, a]);
      const cleared = await drawCall(id, { courts: 4, seeds: [{ teamId: b, seed: null }], rngSeed: 8 });
      expect(cleared.status).toBe(201);
      expect(entrySeeds()).toEqual([{ id: a, seed: 2 }]);
      expect(cleared.body.data.preview.plan.order[0]).toBe(a);
      expectFailure(await drawCall(id, { courts: 4, seeds: [{ teamId: b, seed: 2 }] }), 400, "bad_request");
    });

    it("keeps single_elim entry seeds across a re-draw and reshuffles the unseeded teams", async () => {
      const id = await readyTournament(8, { format: "single_elim" });
      const [top] = app.conn.db.select({ id: teams.id }).from(teams).where(eq(teams.tournamentId, id)).all().map((t) => t.id);
      if (!top) throw new Error("expected a team");
      const first = await drawCall(id, { courts: 2, seeds: [{ teamId: top, seed: 1 }], rngSeed: 1 });
      expect(first.status).toBe(201);
      const seedsOf = () => app.conn.db.select({ id: teams.id, seed: teams.seed }).from(teams).where(eq(teams.tournamentId, id)).all();
      // The draw placed eight teams into round 1 but wrote no bracket seeds back: only the entry seed exists.
      expect(seedsOf().filter((t) => t.seed !== null)).toEqual([{ id: top, seed: 1 }]);
      expect(first.body.data.preview.plan.order[0]).toBe(top);
      expect(first.body.data.detail?.bracket.matches[0]?.match.teamAId).toBe(top);

      const second = await drawCall(id, { courts: 4, rngSeed: 2 });
      expect(second.status).toBe(201);
      expect(seedsOf().filter((t) => t.seed !== null)).toEqual([{ id: top, seed: 1 }]);
      expect(second.body.data.preview.plan.order[0]).toBe(top);
      expect(second.body.data.detail?.bracket.matches[0]?.match.teamAId).toBe(top);
      expect(second.body.data.preview.plan.order).not.toEqual(first.body.data.preview.plan.order);
    });

    it("draws single elimination straight from seeds, with byes only in round 1, and refuses double elimination", async () => {
      const id = await readyTournament(5, { format: "single_elim" });
      app.conn.db.update(teams).set({ seed: 1 }).where(and(eq(teams.tournamentId, id), eq(teams.name, "Team 3"))).run();
      const res = await drawCall(id, { courts: 2 });
      expect(res.status).toBe(201);
      const bracket = res.body.data.detail?.bracket.matches.map((m) => m.match) ?? [];
      expect(bracket).toHaveLength(7);
      const byes = bracket.filter((m) => m.status === "bye");
      expect(byes).toHaveLength(3);
      expect(byes.every((m) => m.round === 1 && m.teamBId === null && m.winnerTeamId === m.teamAId)).toBe(true);
      const top = app.conn.db.select().from(teams).where(and(eq(teams.tournamentId, id), eq(teams.name, "Team 3"))).get();
      expect(top?.seed).toBe(1);
      expect(bracket[0]?.teamAId).toBe(top?.id);
      expect(app.audits(byes[0]?.id ?? "", "match.status_changed")).toHaveLength(1);
      expect(res.body.data.detail?.pools).toEqual([]);

      const de = await readyTournament(8, { format: "double_elim" });
      const refused = expectFailure(await drawCall(de, { courts: 2 }), 409, "conflict");
      expect(refused.detail).toEqual({ code: "unsupported_format" });
    });

    it("draws a round robin as one pool and rejects rules the pools cannot satisfy", async () => {
      const rr = await readyTournament(6, { format: "round_robin" });
      const res = await drawCall(rr, { courts: 3 });
      expect(res.status).toBe(201);
      expect(res.body.data.detail?.pools).toHaveLength(1);
      expect(res.body.data.detail?.pools[0]?.matches).toHaveLength(15);
      expect(res.body.data.detail?.bracket.matches).toEqual([]);

      const ptb = await readyTournament(8);
      expectFailure(await drawCall(ptb, { courts: 2, advance: { perPool: 5, bestRemaining: 0 } }), 400, "bad_request");
      expectFailure(await drawCall(ptb, { courts: 0 }), 400, "bad_request");
      expectFailure(await drawCall(ptb, { seeds: [{ teamId: "ghost", seed: 1 }] }), 400, "bad_request");
      // Shape errors name the field, so the organizer console can point at it.
      expect(expectFailure(await drawCall(ptb, { courts: "4" }), 400, "bad_request").detail).toMatchObject({ issues: [{ path: "courts", message: expect.stringMatching(/number/) }] });
      expect(expectFailure(await drawCall(ptb, { seeds: "nope" }), 400, "bad_request").detail).toMatchObject({ issues: [{ path: "seeds", message: expect.stringMatching(/array/) }] });
      expect(expectFailure(await drawCall(ptb, { stage: "finals" }), 400, "bad_request").detail).toMatchObject({ issues: [{ path: "stage" }] });
    });

    /** Resolve every pool match: the earlier-created team wins, no sets (as forfeits would). */
    function playPools(id: string): Match[] {
      const poolMatches = app.conn.db
        .select()
        .from(matches)
        .where(and(eq(matches.tournamentId, id), isNotNull(matches.poolId)))
        .all();
      for (const m of poolMatches) {
        const winner = [m.teamAId, m.teamBId].filter((x): x is string => Boolean(x)).sort()[0] ?? null;
        app.conn.db.update(matches).set({ status: "forfeited", winnerTeamId: winner, finalizedAt: app.anchorMs }).where(eq(matches.id, m.id)).run();
      }
      return poolMatches;
    }

    it("seeds the bracket from finished pools at the bracket stage, byes auto-advancing", async () => {
      const id = await readyTournament(12);
      expect((await drawCall(id, { courts: 3, poolSize: 4, advance: { perPool: 2, bestRemaining: 1 } })).status).toBe(201);
      await patch(id, { status: "live" });
      expectFailure(await drawCall(id, { stage: "bracket" }), 409, "conflict");
      expect(playPools(id)).toHaveLength(18);

      const preview = await drawCall(id, { stage: "bracket" }, true);
      expect(preview.status).toBe(200);
      expect(preview.body.data.preview.advancing).toHaveLength(7);

      const res = await drawCall(id, { stage: "bracket" });
      expect(res.status).toBe(201);
      const bracket = res.body.data.detail?.bracket.matches.map((m) => m.match) ?? [];
      expect(bracket).toHaveLength(7);
      const round1 = bracket.filter((m) => m.round === 1);
      expect(round1.filter((m) => m.status === "bye")).toHaveLength(1);
      expect(round1.flatMap((m) => [m.teamAId, m.teamBId]).filter(Boolean)).toHaveLength(7);
      // The bracket order lives on the slots; nothing was written to teams.seed.
      expect(app.conn.db.select().from(teams).where(and(eq(teams.tournamentId, id), isNotNull(teams.seed))).all()).toEqual([]);
      const bye = round1.find((m) => m.status === "bye");
      const next = bracket.find((m) => m.id === bye?.nextMatchId);
      expect(bye?.nextMatchSlot === "a" ? next?.teamAId : next?.teamBId).toBe(bye?.teamAId);
      expect(app.audits(id, "tournament.bracket_seeded")).toHaveLength(1);
      expect(JSON.parse(app.audits(id, "tournament.bracket_seeded")[0]?.detailJson ?? "{}")).toMatchObject({ advance: { perPool: 2, bestRemaining: 1 } });
      expect(app.audits(bye?.id ?? "", "match.status_changed")).toHaveLength(1);
      // Seeding twice is refused: round 1 is no longer empty.
      expectFailure(await drawCall(id, { stage: "bracket" }), 409, "conflict");
    });

    it("carries the seed's 24-team configuration through both stages with the stored rule, refusing a resent one", async () => {
      const id = await readyTournament(24, { maxTeams: 24 });
      const { courts, poolSize, advance } = SEED_DRAWS.live;
      const pools = await drawCall(id, { courts, poolSize, advance, rngSeed: 3 });
      expect(pools.status).toBe(201);
      expect(pools.body.data.preview.plan.bracket).toEqual({ size: 16, rounds: 4, advancing: 15 });
      await patch(id, { status: "live" });
      expect(playPools(id)).toHaveLength(36);

      // The bracket stage takes no rule: the one that sized the bracket is on the tournament.
      expectFailure(await drawCall(id, { stage: "bracket", advance: { perPool: 2, bestRemaining: 0 } }), 400, "bad_request");
      expectFailure(await drawCall(id, { stage: "bracket", courts: 6 }), 400, "bad_request");
      const res = await drawCall(id, { stage: "bracket" });
      expect(res.status).toBe(201);
      expect(res.body.data.preview.advancing).toHaveLength(15);
      const round1 = (res.body.data.detail?.bracket.matches.map((m) => m.match) ?? []).filter((m) => m.round === 1);
      expect(round1).toHaveLength(8);
      expect(round1.filter((m) => m.status === "bye")).toHaveLength(1);
      expect(new Set(round1.flatMap((m) => [m.teamAId, m.teamBId]).filter(Boolean)).size).toBe(15);
      expect(round1[0]?.teamAId).toBe(res.body.data.preview.advancing?.[0]);
    });

    it("refuses the bracket stage when the draw has no stored configuration", async () => {
      const id = await readyTournament(8);
      expect((await drawCall(id, { courts: 2 })).status).toBe(201);
      await patch(id, { status: "live" });
      playPools(id);
      app.conn.db.update(tournaments).set({ drawConfigJson: null }).where(eq(tournaments.id, id)).run();
      const refused = expectFailure(await drawCall(id, { stage: "bracket" }), 409, "conflict");
      expect(refused.detail).toEqual({ code: "draw_config_missing" });
      expect(app.conn.db.select().from(matches).where(and(eq(matches.tournamentId, id), isNull(matches.poolId), isNotNull(matches.teamAId))).all()).toEqual([]);
    });
  });

  describe("forfeit", () => {
    it("advances the opponent into the next slot and audits both matches", async () => {
      const live = app.tournament(SLUGS.live);
      const semi = app.data.matches.find((m) => m.tournamentId === live.id && m.status === "in_progress");
      if (!semi?.teamAId || !semi.teamBId || !semi.nextMatchId) throw new Error("seed: expected an in-progress semifinal with a next match");
      const res = await app.call<Envelope<{ match: Match; next: { matchId: string; slot: string } | null }>>(forfeit, `/api/admin/matches/${semi.id}/forfeit`, {
        method: "POST",
        params: { id: semi.id },
        cookie: organizerCookie,
        body: { teamId: semi.teamAId },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.match).toMatchObject({ status: "forfeited", winnerTeamId: semi.teamBId });
      expect(res.body.data.match.finalizedAt).not.toBeNull();
      const finalMatch = app.conn.db.select().from(matches).where(eq(matches.id, semi.nextMatchId)).get();
      expect(semi.nextMatchSlot === "a" ? finalMatch?.teamAId : finalMatch?.teamBId).toBe(semi.teamBId);
      // The seed recorded the match going on the sand at its fictional time today (mid-afternoon
      // at the venue); the forfeit is stamped by the real clock, so the two are not compared by
      // order — the forfeit's row is the one at the match's finalizedAt.
      const statusChanges = app.audits(semi.id, "match.status_changed");
      expect(statusChanges.map((a) => JSON.parse(a.detailJson ?? "{}"))).toEqual(
        expect.arrayContaining([
          { from: "scheduled", to: "in_progress" },
          { from: "in_progress", to: "forfeited", winnerTeamId: semi.teamBId, forfeitedTeamId: semi.teamAId },
        ]),
      );
      expect(statusChanges).toHaveLength(2);
      expect(statusChanges.find((a) => a.createdAt === res.body.data.match.finalizedAt)?.detailJson).toContain('"to":"forfeited"');
      expect(app.audits(semi.nextMatchId, "match.slot_filled")).toHaveLength(1);

      expectFailure(
        await app.call(forfeit, `/api/admin/matches/${semi.id}/forfeit`, { method: "POST", params: { id: semi.id }, cookie: organizerCookie, body: { teamId: semi.teamAId } }),
        409,
        "conflict",
      );
      const other = app.data.matches.find((m) => m.tournamentId === live.id && m.status === "scheduled" && m.teamAId === null);
      const noOpponent = await app.call(forfeit, `/api/admin/matches/${other?.id}/forfeit`, { method: "POST", params: { id: other?.id ?? "" }, cookie: organizerCookie, body: { teamId: "ghost" } });
      expectFailure(noOpponent, 409, "conflict");
      expectFailure(await app.call(forfeit, "/api/admin/matches/nope/forfeit", { method: "POST", params: { id: "nope" }, cookie: organizerCookie, body: { teamId: "x" } }), 404, "not_found");
      const settledMatch = app.data.matches.find((m) => m.tournamentId === app.tournament(SLUGS.settled).id);
      expectFailure(
        await app.call(forfeit, `/api/admin/matches/${settledMatch?.id}/forfeit`, { method: "POST", params: { id: settledMatch?.id ?? "" }, cookie: organizerCookie, body: { teamId: settledMatch?.teamAId } }),
        409,
        "conflict",
      );
      // The bracket matches with no pool are the only ones with a next seat.
      expect(app.conn.db.select().from(matches).where(and(eq(matches.tournamentId, live.id), isNull(matches.poolId))).all()).toHaveLength(15);
    });
  });
});
