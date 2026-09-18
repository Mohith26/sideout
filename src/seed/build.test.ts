import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { NewMatch, NewScoreSubmission, NewSetRow } from "@/db/schema";
import { judgeMatch, judgeSet, setTarget, type SetScore } from "@/domain/scoreline";
import { draw, seedBracketSlots, selectAdvancing } from "@/domain/draw";
import { computeStandings, type StandingsMatch } from "@/domain/standings";
import { isUuidV7 } from "@/lib/uuid";
import { buildSeed, DEFAULT_RNG_SEED, SEED_DRAWS, seedDrawOptions, SLUGS, startOfTodayIn, VENUE_TIMEZONE, type SeedDataset } from "@/seed/build";

// Fixed anchor: a Saturday midnight in Los Angeles. Tests never depend on today.
const ANCHOR = Date.UTC(2026, 8, 19, 7, 0, 0); // 2026-09-19 00:00 PDT
const data = buildSeed({ anchorMs: ANCHOR, rngSeed: DEFAULT_RNG_SEED });

function tournament(slug: string) {
  const t = data.tournaments.find((x) => x.slug === slug);
  if (!t) throw new Error(`missing tournament ${slug}`);
  return t;
}
const live = tournament(SLUGS.live);
const upcoming = tournament(SLUGS.upcoming);
const settled = tournament(SLUGS.settled);

const matchesOf = (tournamentId: string) => data.matches.filter((m) => m.tournamentId === tournamentId);
const setsOf = (matchId: string) => data.sets.filter((s) => s.matchId === matchId).sort((a, b) => a.setNumber - b.setNumber);
const teamsOf = (tournamentId: string) => data.teams.filter((t) => t.tournamentId === tournamentId);
const succeededTotal = (tournamentId: string) =>
  data.donations.filter((d) => d.tournamentId === tournamentId && d.status === "succeeded").reduce((s, d) => s + d.amountCents, 0);

function toStandingsMatch(m: NewMatch, sets: NewSetRow[]): StandingsMatch {
  if (!m.teamAId || !m.teamBId || !m.winnerTeamId) throw new Error("pool match incomplete");
  return { teamAId: m.teamAId, teamBId: m.teamBId, winnerTeamId: m.winnerTeamId, sets };
}

// What a captain typed, stored verbatim: their own points first.
const submittedPayload = z.object({
  perspective: z.enum(["a", "b"]),
  sets: z.array(z.object({ setNumber: z.number(), usPoints: z.number(), themPoints: z.number() })),
});

/** A stored submission re-expressed from team A's side, as consensus would read it. */
function submittedSets(sub: NewScoreSubmission): SetScore[] {
  const payload = submittedPayload.parse(JSON.parse(sub.payloadJson));
  return payload.sets.map((s) => ({
    setNumber: s.setNumber,
    teamAPoints: payload.perspective === "a" ? s.usPoints : s.themPoints,
    teamBPoints: payload.perspective === "a" ? s.themPoints : s.usPoints,
  }));
}

