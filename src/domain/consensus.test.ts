import { describe, expect, it, vi } from "vitest";
import { ACTOR_KINDS, CONSENSUS_STATES, type ActorKind, type ConsensusState } from "@/db/schema";
import {
  agreedOutcome,
  assertLegalScoreline,
  assertMayWriteToLucra,
  canonicalizeSubmission,
  CLOSE_BLOCKING_CONSENSUS_STATES,
  CONSENSUS_TRANSITIONS,
  ConsensusError,
  describeDifferences,
  diffScorelines,
  idempotencyKeyFor,
  judgeSubmission,
  LUCRA_WRITABLE_STATES,
  LucraWriteRefused,
  OPEN_CONSENSUS_STATES,
  storedSubmissionSets,
  submittedScorelineSchema,
  toMatchOrientation,
  toPerspective,
  transitionConsensus,
} from "@/domain/consensus";
import { hashScoreline } from "@/domain/scoreline";

const actor = (kind: ActorKind) => ({ kind, userId: kind === "system" || kind === "lucra_webhook" ? null : "u1" });

describe("consensus transition table (spec §10)", () => {
  // Rows: from; columns: to. Cell = the actor kinds allowed; absent = illegal.
  const table: Record<ConsensusState, Partial<Record<ConsensusState, readonly ActorKind[]>>> = {
    awaiting_first: { awaiting_second: ["player"] },
    awaiting_second: { agreed: ["player"], disputed: ["player"] },
    disputed: { agreed: ["organizer"] },
    agreed: { submitting: ["organizer", "system"] },
    submitting: { accepted: ["system", "lucra_webhook"], partial: ["system", "lucra_webhook"], rejected: ["system", "lucra_webhook"] },
    accepted: {},
    partial: { submitting: ["organizer", "system"] },
    rejected: { submitting: ["organizer", "system"] },
  };

  it("matches the documented matrix for every (from, to, actor) triple", () => {
    for (const from of CONSENSUS_STATES) {
      for (const to of CONSENSUS_STATES) {
        for (const kind of ACTOR_KINDS) {
          const allowed = table[from][to]?.includes(kind) ?? false;
          const verdict = transitionConsensus(from, to, actor(kind));
          expect(verdict.ok, `${from} → ${to} as ${kind}`).toBe(allowed);
          if (!verdict.ok) expect(verdict.reason).toMatch(from === to ? /already/ : /cannot go|Only/);
        }
      }
    }
    expect(CONSENSUS_TRANSITIONS).toHaveLength(10);
  });

  it("names the states that are open, that block a close, and that may write to Lucra", () => {
    expect([...OPEN_CONSENSUS_STATES].sort()).toEqual(["awaiting_first", "awaiting_second"]);
    expect([...CLOSE_BLOCKING_CONSENSUS_STATES].sort()).toEqual(["disputed", "partial", "rejected", "submitting"]);
    expect([...LUCRA_WRITABLE_STATES].sort()).toEqual(["agreed", "partial", "rejected"]);
  });

  it("never lets a player leave disputed, and never lets anyone skip agreed", () => {
    expect(transitionConsensus("disputed", "agreed", actor("player")).ok).toBe(false);
    expect(transitionConsensus("awaiting_second", "submitting", actor("system")).ok).toBe(false);
    expect(transitionConsensus("awaiting_first", "agreed", actor("player")).ok).toBe(false);
    expect(transitionConsensus("accepted", "agreed", actor("organizer")).ok).toBe(false);
  });
});

