import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConsensusView, listDisputes } from "@/db/queries/consensus";
import { matchConsensus, matches, scoreSubmissions, sets, teamMembers, teams, tournaments, type Match } from "@/db/schema";
import { assertMayWriteToLucra, ConsensusError, LucraWriteRefused, type SubmittedSet } from "@/domain/consensus";
import type { SetScore } from "@/domain/scoreline";
import { hashScoreline } from "@/domain/scoreline-hash";
import { fixedClock } from "@/lib/clock";
import { isUuidV7, uuidv7 } from "@/lib/uuid";
import { SEED_DRAWS, SLUGS } from "@/seed/build";
import { resolveDispute, submitScoreline } from "@/server/consensus";
import { runDraw } from "@/server/draw";
import { forfeitMatch } from "@/server/matches";
import { createTournament, updateTournament } from "@/server/tournaments";
import { createTestApp, type TestApp } from "@/test/routes";

/**
 * The consensus service against a migrated, seeded temporary database: legal
 * and illegal scorelines, one team never satisfying both sides, agreement,
 * disagreement, organizer resolution, the idempotency key, and bracket
 * advancement — every rule of spec §10 as the rows record it.
 */

const HOUR = 3_600_000;

// Match-oriented results used throughout.
const A_WINS_3: SetScore[] = [
  { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
  { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
  { setNumber: 3, teamAPoints: 15, teamBPoints: 12 },
];
const B_WINS_3: SetScore[] = [
  { setNumber: 1, teamAPoints: 18, teamBPoints: 21 },
  { setNumber: 2, teamAPoints: 21, teamBPoints: 17 },
  { setNumber: 3, teamAPoints: 11, teamBPoints: 15 },
];

/** What a member of `side` would type for a match-oriented result. */
function typed(setsForA: readonly SetScore[], side: "a" | "b"): SubmittedSet[] {
  return setsForA.map((s) => ({ setNumber: s.setNumber, usPoints: side === "a" ? s.teamAPoints : s.teamBPoints, themPoints: side === "a" ? s.teamBPoints : s.teamAPoints }));
}

describe("consensus service (spec §10)", () => {
  let app: TestApp;
  const clock = fixedClock(0);
  let live: { id: string };

  beforeEach(() => {
    app = createTestApp();
    // Past every seeded timestamp of the live event, so new rows sort after seeded ones.
    clock.set(app.anchorMs + 23 * HOUR);
    live = app.tournament(SLUGS.live);
  });
  afterEach(() => app.close());

  const db = () => app.conn.db;
  const bracketMatch = (position: number): Match => {
    const m = db()
      .select()
      .from(matches)
      .where(and(eq(matches.tournamentId, live.id), eq(matches.bracketPosition, position)))
      .get();
    if (!m) throw new Error(`no bracket match at position ${position}`);
    return m;
  };
  const reload = (id: string): Match => {
    const m = db().select().from(matches).where(eq(matches.id, id)).get();
    if (!m) throw new Error("match vanished");
    return m;
  };
  const membersOf = (teamId: string | null) =>
    db()
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId ?? ""))
      .all()
      .map((r) => r.userId);
  const captainOf = (teamId: string | null) => {
    const [u] = membersOf(teamId);
    if (!u) throw new Error("team has no members");
    return u;
  };
  const submit = (matchId: string, userId: string, sets: SubmittedSet[]) => submitScoreline({ matchId, userId, scoreline: { sets } }, clock);
  const liveRows = (matchId: string) =>
    db()
      .select()
      .from(scoreSubmissions)
      .where(and(eq(scoreSubmissions.matchId, matchId), isNull(scoreSubmissions.supersededById)))
      .orderBy(asc(scoreSubmissions.createdAt))
      .all();
  const consensusRow = (matchId: string) => db().select().from(matchConsensus).where(eq(matchConsensus.matchId, matchId)).get();
  const setRows = (matchId: string) => db().select().from(sets).where(eq(sets.matchId, matchId)).orderBy(asc(sets.setNumber)).all();

  describe("legality (spec §10.4)", () => {
    it("rejects an illegal scoreline with a specific message naming the set, storing nothing", () => {
      const m = bracketMatch(13); // in_progress semifinal, best of 3
      const user = captainOf(m.teamAId);
      const before = db().select().from(scoreSubmissions).where(eq(scoreSubmissions.matchId, m.id)).all().length;
      const attempt = () => submit(m.id, user, [{ setNumber: 1, usPoints: 21, themPoints: 20 }]);
      expect(attempt).toThrow(ConsensusError);
      try {
        attempt();
      } catch (err) {
        const e = err as ConsensusError;
        expect(e.code).toBe("illegal_scoreline");
        expect(e.message).toBe("Set 1: Sets are won by 2; 21–20 is not a finished set.");
        expect(e.detail).toMatchObject({ code: "illegal_scoreline", setNumber: 1, bestOf: "3" });
      }
      // A third set to 21 instead of 15, and a match decided before its last set.
      expect(() => submit(m.id, user, typed([A_WINS_3[0]!, A_WINS_3[1]!, { setNumber: 3, teamAPoints: 21, teamBPoints: 15 }], "a"))).toThrow(/Set 3: Past 15/);
      expect(() => submit(m.id, user, typed([A_WINS_3[0]!, { setNumber: 2, teamAPoints: 21, teamBPoints: 10 }, A_WINS_3[2]!], "a"))).toThrow(/already decided before set 3/);
      expect(db().select().from(scoreSubmissions).where(eq(scoreSubmissions.matchId, m.id)).all()).toHaveLength(before);
      expect(reload(m.id).status).toBe("in_progress");
      expect(consensusRow(m.id)?.state).toBe("awaiting_first");
    });

    it("judges legality against the match's best_of", () => {
      // Pool matches are best of 1 in the seed; a best-of-3 result is refused for one.
      const t = app.tournament(SLUGS.upcoming);
      expect(SEED_DRAWS.live.poolBestOf).toBe("1");
      const pool = db()
        .select()
        .from(matches)
        .where(and(eq(matches.tournamentId, live.id), isNotNull(matches.poolId)))
        .get();
      if (!pool) throw new Error("no pool match");
      expect(pool.bestOf).toBe("1");
      expect(t).toBeDefined();
      // Already final: the consensus refuses before legality; open it up to prove the best_of check.
      db().update(matches).set({ status: "in_progress" }).where(eq(matches.id, pool.id)).run();
      db().delete(matchConsensus).where(eq(matchConsensus.matchId, pool.id)).run();
      db().delete(scoreSubmissions).where(eq(scoreSubmissions.matchId, pool.id)).run();
      expect(() => submit(pool.id, captainOf(pool.teamAId), typed(A_WINS_3, "a"))).toThrow(/best-of-1 match has at most 1 set/);
    });
  });

  describe("who may submit (spec §10.2)", () => {
    it("refuses a user who is not on either team, an organizer included", () => {
      const m = bracketMatch(13);
      const outsider = app.data.users.find((u) => u.role === "player" && !membersOf(m.teamAId).includes(u.id) && !membersOf(m.teamBId).includes(u.id));
      if (!outsider) throw new Error("no outsider");
      for (const userId of [outsider.id, app.organizer().id]) {
        try {
          submit(m.id, userId, typed(A_WINS_3, "a"));
          throw new Error("expected a refusal");
        } catch (err) {
          expect((err as ConsensusError).code).toBe("not_on_team");
        }
      }
      expect(liveRows(m.id)).toHaveLength(0);
    });

    it("two submissions from one team never satisfy consensus: the second supersedes the first", () => {
      const m = bracketMatch(13);
      const [captain, partner] = membersOf(m.teamAId);
      if (!captain || !partner) throw new Error("team A needs two members");

      const first = submit(m.id, captain, typed(A_WINS_3, "a"));
      expect(first.outcome).toBe("awaiting_second");
      expect(first.replaced).toBe(false);
      expect(reload(m.id).status).toBe("awaiting_scores");
      expect(consensusRow(m.id)?.state).toBe("awaiting_second");

      // The partner submits a different result for the same team: still one side, replaced, never agreed or disputed.
      const second = submit(m.id, partner, typed(B_WINS_3, "a"));
      expect(second.outcome).toBe("awaiting_second");
      expect(second.replaced).toBe(true);
      expect(consensusRow(m.id)?.state).toBe("awaiting_second");
      expect(reload(m.id).status).toBe("awaiting_scores");

      // And the same captain again, matching the partner's hash: still nothing.
      const third = submit(m.id, captain, typed(B_WINS_3, "a"));
      expect(third.outcome).toBe("awaiting_second");
      expect(consensusRow(m.id)?.state).toBe("awaiting_second");

      const all = db().select().from(scoreSubmissions).where(eq(scoreSubmissions.matchId, m.id)).orderBy(asc(scoreSubmissions.createdAt)).all();
      expect(all).toHaveLength(3);
      expect(all[0]?.supersededById).toBe(all[1]?.id);
      expect(all[1]?.supersededById).toBe(all[2]?.id);
      expect(all[2]?.supersededById).toBeNull();
      expect(all.every((s) => s.submittedForTeamId === m.teamAId)).toBe(true);
      expect(liveRows(m.id)).toHaveLength(1);
      expect(app.audits(m.id, "score.superseded")).toHaveLength(2);
      expect(app.audits(m.id, "score.submitted")).toHaveLength(3);
    });
  });

  describe("agreement (spec §10.1, §10.3)", () => {
    it("two teams, identical hash from either side: agreed, final, sets written, key minted, winner advanced", () => {
      const m = bracketMatch(12); // awaiting_scores quarterfinal: team A already submitted in the seed
      const seeded = liveRows(m.id);
      expect(seeded).toHaveLength(1);
      expect(seeded[0]?.submittedForTeamId).toBe(m.teamAId);
      const aSets = JSON.parse(seeded[0]?.payloadJson ?? "").sets as SubmittedSet[];
      const asA: SetScore[] = aSets.map((s) => ({ setNumber: s.setNumber, teamAPoints: s.usPoints, teamBPoints: s.themPoints }));

      const before = consensusRow(m.id);
      expect(before?.state).toBe("awaiting_second");
      expect(before?.idempotencyKey).toBeNull();

      const captainB = captainOf(m.teamBId);
      const result = submit(m.id, captainB, typed(asA, "b"));
      expect(result.outcome).toBe("agreed");
      expect(result.consensus.state).toBe("agreed");

      const after = reload(m.id);
      const verdictWinner = asA.filter((s) => s.teamAPoints > s.teamBPoints).length >= 2 ? m.teamAId : m.teamBId;
      expect(after.status).toBe("final");
      expect(after.winnerTeamId).toBe(verdictWinner);
      expect(after.finalizedAt).toBe(clock.now());

      const row = consensusRow(m.id);
      expect(row?.state).toBe("agreed");
      expect(row?.agreedPayloadHash).toBe(hashScoreline({ matchId: m.id, sets: asA }, "a"));
      expect(JSON.parse(row?.agreedPayloadJson ?? "")).toEqual({ matchId: m.id, sets: asA });
      expect(row?.idempotencyKey).toBeTruthy();
      expect(isUuidV7(row?.idempotencyKey ?? "")).toBe(true);
      expect(row?.resolvedByUserId).toBeNull();

      const written = setRows(m.id);
      expect(written.map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints }))).toEqual(asA);
      expect(written.every((s) => s.agreed)).toBe(true);

      // The winner moved into the next bracket slot.
      const next = reload(m.nextMatchId ?? "");
      expect(m.nextMatchSlot === "a" ? next.teamAId : next.teamBId).toBe(verdictWinner);
      expect(app.audits(next.id, "match.slot_filled")).toHaveLength(1);

      // Audit: the consensus transition by the player, the match to final by system.
      const transitions = app.audits(row?.id ?? "", "consensus.state_changed");
      expect(transitions.map((a) => JSON.parse(a.detailJson ?? "{}").to)).toEqual(["awaiting_second", "agreed"]);
      expect(transitions[1]?.actorKind).toBe("player");
      expect(transitions[1]?.actorUserId).toBe(captainB);
      const finalized = app.audits(m.id, "match.status_changed").at(-1);
      expect(JSON.parse(finalized?.detailJson ?? "{}")).toMatchObject({ from: "awaiting_scores", to: "final", winnerTeamId: verdictWinner });
      expect(finalized?.actorKind).toBe("system");

      // Rule 5: this consensus may now be written to Lucra; nothing else in the event may.
      expect(() => assertMayWriteToLucra(row!)).not.toThrow();
      expect(() => assertMayWriteToLucra(consensusRow(bracketMatch(13).id)!)).toThrow(LucraWriteRefused);
    });

    it("mints the idempotency key exactly once: a replayed submission is refused and the key survives", () => {
      const m = bracketMatch(13);
      const captainA = captainOf(m.teamAId);
      const captainB = captainOf(m.teamBId);
      submit(m.id, captainA, typed(A_WINS_3, "a"));
      submit(m.id, captainB, typed(A_WINS_3, "b"));
      const key = consensusRow(m.id)?.idempotencyKey;
      expect(key).toBeTruthy();

      for (const userId of [captainA, captainB]) {
        try {
          submit(m.id, userId, typed(A_WINS_3, userId === captainA ? "a" : "b"));
          throw new Error("expected a refusal");
        } catch (err) {
          expect((err as ConsensusError).code).toBe("already_submitted_by_team");
        }
      }
      expect(consensusRow(m.id)?.idempotencyKey).toBe(key);
      expect(liveRows(m.id)).toHaveLength(2);
      const minted = app.audits(consensusRow(m.id)?.id ?? "", "consensus.state_changed").filter((a) => JSON.parse(a.detailJson ?? "{}").mintedKey === true);
      expect(minted).toHaveLength(1);
      // Every key in the database is unique and well-formed.
      const keys = db().select({ key: matchConsensus.idempotencyKey }).from(matchConsensus).all().map((r) => r.key).filter((k): k is string => k !== null);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.every(isUuidV7)).toBe(true);
    });

    it("replaces provisional (unagreed) sets with the agreed ones", () => {
      const m = bracketMatch(13);
      expect(setRows(m.id).length).toBeGreaterThan(0);
      expect(setRows(m.id).every((s) => !s.agreed)).toBe(true);
      submit(m.id, captainOf(m.teamAId), typed(B_WINS_3, "a"));
      submit(m.id, captainOf(m.teamBId), typed(B_WINS_3, "b"));
      const written = setRows(m.id);
      expect(written.map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints }))).toEqual(B_WINS_3);
      expect(written.every((s) => s.agreed)).toBe(true);
      expect(reload(m.id).winnerTeamId).toBe(m.teamBId);
    });
  });

  describe("disagreement and resolution (spec §10, acceptance #15)", () => {
    it("a different hash from the other team disputes the match with a neutral reason", () => {
      const m = bracketMatch(13);
      submit(m.id, captainOf(m.teamAId), typed(A_WINS_3, "a"));
      const other: SetScore[] = [A_WINS_3[0]!, A_WINS_3[1]!, { setNumber: 3, teamAPoints: 15, teamBPoints: 10 }];
      const result = submit(m.id, captainOf(m.teamBId), typed(other, "b"));
      expect(result.outcome).toBe("disputed");
      expect(result.consensus.differences).toEqual([{ setNumber: 3, a: A_WINS_3[2], b: other[2] }]);
      expect(reload(m.id).status).toBe("disputed");
      expect(reload(m.id).winnerTeamId).toBeNull();
      const row = consensusRow(m.id);
      expect(row?.state).toBe("disputed");
      expect(row?.disputedReason).toBe("Set 3 differs: 15–12 vs 15–10");
      expect(row?.idempotencyKey).toBeNull();
      expect(setRows(m.id).every((s) => !s.agreed)).toBe(true);
      expect(listDisputes(live.id).map((d) => d.match.id)).toContain(m.id);
      expect(() => assertMayWriteToLucra(row!)).toThrow(LucraWriteRefused);
      // Nobody on either team can submit again.
      try {
        submit(m.id, captainOf(m.teamAId), typed(other, "a"));
        throw new Error("expected a refusal");
      } catch (err) {
        expect((err as ConsensusError).code).toBe("already_submitted_by_team");
      }
    });

    it("an organizer resolves the seeded dispute; the resolution is attributed and advances the winner", () => {
      const m = bracketMatch(11);
      expect(m.status).toBe("disputed");
      const queueBefore = listDisputes(live.id);
      expect(queueBefore.map((d) => d.match.id)).toEqual([m.id]);
      expect(queueBefore[0]?.consensus.differences.map((d) => d.setNumber)).toEqual([3]);
      const organizer = app.organizer();

      expect(() => resolveDispute({ matchId: m.id, organizerUserId: organizer.id, sets: [A_WINS_3[0]!] }, clock)).toThrow(/Nobody has won 2 set/);

      const result = resolveDispute({ matchId: m.id, organizerUserId: organizer.id, sets: A_WINS_3 }, clock);
      expect(result.consensus.state).toBe("agreed");
      expect(result.consensus.resolvedBy).toEqual({ userId: organizer.id, displayName: organizer.displayName });

      const after = reload(m.id);
      expect(after.status).toBe("final");
      expect(after.winnerTeamId).toBe(m.teamAId);
      const row = consensusRow(m.id);
      expect(row?.resolvedByUserId).toBe(organizer.id);
      expect(row?.agreedPayloadHash).toBe(hashScoreline({ matchId: m.id, sets: A_WINS_3 }, "a"));
      expect(isUuidV7(row?.idempotencyKey ?? "")).toBe(true);
      expect(setRows(m.id).map((s) => [s.setNumber, s.teamAPoints, s.teamBPoints, s.agreed])).toEqual(A_WINS_3.map((s) => [s.setNumber, s.teamAPoints, s.teamBPoints, true]));

      // The organizer's scoreline is a submission row for no team; the two disputed rows stay untouched.
      const rows = db().select().from(scoreSubmissions).where(eq(scoreSubmissions.matchId, m.id)).orderBy(asc(scoreSubmissions.createdAt)).all();
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ submittedByUserId: organizer.id, submittedForTeamId: null, supersededById: null, payloadHash: row?.agreedPayloadHash });
      expect(rows.slice(0, 2).every((r) => r.supersededById === null)).toBe(true);

      // Attribution in audit_log.
      const transition = app.audits(row?.id ?? "", "consensus.state_changed").at(-1);
      expect(transition?.actorKind).toBe("organizer");
      expect(transition?.actorUserId).toBe(organizer.id);
      expect(JSON.parse(transition?.detailJson ?? "{}")).toMatchObject({ from: "disputed", to: "agreed", event: "organizer_resolution", resolvedByUserId: organizer.id });
      const submitted = app.audits(m.id, "score.submitted").at(-1);
      expect(submitted).toMatchObject({ actorKind: "organizer", actorUserId: organizer.id });

      const next = reload(m.nextMatchId ?? "");
      expect(m.nextMatchSlot === "a" ? next.teamAId : next.teamBId).toBe(m.teamAId);
      expect(listDisputes(live.id)).toEqual([]);
      expect(() => resolveDispute({ matchId: m.id, organizerUserId: organizer.id, sets: A_WINS_3 }, clock)).toThrow(/Only a disputed match/);
    });
  });

  describe("opening a match", () => {
    it("the first legal submission walks a scheduled match to awaiting_scores as the player, each step audited", () => {
      const scheduled = bracketMatch(15);
      expect(scheduled.status).toBe("scheduled");
      expect(scheduled.startedAt).toBeNull();
      const { teamAId, teamBId } = bracketMatch(13);
      db().update(matches).set({ teamAId, teamBId }).where(eq(matches.id, scheduled.id)).run();
      const captainA = captainOf(teamAId);

      // An illegal scoreline never takes the match off the schedule.
      expect(() => submit(scheduled.id, captainA, [{ setNumber: 1, usPoints: 21, themPoints: 20 }])).toThrow(ConsensusError);
      expect(reload(scheduled.id).status).toBe("scheduled");
      expect(app.audits(scheduled.id, "match.status_changed")).toHaveLength(0);

      const result = submit(scheduled.id, captainA, typed(A_WINS_3, "a"));
      expect(result.outcome).toBe("awaiting_second");
      const opened = reload(scheduled.id);
      expect(opened.status).toBe("awaiting_scores");
      expect(opened.startedAt).toBe(clock.now());
      const steps = app.audits(scheduled.id, "match.status_changed");
      expect(steps.map((a) => JSON.parse(a.detailJson ?? "{}"))).toEqual([
        { from: "scheduled", to: "in_progress", submissionId: result.submissionId },
        { from: "in_progress", to: "awaiting_scores", submissionId: result.submissionId },
      ]);
      expect(steps.every((a) => a.actorKind === "player" && a.actorUserId === captainA)).toBe(true);

      // The other team agrees from a match already waiting: no further opening step.
      expect(submit(scheduled.id, captainOf(teamBId), typed(A_WINS_3, "b")).outcome).toBe("agreed");
      expect(app.audits(scheduled.id, "match.status_changed").map((a) => JSON.parse(a.detailJson ?? "{}").to)).toEqual(["in_progress", "awaiting_scores", "final"]);
    });

    it("refuses a match that is already settled, and a match outside a live tournament", () => {
      const m = bracketMatch(13);
      db().update(matches).set({ status: "forfeited", winnerTeamId: m.teamBId, finalizedAt: clock.now() }).where(eq(matches.id, m.id)).run();
      try {
        submit(m.id, captainOf(m.teamAId), typed(A_WINS_3, "a"));
        throw new Error("expected a refusal");
      } catch (err) {
        expect((err as ConsensusError).code).toBe("match_not_open");
        expect((err as ConsensusError).detail).toMatchObject({ status: "forfeited" });
      }
      const settled = app.tournament(SLUGS.settled);
      const done = db()
        .select()
        .from(matches)
        .where(and(eq(matches.tournamentId, settled.id), isNull(matches.poolId)))
        .get();
      if (!done) throw new Error("settled has no bracket");
      try {
        submit(done.id, captainOf(done.teamAId), typed(A_WINS_3, "a"));
        throw new Error("expected a refusal");
      } catch (err) {
        expect((err as ConsensusError).code).toBe("match_not_open");
      }
    });
  });

  describe("bracket trigger", () => {
    const organizer = () => ({ kind: "organizer" as const, userId: app.organizer().id });
    const oneSet: SetScore[] = [{ setNumber: 1, teamAPoints: 21, teamBPoints: 15 }];

    /** A live pool_to_bracket event of four teams: six scheduled pool matches feeding one final. */
    function drawnPoolEvent() {
      const charityId = app.data.charities[0]?.id ?? "";
      const created = createTournament(
        {
          slug: "dawn-patrol-2027",
          name: "Dawn Patrol",
          beneficiaryId: charityId,
          venueName: "Zuma",
          venueCity: "Malibu",
          venueState: "CA",
          venueTimezone: "America/Los_Angeles",
          startsAt: clock.now() + HOUR,
          endsAt: clock.now() + 9 * HOUR,
          format: "pool_to_bracket",
          division: "open",
          maxTeams: 8,
          entryDonationCents: 0,
          fundraisingGoalCents: 0,
          currency: "USD",
          prizeKind: "free_to_play_rewards",
          lucraGameId: "SIDEOUT_BEACH_2V2",
        },
        organizer(),
        clock,
      ).tournament;
      const players = app.data.users.filter((u) => u.role === "player");
      for (let i = 0; i < 4; i += 1) {
        const id = uuidv7();
        db().insert(teams).values({ id, tournamentId: created.id, name: `Team ${i + 1}`, seed: null, status: "registered", createdAt: clock.now() + i }).run();
        db().insert(teamMembers).values({ id: uuidv7(), teamId: id, userId: players[i * 2]?.id ?? "", role: "captain" }).run();
        db().insert(teamMembers).values({ id: uuidv7(), teamId: id, userId: players[i * 2 + 1]?.id ?? "", role: "player" }).run();
      }
      updateTournament(created.id, { status: "registration_open" }, organizer(), clock);
      updateTournament(created.id, { status: "registration_closed" }, organizer(), clock);
      runDraw(
        created.id,
        { stage: "pools", courts: 1, poolSize: 4, advance: { perPool: 2, bestRemaining: 0 }, poolBestOf: "1", bracketBestOf: "3", poolMatchMinutes: 30, bracketMatchMinutes: 50, restMinutes: 10, rngSeed: 7 },
        organizer(),
        { preview: false, clock },
      );
      updateTournament(created.id, { status: "live" }, organizer(), clock);

      const poolMatches = db()
        .select()
        .from(matches)
        .where(and(eq(matches.tournamentId, created.id), isNotNull(matches.poolId)))
        .orderBy(asc(matches.scheduledAt))
        .all();
      expect(poolMatches).toHaveLength(6);
      expect(poolMatches.every((m) => m.status === "scheduled")).toBe(true);
      const finalRow = () =>
        db()
          .select()
          .from(matches)
          .where(and(eq(matches.tournamentId, created.id), isNull(matches.poolId)))
          .get();
      expect(finalRow()).toMatchObject({ teamAId: null, teamBId: null, status: "scheduled" });
      return { created, poolMatches, finalRow };
    }

    const agree = (pm: Match) => {
      submit(pm.id, captainOf(pm.teamAId), typed(oneSet, "a"));
      return submit(pm.id, captainOf(pm.teamBId), typed(oneSet, "b"));
    };

    function expectSeeded(created: { id: string }, finalRow: () => Match | undefined) {
      const final = finalRow();
      expect(final?.teamAId).not.toBeNull();
      expect(final?.teamBId).not.toBeNull();
      expect(app.audits(created.id, "tournament.bracket_seeded")).toHaveLength(1);
      expect(app.audits(created.id, "tournament.bracket_seeded")[0]?.actorKind).toBe("system");
      expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, created.id)).get()?.status).toBe("live");
    }

    it("seeds the bracket from the pools when the last pool match agrees", () => {
      const { created, poolMatches, finalRow } = drawnPoolEvent();
      let seededAt: string | null = null;
      for (const pm of poolMatches) {
        const r = agree(pm);
        expect(r.outcome).toBe("agreed");
        if (r.bracketSeeded) seededAt = pm.id;
      }
      expect(seededAt).toBe(poolMatches.at(-1)?.id);
      expectSeeded(created, finalRow);
    });

    it("seeds the bracket when an organizer forfeit settles the last pool match", () => {
      const { created, poolMatches, finalRow } = drawnPoolEvent();
      const [fifth, last] = poolMatches.slice(-2);
      if (!fifth || !last) throw new Error("expected six pool matches");
      for (const pm of poolMatches.slice(0, -2)) expect(agree(pm).bracketSeeded).toBe(false);

      // A forfeit with a pool match still to play leaves the bracket alone.
      const earlier = forfeitMatch(fifth.id, fifth.teamAId ?? "", organizer(), clock);
      expect(earlier.match.status).toBe("forfeited");
      expect(earlier.bracketSeeded).toBe(false);
      expect(finalRow()).toMatchObject({ teamAId: null, teamBId: null });

      const done = forfeitMatch(last.id, last.teamAId ?? "", organizer(), clock);
      expect(done.match.status).toBe("forfeited");
      expect(done.bracketSeeded).toBe(true);
      expectSeeded(created, finalRow);
    });
  });

  describe("read model", () => {
    it("keeps differences in match orientation when team B submits first", () => {
      const m = bracketMatch(13);
      const other: SetScore[] = [A_WINS_3[0]!, A_WINS_3[1]!, { setNumber: 3, teamAPoints: 15, teamBPoints: 10 }];
      submit(m.id, captainOf(m.teamBId), typed(other, "b"));
      const result = submit(m.id, captainOf(m.teamAId), typed(A_WINS_3, "a"));
      expect(result.outcome).toBe("disputed");
      expect(result.consensus.live.map((s) => s.teamId)).toEqual([m.teamBId, m.teamAId]);
      expect(result.consensus.differences).toEqual([{ setNumber: 3, a: A_WINS_3[2], b: other[2] }]);
      expect(consensusRow(m.id)?.disputedReason).toBe("Set 3 differs: 15–12 vs 15–10");
      expect(listDisputes(live.id).find((d) => d.match.id === m.id)?.consensus.differences).toEqual(result.consensus.differences);
    });

    it("shows the seeded disputed match with both live submissions and the differing set", () => {
      const m = bracketMatch(11);
      const view = getConsensusView(m.id);
      expect(view?.state).toBe("disputed");
      expect(view?.live.map((s) => s.teamId).sort()).toEqual([m.teamAId, m.teamBId].sort());
      expect(view?.differences.map((d) => d.setNumber)).toEqual([3]);
      expect(view?.history).toHaveLength(2);
      expect(view?.agreedSets).toBeNull();
    });

    it("an organizer forfeit settles the seeded dispute: the row is set aside, attributed, and nothing more is accepted", () => {
      const m = bracketMatch(11);
      const before = consensusRow(m.id);
      expect(before?.state).toBe("disputed");
      expect(before?.disputedReason).toMatch(/differs/);
      const organizerId = app.organizer().id;

      const done = forfeitMatch(m.id, m.teamAId ?? "", { kind: "organizer", userId: organizerId }, clock);
      expect(done.match.status).toBe("forfeited");
      expect(done.match.winnerTeamId).toBe(m.teamBId);
      expect(listDisputes(live.id)).toEqual([]);

      const after = consensusRow(m.id);
      expect(after).toMatchObject({ state: "disputed", disputedReason: "Settled by forfeit", resolvedByUserId: organizerId, idempotencyKey: null, updatedAt: clock.now() });
      expect(() => assertMayWriteToLucra(after!)).toThrow(LucraWriteRefused);
      const settled = app.audits(after?.id ?? "", "consensus.settled_by_forfeit");
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ actorKind: "organizer", actorUserId: organizerId });
      expect(JSON.parse(settled[0]?.detailJson ?? "{}")).toMatchObject({ matchId: m.id, forfeitedTeamId: m.teamAId, previousReason: before?.disputedReason });
      // The two readings stay as history; the view still reports the differing set.
      const view = getConsensusView(m.id);
      expect(view?.resolvedBy?.userId).toBe(organizerId);
      expect(view?.live).toHaveLength(2);
      expect(view?.differences.map((d) => d.setNumber)).toEqual([3]);

      // A further submission is refused because the match is settled, not because a dispute is open.
      for (const teamId of [m.teamAId, m.teamBId]) {
        try {
          submit(m.id, captainOf(teamId), typed(A_WINS_3, teamId === m.teamAId ? "a" : "b"));
          throw new Error("expected a refusal");
        } catch (err) {
          expect((err as ConsensusError).code).toBe("match_not_open");
          expect((err as ConsensusError).detail).toMatchObject({ status: "forfeited" });
        }
      }
      expect(() => resolveDispute({ matchId: m.id, organizerUserId: organizerId, sets: A_WINS_3 }, clock)).toThrow(ConsensusError);
      expect(consensusRow(m.id)).toEqual(after);
    });
  });
});