describe("seed dataset (spec §13)", () => {
  it("is deterministic and every id is a unique UUID v7", () => {
    const again = buildSeed({ anchorMs: ANCHOR, rngSeed: DEFAULT_RNG_SEED });
    expect(again).toEqual(data);

    const ids: string[] = [];
    for (const key of Object.keys(data) as Array<keyof SeedDataset>) {
      for (const row of data[key] as Array<{ id: string }>) ids.push(row.id);
    }
    expect(ids.every(isUuidV7)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has one charity with a real mission sentence, three events in the three required states", () => {
    expect(data.charities).toHaveLength(1);
    expect(data.charities[0]?.missionShort.split(" ").length).toBeGreaterThan(12);
    expect(data.tournaments.map((t) => t.status).sort()).toEqual(["live", "registration_open", "settled"]);
    expect(live.name).toBe("Sandbar Classic");
    for (const t of data.tournaments) {
      expect(t.currency).toBe("USD");
      expect(t.prizeKind).toBe("free_to_play_rewards");
      expect(t.lucraExternalId).toMatch(new RegExp(`^sideout-${t.slug}-[0-9a-f]{8}$`));
      expect(t.lucraGameId).toBe("SIDEOUT_BEACH_2V2");
      expect(t.lucraLocationId).toBeNull();
      expect(t.venueTimezone).toBe(VENUE_TIMEZONE);
    }
    expect(data.donations.every((d) => d.provider === "stub" && d.currency === "USD")).toBe(true);
  });

  it("has 48 players with the required verification states, each linked with an opaque external id, plus two organizers", () => {
    const players = data.users.filter((u) => u.role === "player");
    const organizers = data.users.filter((u) => u.role === "organizer");
    expect(players).toHaveLength(48);
    expect(organizers).toHaveLength(2);
    expect(data.users).toHaveLength(50);
    expect(data.lucraLinks).toHaveLength(48);
    // Organizers run events and never play: no team membership, no Lucra link.
    for (const o of organizers) {
      expect(data.lucraLinks.some((l) => l.userId === o.id)).toBe(false);
      expect(data.teamMembers.some((m) => m.userId === o.id)).toBe(false);
      expect(o.phoneE164).toMatch(/^\+1555/);
    }
    const states = data.lucraLinks.map((l) => l.verificationState);
    expect(states.filter((s) => s === "not_allowed")).toHaveLength(1);
    expect(states.filter((s) => s === "demographics_missing")).toHaveLength(1);
    expect(states.filter((s) => s === "unverified").length).toBeGreaterThan(0);
    expect(states.filter((s) => s === "verified").length).toBeGreaterThan(30);
    for (const link of data.lucraLinks) {
      const user = data.users.find((u) => u.id === link.userId);
      expect(user).toBeDefined();
      expect(link.externalId).toMatch(/^sideout-user-[0-9a-f]{8}$/);
      expect(link.externalId).not.toContain(user?.email ?? "@");
      expect(link.externalId).not.toContain(user?.phoneE164 ?? "+");
      if (link.verificationState === "unverified") expect(link.lucraUserId).toBeNull();
      else expect(link.lucraUserId).toMatch(/^lu_/);
    }
    expect(new Set(data.users.map((u) => u.phoneE164)).size).toBe(50);
  });

  it("gives every non-forming team exactly two members: one captain, one player, distinct users", () => {
    for (const team of data.teams.filter((t) => t.status !== "forming")) {
      const members = data.teamMembers.filter((m) => m.teamId === team.id);
      expect(members).toHaveLength(2);
      expect(members.map((m) => m.role).sort()).toEqual(["captain", "player"]);
      expect(new Set(members.map((m) => m.userId)).size).toBe(2);
    }
    // Team names follow from their members' surnames, never typed.
    for (const team of data.teams.filter((t) => t.status !== "forming")) {
      const members = data.teamMembers.filter((m) => m.teamId === team.id);
      for (const m of members) {
        const user = data.users.find((u) => u.id === m.userId);
        const surname = user?.displayName.split(" ").slice(1).join(" ") ?? "";
        expect(team.name).toContain(surname);
      }
    }
  });

  describe("Sandbar Classic (live)", () => {
    const teams = teamsOf(live.id);
    const matches = matchesOf(live.id);
    const poolMatches = matches.filter((m) => m.poolId !== null);
    const bracket = matches.filter((m) => m.poolId === null).sort((a, b) => (a.bracketPosition ?? 0) - (b.bracketPosition ?? 0));
    const pools = data.pools.filter((p) => p.tournamentId === live.id);

    it("has 24 checked-in teams in 6 pools of 4 with pool play complete", () => {
      expect(teams).toHaveLength(24);
      expect(teams.every((t) => t.status === "checked_in")).toBe(true);
      expect(pools).toHaveLength(6);
      for (const pool of pools) {
        expect(data.poolTeams.filter((pt) => pt.poolId === pool.id)).toHaveLength(4);
        const inPool = poolMatches.filter((m) => m.poolId === pool.id);
        expect(inPool).toHaveLength(6);
        expect(inPool.every((m) => m.status === "final" && m.bestOf === "1")).toBe(true);
      }
      expect(poolMatches).toHaveLength(36);
    });

    it("contains a bye, a disputed match, an awaiting-scores match, a live match and at least two finals in the bracket", () => {
      const count = (status: string) => bracket.filter((m) => m.status === status).length;
      expect(bracket).toHaveLength(15);
      expect(count("bye")).toBe(1);
      expect(count("disputed")).toBe(1);
      expect(count("awaiting_scores")).toBe(1);
      expect(count("in_progress")).toBe(1);
      expect(count("final")).toBeGreaterThanOrEqual(2);
      expect(count("scheduled")).toBe(2);
      const bye = bracket.find((m) => m.status === "bye");
      expect(bye?.teamBId).toBeNull();
      expect(bye?.winnerTeamId).toBe(bye?.teamAId);
    });

    it("seeds the bracket from pool results through the engine's advancement rule, top seed drawing the bye", () => {
      const poolStandings = pools.map((pool) => {
        const ids = data.poolTeams.filter((pt) => pt.poolId === pool.id).map((pt) => pt.teamId);
        return { rows: computeStandings(ids, poolMatches.filter((m) => m.poolId === pool.id).map((m) => toStandingsMatch(m, setsOf(m.id)))) };
      });
      const expected = selectAdvancing(poolStandings, SEED_DRAWS.live.advance);
      expect(expected).toHaveLength(15);

      const seeded = teams.filter((t) => t.seed !== null).sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
      expect(seeded.map((t) => t.id)).toEqual(expected);
      expect(seeded.map((t) => t.seed)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
      expect(teams.filter((t) => t.seed === null)).toHaveLength(9);

      const seedOf = (teamId: string | null | undefined) => teams.find((t) => t.id === teamId)?.seed ?? null;
      const firstRound = bracket.filter((m) => m.round === 1);
      expect(firstRound.map((m) => [seedOf(m.teamAId), seedOf(m.teamBId)])).toEqual([
        [1, null],
        [8, 9],
        [4, 13],
        [5, 12],
        [2, 15],
        [7, 10],
        [3, 14],
        [6, 11],
      ]);

      // Round 1 is exactly what seeding an empty skeleton with those seeds gives.
      const skeleton = bracket.map((m) => ({
        key: m.id,
        round: m.round,
        bracketPosition: m.bracketPosition ?? 0,
        teamAId: null,
        teamBId: null,
        status: "scheduled",
        nextMatchKey: m.nextMatchId ?? null,
        nextMatchSlot: m.nextMatchSlot ?? null,
      }));
      for (const patch of seedBracketSlots(skeleton, expected)) {
        const row = bracket.find((m) => m.id === patch.key);
        if (row?.round === 1) {
          expect([row.teamAId, row.teamBId, row.status === "bye"]).toEqual([patch.teamAId, patch.teamBId, patch.status === "bye"]);
        }
      }
    });

    it("has pools and a bracket skeleton identical to what the draw engine produces for the same inputs", () => {
      const plan = draw(
        seedDrawOptions(
          live,
          teams.map((t) => ({ id: t.id, seed: null })),
          SEED_DRAWS.live,
        ),
      );
      expect(plan.bracket).toEqual({ size: 16, rounds: 4, advancing: 15 });

      // Pools: same labels, courts and team composition in order.
      expect(pools.map((p) => [p.label, p.courtLabel])).toEqual(plan.pools.map((p) => [p.label, p.courtLabel]));
      const seededPools = pools.map((p) => data.poolTeams.filter((pt) => pt.poolId === p.id).map((pt) => pt.teamId));
      expect(seededPools).toEqual(plan.pools.map((p) => p.teamIds));

      // Pool matches: same pairings, rounds, courts and times.
      const key = (m: { round: number; courtLabel?: string | null | undefined; scheduledAt?: number | null | undefined; teamAId?: string | null | undefined; teamBId?: string | null | undefined }) =>
        `${m.round}|${m.courtLabel}|${m.scheduledAt}|${m.teamAId}|${m.teamBId}`;
      const poolLabelOf = (poolId: string | null | undefined) => pools.find((p) => p.id === poolId)?.label;
      const planPoolLabel = (poolKey: string | null) => plan.pools.find((p) => p.key === poolKey)?.label;
      expect(poolMatches.map((m) => `${poolLabelOf(m.poolId)}|${key(m)}`).sort()).toEqual(
        plan.matches
          .filter((m) => m.poolKey !== null)
          .map((m) => `${planPoolLabel(m.poolKey)}|${key(m)}`)
          .sort(),
      );

      // Bracket: same positions, rounds, courts, times and next links.
      const planBracket = plan.matches.filter((m) => m.bracketPosition !== null).sort((x, y) => (x.bracketPosition ?? 0) - (y.bracketPosition ?? 0));
      const positionOf = (id: string | null | undefined) => bracket.find((m) => m.id === id)?.bracketPosition ?? null;
      expect(bracket.map((m) => [m.bracketPosition, m.round, m.courtLabel, m.scheduledAt, positionOf(m.nextMatchId), m.nextMatchSlot, m.bestOf])).toEqual(
        planBracket.map((m) => [m.bracketPosition, m.round, m.courtLabel, m.scheduledAt, Number(m.nextMatchKey?.split(":")[1]) || null, m.nextMatchSlot, m.bestOf]),
      );
      expect(data.auditLog.filter((a) => a.subjectId === live.id && a.action === "tournament.draw_generated")).toHaveLength(1);
      expect(data.auditLog.filter((a) => a.subjectId === live.id && a.action === "tournament.bracket_seeded")).toHaveLength(1);
    });

    it("advances winners into the correct next-match slot", () => {
      for (const m of bracket) {
        if (!m.nextMatchId) continue;
        const next = bracket.find((n) => n.id === m.nextMatchId);
        expect(next).toBeDefined();
        if (m.winnerTeamId) {
          const slot = m.nextMatchSlot === "a" ? next?.teamAId : next?.teamBId;
          expect(slot).toBe(m.winnerTeamId);
        }
      }
      const finalMatch = bracket.find((m) => m.round === 4);
      expect(finalMatch?.nextMatchId).toBeNull();
      expect(finalMatch?.status).toBe("scheduled");
    });

    it("disputed match: two captains from different teams, differing hashes, consensus disputed", () => {
      const disputed = bracket.find((m) => m.status === "disputed");
      expect(disputed).toBeDefined();
      const subs = data.scoreSubmissions.filter((s) => s.matchId === disputed?.id);
      expect(subs).toHaveLength(2);
      expect(new Set(subs.map((s) => s.submittedForTeamId)).size).toBe(2);
      expect(new Set(subs.map((s) => s.payloadHash)).size).toBe(2);
      expect(subs.every((s) => s.submittedForTeamId === disputed?.teamAId || s.submittedForTeamId === disputed?.teamBId)).toBe(true);
      const consensus = data.matchConsensus.find((c) => c.matchId === disputed?.id);
      expect(consensus?.state).toBe("disputed");
      expect(consensus?.disputedReason).toMatch(/Set 3 differs/);
      expect(consensus?.idempotencyKey).toBeNull();
      expect(setsOf(disputed?.id ?? "")).toHaveLength(0);
      for (const sub of subs) expect(judgeMatch(submittedSets(sub), "3")).toMatchObject({ legal: true });
    });

    it("both disputed submissions are legal scorelines whatever the rng seed", () => {
      // Seeds 61, 71, 72, 86 and 90 push the deciding set to deuce.
      for (let rngSeed = 1; rngSeed <= 100; rngSeed += 1) {
        const dataset = buildSeed({ anchorMs: ANCHOR, rngSeed });
        const disputed = dataset.matches.find((m) => m.status === "disputed");
        const subs = dataset.scoreSubmissions.filter((s) => s.matchId === disputed?.id);
        expect(subs).toHaveLength(2);
        expect(new Set(subs.map((s) => s.payloadHash)).size).toBe(2);
        for (const sub of subs) {
          const verdict = judgeMatch(submittedSets(sub), "3");
          expect(verdict.legal, `rngSeed ${rngSeed}: ${verdict.legal ? "" : verdict.reason}`).toBe(true);
        }
      }
    });

    it("awaiting-scores match has exactly one submission; live match has provisional sets only", () => {
      const awaiting = bracket.find((m) => m.status === "awaiting_scores");
      expect(data.scoreSubmissions.filter((s) => s.matchId === awaiting?.id)).toHaveLength(1);
      expect(data.matchConsensus.find((c) => c.matchId === awaiting?.id)?.state).toBe("awaiting_second");

      const liveMatch = bracket.find((m) => m.status === "in_progress");
      const liveSets = setsOf(liveMatch?.id ?? "");
      expect(liveSets.length).toBeGreaterThanOrEqual(1);
      expect(liveSets.every((s) => s.agreed === false)).toBe(true);
      const first = liveSets[0];
      expect(first && judgeSet(first.teamAPoints, first.teamBPoints, 21).legal).toBe(true);
      expect(data.matchConsensus.find((c) => c.matchId === liveMatch?.id)?.state).toBe("awaiting_first");
    });

    it("raises a partially-met goal from succeeded donations only", () => {
      const raised = succeededTotal(live.id);
      expect(raised).toBeGreaterThan(0);
      expect(raised).toBeLessThan(live.fundraisingGoalCents);
      expect(raised / live.fundraisingGoalCents).toBeGreaterThan(0.5);
      const entries = data.donations.filter((d) => d.tournamentId === live.id && d.teamId !== null);
      expect(entries).toHaveLength(24);
      expect(entries.every((d) => d.amountCents === live.entryDonationCents && d.status === "succeeded")).toBe(true);
      const statuses = new Set(data.donations.filter((d) => d.tournamentId === live.id).map((d) => d.status));
      expect([...statuses].sort()).toEqual(["failed", "pending", "refunded", "succeeded"]);
    });

    it("has three sponsors across the three tiers", () => {
      const sponsors = data.sponsors.filter((s) => s.tournamentId === live.id);
      expect(sponsors).toHaveLength(3);
      expect(sponsors.map((s) => s.tier).sort()).toEqual(["court", "presenting", "prize"]);
    });
  });

  describe("every completed match", () => {
    const finals = data.matches.filter((m) => m.status === "final");

    it("has a legal beach volleyball scoreline whose winner follows from the sets", () => {
      expect(finals.length).toBeGreaterThan(40);
      for (const m of finals) {
        const sets = setsOf(m.id);
        expect(sets.length).toBeGreaterThan(0);
        expect(sets.every((s) => s.agreed)).toBe(true);
        const verdict = judgeMatch(sets, m.bestOf);
        expect(verdict.legal, `match ${m.id}: ${verdict.legal ? "" : verdict.reason}`).toBe(true);
        if (!verdict.legal) continue;
        expect(m.winnerTeamId).toBe(verdict.winner === "a" ? m.teamAId : m.teamBId);
        for (const s of sets) expect(judgeSet(s.teamAPoints, s.teamBPoints, setTarget(s.setNumber, m.bestOf)).legal).toBe(true);
      }
    });

    it("has two agreeing submissions from different teams and an agreed consensus with an idempotency key", () => {
      for (const m of finals) {
        const subs = data.scoreSubmissions.filter((s) => s.matchId === m.id);
        expect(subs).toHaveLength(2);
        expect(new Set(subs.map((s) => s.submittedForTeamId)).size).toBe(2);
        expect(new Set(subs.map((s) => s.payloadHash)).size).toBe(1);
        const consensus = data.matchConsensus.find((c) => c.matchId === m.id);
        expect(consensus?.state).toBe("agreed");
        expect(consensus?.agreedPayloadHash).toBe(subs[0]?.payloadHash);
        expect(consensus?.idempotencyKey).toMatch(/^sideout-consensus-/);
      }
      const keys = data.matchConsensus.map((c) => c.idempotencyKey).filter(Boolean);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("writes an audit trail for finalization", () => {
      for (const m of finals) {
        expect(data.auditLog.some((a) => a.subjectId === m.id && a.action === "match.finalized")).toBe(true);
      }
    });
  });

  describe("Pier 9 Open (registration open)", () => {
    it("is 40% full counting only registered teams, with one withdrawn and one still forming", () => {
      const teams = teamsOf(upcoming.id);
      const active = teams.filter((t) => t.status === "registered" || t.status === "checked_in");
      expect(active.length / upcoming.maxTeams).toBeCloseTo(0.4, 5);
      expect(teams.filter((t) => t.status === "withdrawn")).toHaveLength(1);
      const forming = teams.filter((t) => t.status === "forming");
      expect(forming).toHaveLength(1);
      const formingMembers = data.teamMembers.filter((m) => m.teamId === forming[0]?.id);
      expect(formingMembers.map((m) => m.role)).toEqual(["captain"]);
      const invites = data.teamInvites.filter((i) => i.teamId === forming[0]?.id);
      expect(invites).toHaveLength(1);
      expect(invites[0]?.status).toBe("pending");
      // The invitee is a real seeded player with no team in this event yet.
      const invitee = data.users.find((u) => u.phoneE164 === invites[0]?.phoneE164);
      expect(invitee?.role).toBe("player");
      const inviteeTeams = data.teamMembers.filter((m) => m.userId === invitee?.id).map((m) => data.teams.find((t) => t.id === m.teamId));
      expect(inviteeTeams.some((t) => t?.tournamentId === upcoming.id)).toBe(false);
      expect(data.donations.some((d) => d.teamId === forming[0]?.id)).toBe(false);
      expect(matchesOf(upcoming.id)).toHaveLength(0);
      expect(upcoming.startsAt).toBeGreaterThan(ANCHOR);
      const withdrawn = teams.find((t) => t.status === "withdrawn");
      expect(data.donations.find((d) => d.teamId === withdrawn?.id)?.status).toBe("refunded");
      expect(succeededTotal(upcoming.id)).toBeLessThan(upcoming.fundraisingGoalCents * 0.3);
    });
  });

  describe("Low Tide Open (settled)", () => {
    const bracket = matchesOf(settled.id).filter((m) => m.poolId === null);

    it("met its goal and finished its bracket, drawn by the engine with no byes", () => {
      expect(succeededTotal(settled.id)).toBeGreaterThanOrEqual(settled.fundraisingGoalCents);
      expect(bracket).toHaveLength(7);
      expect(bracket.every((m) => m.status === "final")).toBe(true);
      const plan = draw(
        seedDrawOptions(
          settled,
          teamsOf(settled.id).map((t) => ({ id: t.id, seed: null })),
          SEED_DRAWS.settled,
        ),
      );
      expect(plan.bracket).toEqual({ size: 8, rounds: 3, advancing: 8 });
      expect(data.pools.filter((p) => p.tournamentId === settled.id).map((p) => p.label)).toEqual(plan.pools.map((p) => p.label));
      expect(teamsOf(settled.id).filter((t) => t.seed !== null)).toHaveLength(8);
    });

    it("awards rewards that follow from the bracket and are funded by sponsors, not donations", () => {
      const rewards = data.rewards.filter((r) => r.tournamentId === settled.id);
      expect(rewards).toHaveLength(4);
      expect(rewards.every((r) => r.status === "awarded" || r.status === "claimed")).toBe(true);
      const finalMatch = bracket.find((m) => m.round === 3);
      const champion = rewards.find((r) => r.placement === 1);
      expect(champion?.teamId).toBe(finalMatch?.winnerTeamId);
      const runnerUp = rewards.find((r) => r.placement === 2);
      expect([finalMatch?.teamAId, finalMatch?.teamBId]).toContain(runnerUp?.teamId);
      expect(runnerUp?.teamId).not.toBe(finalMatch?.winnerTeamId);
      const thirds = rewards.filter((r) => r.placement === 3);
      expect(thirds).toHaveLength(2);
      expect(thirds.every((r) => r.kind === "sponsor_item" && r.amountCents === null)).toBe(true);

      const prizeTotal = rewards.reduce((s, r) => s + (r.amountCents ?? 0), 0);
      const sponsorTotal = data.sponsors.filter((s) => s.tournamentId === settled.id).reduce((s, x) => s + x.prizeContributionCents, 0);
      expect(prizeTotal).toBeGreaterThan(0);
      expect(prizeTotal).toBeLessThanOrEqual(sponsorTotal);
      // Every reward row carries a currency when it carries an amount.
      expect(rewards.every((r) => r.amountCents === null || r.currency === "USD")).toBe(true);
    });
  });

  it("anchors the flagship event to venue-local midnight", () => {
    // 2026-09-19 12:00 UTC is 05:00 PDT; local midnight is 07:00 UTC.
    expect(startOfTodayIn("America/Los_Angeles", Date.UTC(2026, 8, 19, 12))).toBe(Date.UTC(2026, 8, 19, 7));
    // Just before local midnight is still the previous local day.
    expect(startOfTodayIn("America/Los_Angeles", Date.UTC(2026, 8, 19, 6, 59))).toBe(Date.UTC(2026, 8, 18, 7));
    expect(live.startsAt).toBe(ANCHOR + 8 * 3_600_000);
  });
});