describe("canonicalization (spec §10.1)", () => {
  const matchId = "m1";
  const aView = [
    { setNumber: 1, usPoints: 21, themPoints: 18 },
    { setNumber: 2, usPoints: 19, themPoints: 21 },
    { setNumber: 3, usPoints: 15, themPoints: 12 },
  ];
  // Team B typed the same result from its own side, sets out of order.
  const bView = [
    { setNumber: 3, usPoints: 12, themPoints: 15 },
    { setNumber: 1, usPoints: 18, themPoints: 21 },
    { setNumber: 2, usPoints: 21, themPoints: 19 },
  ];

  it("hashes both honest views of one result identically", () => {
    const a = canonicalizeSubmission(matchId, aView, "a", "3");
    const b = canonicalizeSubmission(matchId, bView, "b", "3");
    expect(a.hash).toBe(b.hash);
    expect(a.sets).toEqual(b.sets);
    expect(a.hash).toBe(hashScoreline({ matchId, sets: a.sets }, "a"));
    expect(a.verdict).toMatchObject({ legal: true, winner: "a" });
  });

  it("hashes a different set-3 total differently", () => {
    const a = canonicalizeSubmission(matchId, aView, "a", "3");
    const b = canonicalizeSubmission(matchId, [bView[0] ? { ...bView[0], usPoints: 10 } : bView[0]!, bView[1]!, bView[2]!], "b", "3");
    expect(a.hash).not.toBe(b.hash);
  });

  it("round-trips a perspective and a stored payload", () => {
    const oriented = toMatchOrientation(bView, "b");
    expect(toPerspective(oriented, "b")).toEqual([...bView].sort((x, y) => x.setNumber - y.setNumber));
    expect(toPerspective(oriented, "a")).toEqual(aView);
    expect(storedSubmissionSets(JSON.stringify({ matchId, perspective: "b", sets: bView }))).toEqual(oriented);
  });

  it("rejects an illegal scoreline naming the offending set (spec §10.4)", () => {
    const bad = canonicalizeSubmission(matchId, [{ setNumber: 1, usPoints: 21, themPoints: 20 }], "a", "1");
    expect(() => assertLegalScoreline(bad, "1")).toThrow(ConsensusError);
    try {
      assertLegalScoreline(bad, "1");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsensusError);
      const e = err as ConsensusError;
      expect(e.code).toBe("illegal_scoreline");
      expect(e.message).toMatch(/Set 1: Sets are won by 2/);
      expect(e.detail).toMatchObject({ code: "illegal_scoreline", setNumber: 1, bestOf: "1" });
    }
    const unfinished = canonicalizeSubmission(matchId, [{ setNumber: 1, usPoints: 21, themPoints: 18 }], "a", "3");
    expect(() => assertLegalScoreline(unfinished, "3")).toThrow(/Nobody has won 2 set/);
    const absurd = submittedScorelineSchema.safeParse({ sets: [{ setNumber: 1, usPoints: 1000, themPoints: 0 }] });
    expect(absurd.success).toBe(false);
  });
});

describe("judgeSubmission (spec §10.2)", () => {
  const describeDifference = () => "Set 3 differs: 15–12 vs 15–10";

  it("first submission waits on the other team", () => {
    expect(judgeSubmission({ state: "awaiting_first", submission: { teamId: "t1", hash: "h" }, standing: null, replaces: false, describeDifference })).toEqual({
      next: "awaiting_second",
      replaced: false,
    });
  });

  it("a resubmission from the same team stays awaiting_second and only replaces", () => {
    expect(judgeSubmission({ state: "awaiting_second", submission: { teamId: "t1", hash: "h2" }, standing: null, replaces: true, describeDifference })).toEqual({
      next: "awaiting_second",
      replaced: true,
    });
    // A caller that mistook the same team's row for the other side is refused outright.
    expect(() => judgeSubmission({ state: "awaiting_second", submission: { teamId: "t1", hash: "h" }, standing: { teamId: "t1", hash: "h" }, replaces: true, describeDifference })).toThrow(
      /different teams/,
    );
  });

  it("the other team agrees by hash equality and disputes by inequality", () => {
    expect(judgeSubmission({ state: "awaiting_second", submission: { teamId: "t2", hash: "h" }, standing: { teamId: "t1", hash: "h" }, replaces: false, describeDifference })).toEqual({ next: "agreed" });
    expect(judgeSubmission({ state: "awaiting_second", submission: { teamId: "t2", hash: "x" }, standing: { teamId: "t1", hash: "h" }, replaces: false, describeDifference })).toEqual({
      next: "disputed",
      reason: "Set 3 differs: 15–12 vs 15–10",
    });
  });

  it("accepts nothing once the consensus has left the open states", () => {
    for (const state of ["disputed", "agreed", "submitting", "accepted", "partial", "rejected"] as const) {
      expect(() => judgeSubmission({ state, submission: { teamId: "t2", hash: "h" }, standing: null, replaces: false, describeDifference })).toThrow(ConsensusError);
    }
  });
});

