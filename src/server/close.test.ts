import { and, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matches, rewards, teamMembers, tournaments, type Match } from "@/db/schema";
import type { SubmittedSet } from "@/domain/consensus";
import type { SetScore } from "@/domain/scoreline";
import { ApiFailure } from "@/lib/api";
import { fixedClock } from "@/lib/clock";
import { uuidv7 } from "@/lib/uuid";
import { SLUGS } from "@/seed/build";
import { canonicalPreview, closeTournament, hashPreview, lucraSettlementHook, previewClose, readStoredClosePreview, type FrozenPreview } from "@/server/close";
import { resolveDispute, submitScoreline } from "@/server/consensus";
import { forfeitMatch } from "@/server/matches";
import { createTestApp, type TestApp } from "@/test/routes";

const HOUR = 3_600_000;
const A_WINS: SetScore[] = [
  { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
  { setNumber: 2, teamAPoints: 21, teamBPoints: 16 },
];
const typed = (setsForA: readonly SetScore[], side: "a" | "b"): SubmittedSet[] =>
  setsForA.map((s) => ({ setNumber: s.setNumber, usPoints: side === "a" ? s.teamAPoints : s.teamBPoints, themPoints: side === "a" ? s.teamBPoints : s.teamAPoints }));

describe("close flow (spec §10.7, §11.6)", () => {
  let app: TestApp;
  const clock = fixedClock(0);
  let live: { id: string };
  let organizerId = "";

  beforeEach(() => {
    app = createTestApp();
    clock.set(app.anchorMs + 23 * HOUR);
    live = app.tournament(SLUGS.live);
    organizerId = app.organizer().id;
  });
  afterEach(() => app.close());

  const db = () => app.conn.db;
  const at = (position: number): Match => {
    const m = db()
      .select()
      .from(matches)
      .where(and(eq(matches.tournamentId, live.id), eq(matches.bracketPosition, position)))
      .get();
    if (!m) throw new Error(`no match at ${position}`);
    return m;
  };
  const captainOf = (teamId: string | null) => {
    const row = db()
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId ?? ""))
      .get();
    if (!row) throw new Error("no captain");
    return row.userId;
  };
  const agree = (m: Match) => {
    submitScoreline({ matchId: m.id, userId: captainOf(m.teamAId), scoreline: { sets: typed(A_WINS, "a") } }, clock);
    submitScoreline({ matchId: m.id, userId: captainOf(m.teamBId), scoreline: { sets: typed(A_WINS, "b") } }, clock);
  };
  const organizer = () => ({ kind: "organizer" as const, userId: organizerId });

  /** Bring the seeded live event to a closable state: resolve, agree, and forfeit what is left. */
  function settleEverything() {
    resolveDispute({ matchId: at(11).id, organizerUserId: organizerId, sets: A_WINS }, clock);
    // QF 12: team A already submitted in the seed; team B agrees with what A typed.
    const twelve = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    agree(at(13));
    const fourteen = at(14);
    forfeitMatch(fourteen.id, fourteen.teamBId ?? "", organizer(), clock);
    const fifteen = at(15);
    forfeitMatch(fifteen.id, fifteen.teamBId ?? "", organizer(), clock);
  }

  it("names every blocking match with a reason, and refuses to close over them", () => {
    const preview = previewClose(live.id);
    expect(preview.tournamentStatus).toBe("live");
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.matchesTotal).toBeGreaterThan(preview.matchesFinal);
    const byStatus = Object.fromEntries(preview.blockers.map((b) => [b.status + ":" + (b.consensusState ?? "-"), b.reason]));
    expect(byStatus).toEqual({
      "disputed:disputed": "The two scorelines differ. Resolve the dispute with an authoritative scoreline, or forfeit one side.",
      "awaiting_scores:awaiting_second": "One team has submitted; waiting on the other.",
      "in_progress:awaiting_first": "On the sand now. Both teams must submit the result.",
      "scheduled:-": "Not played yet. Play it, or forfeit one side.",
    });
    expect(preview.blockers.map((b) => b.matchId).sort()).toEqual([11, 12, 13, 14, 15].map((p) => at(p).id).sort());
    expect(preview.blockers.find((b) => b.status === "disputed")).toMatchObject({ roundLabel: "Quarterfinals", teamA: { name: expect.any(String) }, teamB: { name: expect.any(String) } });

    // The final is not decided, so the standings are provisional: no bracket team is placed by elimination yet.
    expect(preview.standingsProvisional).toBe(true);
    expect(preview.standings.some((r) => r.basis === "bracket")).toBe(false);
    const bracketTeamIds = new Set(
      db()
        .select({ a: matches.teamAId, b: matches.teamBId })
        .from(matches)
        .where(and(eq(matches.tournamentId, live.id), isNotNull(matches.bracketPosition)))
        .all()
        .flatMap((m) => [m.a, m.b])
        .filter((id): id is string => id !== null),
    );
    expect(preview.standings.filter((r) => bracketTeamIds.has(r.teamId)).every((r) => r.basis === "unplayed" && r.detail === "Bracket not decided")).toBe(true);
    expect(preview.standings.filter((r) => r.basis === "unplayed")).toHaveLength(bracketTeamIds.size);

    try {
      closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
      throw new Error("expected close_blocked");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiFailure);
      const e = err as ApiFailure;
      expect(e.code).toBe("conflict");
      expect(e.detail).toMatchObject({ code: "close_blocked" });
      expect((e.detail as { blockers: unknown[] }).blockers).toHaveLength(5);
    }
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("live");
    expect(app.audits(live.id, "tournament.closed")).toHaveLength(0);
  });

  it("hashes a canonical serialization: same rows in any order, same hash; any change, a new hash", () => {
    const frozen: FrozenPreview = {
      tournamentId: "t",
      standings: [
        { placement: 2, teamId: "b", teamName: "B", basis: "bracket", detail: "Lost the final", wins: 3, losses: 1 },
        { placement: 1, teamId: "a", teamName: "A", basis: "bracket", detail: "Won the final", wins: 4, losses: 0 },
      ],
      rewards: [{ id: "r1", placement: 1, teamId: "a", teamName: "A", kind: "lucra_reward", amountCents: 50000, currency: "USD", description: "Champions" }],
    };
    const reordered: FrozenPreview = { ...frozen, standings: [...frozen.standings].reverse() };
    expect(hashPreview(reordered)).toBe(hashPreview(frozen));
    expect(canonicalPreview(frozen)).toBe(
      '{"tournamentId":"t","standings":[{"placement":1,"teamId":"a","teamName":"A","basis":"bracket","detail":"Won the final","wins":4,"losses":0},{"placement":2,"teamId":"b","teamName":"B","basis":"bracket","detail":"Lost the final","wins":3,"losses":1}],"rewards":[{"id":"r1","placement":1,"teamId":"a","teamName":"A","kind":"lucra_reward","amountCents":50000,"currency":"USD","description":"Champions"}]}',
    );
    expect(hashPreview({ ...frozen, rewards: [{ ...frozen.rewards[0]!, amountCents: 50001 }] })).not.toBe(hashPreview(frozen));
    expect(hashPreview({ ...frozen, rewards: [] })).not.toBe(hashPreview(frozen));
  });

  it("closes only through a matching preview hash, freezing the standings and projected rewards", () => {
    settleEverything();
    const clean = previewClose(live.id);
    expect(clean.blockers).toEqual([]);
    expect(clean.matchesFinal).toBe(clean.matchesTotal);
    expect(clean.standingsProvisional).toBe(false);
    expect(clean.rewards).toEqual([]);

    // Placements follow the bracket: the final's winner first, its loser second, the semifinal losers third.
    const finalMatch = at(15);
    expect(clean.standings[0]).toMatchObject({ placement: 1, teamId: finalMatch.winnerTeamId, basis: "bracket", detail: "Won the final by forfeit" });
    expect(clean.standings[1]).toMatchObject({ placement: 2, teamId: finalMatch.teamBId, detail: "Lost the final" });
    expect(clean.standings.filter((r) => r.placement === 3)).toHaveLength(2);
    expect(clean.standings.filter((r) => r.placement === 5)).toHaveLength(4);
    expect(clean.standings).toHaveLength(24);
    expect(clean.standings.every((r) => r.teamName.length > 0)).toBe(true);
    expect(new Set(clean.standings.map((r) => r.teamId)).size).toBe(24);
    const champion = clean.standings[0];
    expect(champion && champion.wins > champion.losses).toBe(true);

    // The organizer projects two rewards; the preview picks them up and its hash moves.
    const champ = clean.standings[0]?.teamId ?? "";
    const runnerUp = clean.standings[1]?.teamId ?? "";
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: champ, placement: 1, kind: "lucra_reward", amountCents: 100000, currency: "USD", description: "Champions", lucraRewardRef: null, status: "projected" }).run();
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: runnerUp, placement: 2, kind: "sponsor_item", amountCents: null, currency: null, description: "Finalists — eyewear", lucraRewardRef: null, status: "projected" }).run();
    // An already-awarded row is not a projection and stays out of the preview.
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: champ, placement: 1, kind: "credit", amountCents: 1, currency: "USD", description: "old", lucraRewardRef: null, status: "awarded" }).run();
    const withRewards = previewClose(live.id);
    expect(withRewards.rewards.map((r) => [r.placement, r.teamId, r.amountCents])).toEqual([
      [1, champ, 100000],
      [2, runnerUp, null],
    ]);
    expect(withRewards.previewHash).not.toBe(clean.previewHash);

    // The stale hash from before the rewards existed is refused.
    try {
      closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: clean.previewHash }, clock);
      throw new Error("expected preview_stale");
    } catch (err) {
      const e = err as ApiFailure;
      expect(e.code).toBe("conflict");
      expect(e.detail).toEqual({ code: "preview_stale", previewHash: withRewards.previewHash });
    }
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("live");

    const result = closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: withRewards.previewHash }, clock);
    expect(result.detail.tournament.status).toBe("awaiting_settlement");
    expect(result.settlement).toEqual({ state: "not_available" });
    expect(result.frozen).toMatchObject({ previewHash: withRewards.previewHash, closedAt: clock.now(), closedByUserId: organizerId });
    expect(result.frozen.standings).toEqual(withRewards.standings);
    expect(result.frozen.rewards).toEqual(withRewards.rewards);

    const row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get();
    expect(row?.status).toBe("awaiting_settlement");
    expect(readStoredClosePreview(row ?? { closePreviewJson: null })).toEqual(result.frozen);
    const auditRows = app.audits(live.id).filter((a) => a.createdAt === clock.now());
    expect(auditRows.map((a) => [a.action, a.actorKind, a.actorUserId])).toEqual([
      ["tournament.status_changed", "organizer", organizerId],
      ["tournament.closed", "organizer", organizerId],
    ]);
    expect(JSON.parse(auditRows[1]?.detailJson ?? "{}")).toMatchObject({ previewHash: withRewards.previewHash, standings: 24, rewards: 2 });

    // Closed is closed.
    try {
      closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: withRewards.previewHash }, clock);
      throw new Error("expected not_live");
    } catch (err) {
      expect((err as ApiFailure).detail).toMatchObject({ code: "not_live", status: "awaiting_settlement" });
    }
    expect(previewClose(live.id).tournamentStatus).toBe("awaiting_settlement");
  });

  it("refuses to close anything that is not live, and the settlement hook triggers nothing yet", () => {
    const settled = app.tournament(SLUGS.settled);
    const preview = previewClose(settled.id);
    expect(preview.blockers).toEqual([]);
    try {
      closeTournament({ tournamentId: settled.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
      throw new Error("expected not_live");
    } catch (err) {
      expect((err as ApiFailure).detail).toMatchObject({ code: "not_live", status: "settled" });
    }
    expect(lucraSettlementHook({ tournamentId: settled.id, standings: [], rewards: [], previewHash: preview.previewHash, closedAt: 0, closedByUserId: organizerId })).toEqual({ state: "not_available" });
  });
});