describe("differences", () => {
  const x = [
    { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
    { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
    { setNumber: 3, teamAPoints: 15, teamBPoints: 12 },
  ];
  it("lists only the sets that differ, including one side not reporting a set", () => {
    const y = [x[0]!, x[1]!, { setNumber: 3, teamAPoints: 15, teamBPoints: 10 }];
    expect(diffScorelines(x, y)).toEqual([{ setNumber: 3, a: x[2], b: y[2] }]);
    expect(describeDifferences(diffScorelines(x, y))).toBe("Set 3 differs: 15–12 vs 15–10");
    expect(diffScorelines(x, x)).toEqual([]);
    expect(describeDifferences(diffScorelines(x, x.slice(0, 2)))).toBe("Set 3 differs: 15–12 vs not reported");
    expect(describeDifferences([])).toBe("The scorelines differ.");
  });
});

describe("entering agreed", () => {
  it("mints the idempotency key exactly once (spec §10.3)", () => {
    const mint = vi.fn(() => "fresh");
    expect(idempotencyKeyFor(null, mint)).toBe("fresh");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(idempotencyKeyFor("kept", mint)).toBe("kept");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("derives the winner from the legal scoreline and refuses an illegal one", () => {
    const match = { id: "m1", teamAId: "t1", teamBId: "t2", bestOf: "3" as const };
    const sets = [
      { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
      { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
      { setNumber: 3, teamAPoints: 12, teamBPoints: 15 },
    ];
    const out = agreedOutcome(match, sets);
    expect(out.winner).toBe("b");
    expect(out.winnerTeamId).toBe("t2");
    expect(out.sets.map((s) => s.setNumber)).toEqual([1, 2, 3]);
    expect(out.hash).toBe(hashScoreline({ matchId: "m1", sets: out.sets }, "a"));
    expect(() => agreedOutcome(match, [{ setNumber: 1, teamAPoints: 21, teamBPoints: 18 }])).toThrow(ConsensusError);
    expect(() => agreedOutcome({ ...match, teamBId: null }, out.sets)).toThrow(/both teams/);
  });
});

describe("assertMayWriteToLucra (spec §10.5)", () => {
  it("passes only agreed (or a retry after rejected/partial) with a minted key", () => {
    for (const state of CONSENSUS_STATES) {
      const row = { matchId: "m1", state, idempotencyKey: "k" };
      if (LUCRA_WRITABLE_STATES.has(state)) {
        expect(() => assertMayWriteToLucra(row)).not.toThrow();
      } else {
        expect(() => assertMayWriteToLucra(row)).toThrow(LucraWriteRefused);
        try {
          assertMayWriteToLucra(row);
        } catch (err) {
          expect((err as LucraWriteRefused).code).toBe("not_agreed");
        }
      }
    }
  });

  it("refuses an agreed consensus without its key", () => {
    expect(() => assertMayWriteToLucra({ matchId: "m1", state: "agreed", idempotencyKey: null })).toThrow(LucraWriteRefused);
    try {
      assertMayWriteToLucra({ matchId: "m1", state: "agreed", idempotencyKey: null });
    } catch (err) {
      expect((err as LucraWriteRefused).code).toBe("missing_idempotency_key");
    }
  });
});
