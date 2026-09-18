import { describe, expect, it } from "vitest";
import {
  bracketSeedOrder,
  draw,
  DrawError,
  nextPowerOfTwo,
  orderTeams,
  poolCountFor,
  poolLabel,
  roundRobinRounds,
  seedBracketSlots,
  selectAdvancing,
  snakePools,
  type DrawMatch,
  type DrawOptions,
  type DrawPlan,
  type DrawTeam,
} from "@/domain/draw";
import type { StandingRow } from "@/domain/standings";
import { createRng } from "@/lib/rng";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 19, 15, 30);

const teams = (n: number, seeded = 0): DrawTeam[] => Array.from({ length: n }, (_, i) => ({ id: `t${String(i + 1).padStart(2, "0")}`, seed: i < seeded ? i + 1 : null }));

function options(patch: Partial<DrawOptions> & Pick<DrawOptions, "format" | "teams">): DrawOptions {
  return {
    courts: 6,
    poolSize: 4,
    advance: { perPool: 2, bestRemaining: 0 },
    poolBestOf: "1",
    bracketBestOf: "3",
    schedule: { startsAt: T0, poolMatchMinutes: 30, bracketMatchMinutes: 50, restMinutes: 15 },
    rng: createRng(7),
    ...patch,
  };
}

const bracketOf = (plan: DrawPlan): DrawMatch[] => plan.matches.filter((m) => m.poolKey === null).sort((x, y) => (x.bracketPosition ?? 0) - (y.bracketPosition ?? 0));
const poolMatchesOf = (plan: DrawPlan): DrawMatch[] => plan.matches.filter((m) => m.poolKey !== null);

/** Invariants every pool draw must satisfy, whatever the inputs. */
function expectPoolInvariants(plan: DrawPlan, teamIds: readonly string[]) {
  // Every team in exactly one pool.
  const placed = plan.pools.flatMap((p) => p.teamIds);
  expect([...placed].sort()).toEqual([...teamIds].sort());
  expect(new Set(placed).size).toBe(teamIds.length);
  // Pool sizes differ by at most one.
  const sizes = plan.pools.map((p) => p.teamIds.length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  // Every pair in a pool meets exactly once, and only within its pool.
  for (const pool of plan.pools) {
    const matches = plan.matches.filter((m) => m.poolKey === pool.key);
    const pairs = matches.map((m) => [m.teamAId, m.teamBId].sort().join("|"));
    expect(new Set(pairs).size).toBe(pairs.length);
    const n = pool.teamIds.length;
    expect(pairs).toHaveLength((n * (n - 1)) / 2);
    for (const m of matches) {
      expect(pool.teamIds).toContain(m.teamAId);
      expect(pool.teamIds).toContain(m.teamBId);
      expect(m.teamAId).not.toBe(m.teamBId);
      expect(m.courtLabel).toBeTruthy();
      expect(m.scheduledAt).not.toBeNull();
      expect(m.status).toBe("scheduled");
    }
    // No team plays twice in the same round.
    const rounds = new Map<number, string[]>();
    for (const m of matches) rounds.set(m.round, [...(rounds.get(m.round) ?? []), m.teamAId ?? "", m.teamBId ?? ""]);
    for (const ids of rounds.values()) expect(new Set(ids).size).toBe(ids.length);
  }
  // No court hosts two matches at the same time.
  const slots = plan.matches.map((m) => `${m.courtLabel}@${m.scheduledAt}`);
  expect(new Set(slots).size).toBe(slots.length);
}

/** Invariants of a bracket skeleton or seeded bracket. */
function expectBracketInvariants(plan: DrawPlan) {
  const bracket = bracketOf(plan);
  expect(plan.bracket).not.toBeNull();
  const size = plan.bracket?.size ?? 0;
  expect(size & (size - 1)).toBe(0);
  expect(bracket).toHaveLength(size - 1);
  expect(bracket.map((m) => m.bracketPosition)).toEqual(bracket.map((_, i) => i + 1));
  const byKey = new Map(bracket.map((m) => [m.key, m]));
  for (const m of bracket) {
    if (m.round === plan.bracket?.rounds) {
      expect(m.nextMatchKey).toBeNull();
      continue;
    }
    const next = byKey.get(m.nextMatchKey ?? "");
    expect(next?.round).toBe(m.round + 1);
    expect(next?.scheduledAt ?? 0).toBeGreaterThan(m.scheduledAt ?? 0);
    // Each next match is fed by exactly two matches, one per slot.
    const feeders = bracket.filter((f) => f.nextMatchKey === m.nextMatchKey);
    expect(feeders.map((f) => f.nextMatchSlot).sort()).toEqual(["a", "b"]);
  }
  // Byes only in round 1.
  for (const m of bracket) if (m.status === "bye") expect(m.round).toBe(1);
}

describe("primitives", () => {
  it("orders seeded teams first, then unseeded in rng order, and rejects bad seeds", () => {
    const rng = createRng(3);
    const order = orderTeams([...teams(6, 3)].reverse(), rng);
    expect(order.slice(0, 3)).toEqual(["t01", "t02", "t03"]);
    expect([...order.slice(3)].sort()).toEqual(["t04", "t05", "t06"]);
    expect(orderTeams(teams(6, 3), createRng(3))).toEqual(orderTeams(teams(6, 3), createRng(3)));
    expect(() => orderTeams([{ id: "a", seed: 1 }, { id: "b", seed: 1 }], rng)).toThrow(DrawError);
    expect(() => orderTeams([{ id: "a", seed: 0 }], rng)).toThrow(/positive integer/);
    expect(() => orderTeams([{ id: "a", seed: null }, { id: "a", seed: null }], rng)).toThrow(/twice/);
  });

  it.each([
    [24, 4, 6],
    [18, 4, 5],
    [16, 4, 4],
    [7, 4, 2],
    [5, 4, 1],
    [3, 2, 1],
    [2, 4, 1],
    [10, 3, 3],
  ])("%i teams at pool size %i → %i pools", (n, size, expected) => {
    expect(poolCountFor(n, size)).toBe(expected);
  });

  it("snake-seeds: 1..p left to right, p+1..2p right to left", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
    expect(snakePools(ids, 4)).toEqual([
      ["s1", "s8", "s9"],
      ["s2", "s7", "s10"],
      ["s3", "s6"],
      ["s4", "s5"],
    ]);
  });

  it.each([2, 3, 4, 5, 6, 7, 8])("round robin of %i: every pair once, nobody twice a round", (n) => {
    const rounds = roundRobinRounds(n);
    expect(rounds).toHaveLength(n % 2 === 0 ? n - 1 : n);
    const pairs = rounds.flat().map(([a, b]) => [a, b].sort().join("-"));
    expect(new Set(pairs).size).toBe((n * (n - 1)) / 2);
    for (const round of rounds) {
      const ids = round.flat();
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("round robin of four matches the classic rotation", () => {
    expect(roundRobinRounds(4)).toEqual([
      [
        [0, 3],
        [1, 2],
      ],
      [
        [0, 2],
        [3, 1],
      ],
      [
        [0, 1],
        [2, 3],
      ],
    ]);
  });

  it("labels pools A..Z then AA", () => {
    expect(poolLabel(0)).toBe("Pool A");
    expect(poolLabel(25)).toBe("Pool Z");
    expect(poolLabel(26)).toBe("Pool AA");
  });

  it("bracket seed order pairs s with size+1−s and separates the top seeds", () => {
    expect(bracketSeedOrder(2)).toEqual([1, 2]);
    expect(bracketSeedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(bracketSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const o16 = bracketSeedOrder(16);
    expect(o16).toHaveLength(16);
    expect(new Set(o16).size).toBe(16);
    for (let i = 0; i < 16; i += 2) expect((o16[i] ?? 0) + (o16[i + 1] ?? 0)).toBe(17);
    // Seeds 1 and 2 in opposite halves; 1–4 in separate quarters.
    const half = (s: number) => Math.floor(o16.indexOf(s) / 8);
    const quarter = (s: number) => Math.floor(o16.indexOf(s) / 4);
    expect(half(1)).not.toBe(half(2));
    expect(new Set([1, 2, 3, 4].map(quarter)).size).toBe(4);
    expect(() => bracketSeedOrder(6)).toThrow(DrawError);
    expect(nextPowerOfTwo(15)).toBe(16);
    expect(nextPowerOfTwo(16)).toBe(16);
    expect(nextPowerOfTwo(2)).toBe(2);
  });
});

describe("draw: pool_to_bracket", () => {
  it.each([24, 18, 16, 12, 9, 7, 5, 4])("holds the pool invariants for %i unseeded teams", (n) => {
    const entered = teams(n);
    const plan = draw(options({ format: "pool_to_bracket", teams: entered, advance: { perPool: 1, bestRemaining: 1 }, courts: 3 }));
    expectPoolInvariants(plan, entered.map((t) => t.id));
    expectBracketInvariants(plan);
  });

  it("is deterministic for a given rng seed and differs for another", () => {
    const a = draw(options({ format: "pool_to_bracket", teams: teams(24), rng: createRng(11) }));
    const b = draw(options({ format: "pool_to_bracket", teams: teams(24), rng: createRng(11) }));
    const c = draw(options({ format: "pool_to_bracket", teams: teams(24), rng: createRng(12) }));
    expect(a).toEqual(b);
    expect(a.order).not.toEqual(c.order);
  });

  it("places seeded teams by snake before unseeded ones", () => {
    const plan = draw(options({ format: "pool_to_bracket", teams: teams(24, 6) }));
    expect(plan.pools.map((p) => p.teamIds[0])).toEqual(["t01", "t02", "t03", "t04", "t05", "t06"]);
    expect(plan.order.slice(0, 6)).toEqual(["t01", "t02", "t03", "t04", "t05", "t06"]);
  });

  it("assigns one court per pool and aligned round times when courts ≥ pools", () => {
    const plan = draw(options({ format: "pool_to_bracket", teams: teams(24), courts: 6 }));
    expect(plan.pools.map((p) => p.courtLabel)).toEqual(["Court 1", "Court 2", "Court 3", "Court 4", "Court 5", "Court 6"]);
    const pool = plan.pools[0];
    const matches = plan.matches.filter((m) => m.poolKey === pool?.key).sort((x, y) => (x.scheduledAt ?? 0) - (y.scheduledAt ?? 0));
    expect(matches.map((m) => m.round)).toEqual([1, 1, 2, 2, 3, 3]);
    // Two matches per round on one court, 30 minutes apart; rounds an hour apart.
    expect(matches.map((m) => ((m.scheduledAt ?? 0) - T0) / MINUTE)).toEqual([0, 30, 60, 90, 120, 150]);
    expect(matches.every((m) => m.courtLabel === "Court 1")).toBe(true);
    const bracket = bracketOf(plan);
    // Bracket starts after the last pool slot plus its length plus the rest.
    expect(bracket[0]?.scheduledAt).toBe(T0 + 150 * MINUTE + 30 * MINUTE + 15 * MINUTE);
  });

  it("spreads a pool across several courts when there are more courts than pools", () => {
    const plan = draw(options({ format: "pool_to_bracket", teams: teams(8), courts: 4, advance: { perPool: 2, bestRemaining: 0 } }));
    expect(plan.pools.map((p) => p.courtLabel)).toEqual(["Courts 1, 3", "Courts 2, 4"]);
    const first = plan.matches.filter((m) => m.poolKey === "pool:0" && m.round === 1);
    expect(first.map((m) => m.courtLabel).sort()).toEqual(["Court 1", "Court 3"]);
    expect(new Set(first.map((m) => m.scheduledAt)).size).toBe(1);
  });

  it("runs pools in shifts when there are fewer courts than pools", () => {
    const plan = draw(options({ format: "pool_to_bracket", teams: teams(16), courts: 2, advance: { perPool: 2, bestRemaining: 0 } }));
    expect(plan.pools.map((p) => p.courtLabel)).toEqual(["Court 1", "Court 2", "Court 1", "Court 2"]);
    const firstOf = (key: string) => Math.min(...plan.matches.filter((m) => m.poolKey === key).map((m) => m.scheduledAt ?? 0));
    expect(firstOf("pool:0")).toBe(T0);
    expect(firstOf("pool:2")).toBe(T0 + 3 * HOUR);
    expectPoolInvariants(
      plan,
      teams(16).map((t) => t.id),
    );
  });

  it("builds an empty bracket skeleton sized by the advancement rule, with byes only possible in round 1", () => {
    const plan = draw(options({ format: "pool_to_bracket", teams: teams(24), advance: { perPool: 2, bestRemaining: 3 } }));
    expect(plan.bracket).toEqual({ size: 16, rounds: 4, advancing: 15 });
    expectBracketInvariants(plan);
    const bracket = bracketOf(plan);
    expect(bracket.every((m) => m.teamAId === null && m.teamBId === null && m.status === "scheduled")).toBe(true);
    expect(bracket.filter((m) => m.round === 1)).toHaveLength(8);
    expect(bracket.every((m) => m.bestOf === "3")).toBe(true);
    expect(poolMatchesOf(plan).every((m) => m.bestOf === "1")).toBe(true);
    expect(plan.seeds).toEqual([]);
    // Six courts: eight R16 matches in two waves, then quarters in one.
    const r1 = bracket.filter((m) => m.round === 1).map((m) => ((m.scheduledAt ?? 0) - (bracket[0]?.scheduledAt ?? 0)) / MINUTE);
    expect(r1).toEqual([0, 0, 0, 0, 0, 0, 50, 50]);
    const r2 = bracket.find((m) => m.round === 2)?.scheduledAt ?? 0;
    expect((r2 - (bracket[0]?.scheduledAt ?? 0)) / MINUTE).toBe(100 + 15);
  });

  it("refuses advancement rules the pools cannot satisfy", () => {
    expect(() => draw(options({ format: "pool_to_bracket", teams: teams(8), advance: { perPool: 5, bestRemaining: 0 } }))).toThrow(/exceeds the smallest pool/);
    expect(() => draw(options({ format: "pool_to_bracket", teams: teams(8), advance: { perPool: 0, bestRemaining: 1 } }))).toThrow(/At least two/);
    expect(() => draw(options({ format: "pool_to_bracket", teams: teams(8), advance: { perPool: 4, bestRemaining: 1 } }))).toThrow(/only 8 are entered/);
    expect(() => draw(options({ format: "pool_to_bracket", teams: teams(8), advance: { perPool: -1, bestRemaining: 1 } }))).toThrow(DrawError);
  });
});

describe("draw: single_elim", () => {
  it.each([2, 3, 4, 5, 8, 13, 16, 24])("seeds %i teams into the smallest bracket with byes only in round 1", (n) => {
    const entered = teams(n, n);
    const plan = draw(options({ format: "single_elim", teams: entered, courts: 4 }));
    expectBracketInvariants(plan);
    const bracket = bracketOf(plan);
    const size = nextPowerOfTwo(n);
    expect(plan.bracket).toEqual({ size, rounds: Math.log2(size), advancing: n });
    expect(plan.pools).toEqual([]);
    expect(plan.seeds.map((s) => s.seed)).toEqual(entered.map((_, i) => i + 1));
    const byes = bracket.filter((m) => m.status === "bye");
    expect(byes).toHaveLength(size - n);
    for (const bye of byes) {
      expect(bye.teamBId).toBeNull();
      expect(bye.winnerTeamId).toBe(bye.teamAId);
      const next = bracket.find((m) => m.key === bye.nextMatchKey);
      const filled = bye.nextMatchSlot === "a" ? next?.teamAId : next?.teamBId;
      expect(filled).toBe(bye.teamAId);
    }
    // Every entered team appears exactly once in round 1.
    const r1 = bracket.filter((m) => m.round === 1).flatMap((m) => [m.teamAId, m.teamBId]).filter(Boolean);
    expect([...r1].sort()).toEqual(entered.map((t) => t.id).sort());
    // Round 2+ slots hold only bye winners.
    const later = bracket.filter((m) => m.round > 1).flatMap((m) => [m.teamAId, m.teamBId]).filter(Boolean);
    expect([...later].sort()).toEqual(byes.map((b) => b.teamAId).sort());
  });

  it("puts seed 1 against the lowest seed and the top seeds in opposite halves", () => {
    const plan = draw(options({ format: "single_elim", teams: teams(16, 16) }));
    const r1 = bracketOf(plan).filter((m) => m.round === 1);
    expect(r1[0]).toMatchObject({ teamAId: "t01", teamBId: "t16" });
    const half = (id: string) => Math.floor(r1.findIndex((m) => m.teamAId === id || m.teamBId === id) / 4);
    expect(half("t01")).not.toBe(half("t02"));
  });

  it("gives the bye to the top seed when one team is missing", () => {
    const plan = draw(options({ format: "single_elim", teams: teams(15, 15) }));
    const bye = bracketOf(plan).find((m) => m.status === "bye");
    expect(bye).toMatchObject({ round: 1, bracketPosition: 1, teamAId: "t01", teamBId: null, winnerTeamId: "t01" });
  });
});

describe("draw: round_robin", () => {
  it("makes one pool of everyone across all courts", () => {
    const entered = teams(6);
    const plan = draw(options({ format: "round_robin", teams: entered, courts: 3 }));
    expectPoolInvariants(plan, entered.map((t) => t.id));
    expect(plan.pools).toHaveLength(1);
    expect(plan.pools[0]?.label).toBe("Round robin");
    expect(plan.pools[0]?.courtLabel).toBe("Courts 1, 2, 3");
    expect(plan.bracket).toBeNull();
    expect(plan.matches).toHaveLength(15);
    // Three matches per round on three courts: one wave per round.
    const round1 = plan.matches.filter((m) => m.round === 1);
    expect(new Set(round1.map((m) => m.scheduledAt)).size).toBe(1);
    expect(round1.map((m) => m.courtLabel).sort()).toEqual(["Court 1", "Court 2", "Court 3"]);
  });
});

describe("draw: refusals", () => {
  it("refuses double elimination with a specific error", () => {
    let caught: unknown;
    try {
      draw(options({ format: "double_elim", teams: teams(8) }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DrawError);
    expect((caught as DrawError).code).toBe("unsupported_format");
    expect((caught as DrawError).message).toMatch(/Double elimination is not drawable yet/);
  });

  it("refuses fewer than two teams, no courts, and bad schedules", () => {
    expect(() => draw(options({ format: "single_elim", teams: teams(1) }))).toThrow(/at least two teams/);
    expect(() => draw(options({ format: "single_elim", teams: teams(4), courts: 0 }))).toThrow(/Courts/);
    expect(() =>
      draw(options({ format: "single_elim", teams: teams(4), schedule: { startsAt: T0, poolMatchMinutes: 0, bracketMatchMinutes: 50, restMinutes: 0 } })),
    ).toThrow(/poolMatchMinutes/);
  });
});

describe("selectAdvancing + seedBracketSlots", () => {
  const row = (teamId: string, wins: number, pointDiff: number): StandingRow => ({
    teamId,
    played: 3,
    wins,
    losses: 3 - wins,
    setsWon: wins,
    setsLost: 3 - wins,
    pointsFor: 60 + pointDiff,
    pointsAgainst: 60,
    pointDiff,
    rank: 0,
  });
  const pools = [
    { rows: [row("a1", 3, 20), row("a2", 2, 5), row("a3", 1, -5), row("a4", 0, -20)] },
    { rows: [row("b1", 3, 12), row("b2", 2, 9), row("b3", 1, 2), row("b4", 0, -23)] },
    { rows: [row("c1", 2, 30), row("c2", 2, 1), row("c3", 1, -1), row("c4", 1, -30)] },
  ];

  it("ranks pool winners, then runners-up, then the best remaining by standings", () => {
    expect(selectAdvancing(pools, { perPool: 2, bestRemaining: 2 })).toEqual(["a1", "b1", "c1", "b2", "a2", "c2", "b3", "c3"]);
    expect(selectAdvancing(pools, { perPool: 1, bestRemaining: 0 })).toEqual(["a1", "b1", "c1"]);
    // Best remaining spills into the next place when the current one runs out.
    expect(selectAdvancing(pools, { perPool: 2, bestRemaining: 4 })).toEqual(["a1", "b1", "c1", "b2", "a2", "c2", "b3", "c3", "a3", "c4"]);
  });

  it("refuses rules the pools cannot meet", () => {
    expect(() => selectAdvancing(pools, { perPool: 5, bestRemaining: 0 })).toThrow(DrawError);
    expect(() => selectAdvancing(pools, { perPool: 2, bestRemaining: 7 })).toThrow(/Not enough teams/);
  });

  it("fills round 1 of a skeleton by seed, marking byes and pre-advancing them", () => {
    const skeleton = draw(options({ format: "pool_to_bracket", teams: teams(24), advance: { perPool: 2, bestRemaining: 3 } }));
    const bracket = bracketOf(skeleton).map((m) => ({ ...m, bracketPosition: m.bracketPosition ?? 0 }));
    const seeds = Array.from({ length: 15 }, (_, i) => `s${i + 1}`);
    const patches = seedBracketSlots(bracket, seeds);
    const byKey = new Map(patches.map((p) => [p.key, p]));
    expect(byKey.get("bracket:1")).toMatchObject({ teamAId: "s1", teamBId: null, status: "bye", winnerTeamId: "s1" });
    expect(byKey.get("bracket:2")).toMatchObject({ teamAId: "s8", teamBId: "s9", status: "scheduled", winnerTeamId: null });
    expect(byKey.get("bracket:9")).toMatchObject({ teamAId: "s1", teamBId: null, status: "scheduled" });
    expect(patches.filter((p) => p.status === "bye")).toHaveLength(1);
    expect(patches).toHaveLength(9);

    // Every seed lands in round 1 exactly once.
    const r1 = patches.filter((p) => Number(p.key.split(":")[1]) <= 8).flatMap((p) => [p.teamAId, p.teamBId]).filter(Boolean);
    expect([...r1].sort()).toEqual([...seeds].sort());
  });

  it("refuses a seed list that does not fit the bracket, or a bracket already seeded", () => {
    const skeleton = bracketOf(draw(options({ format: "pool_to_bracket", teams: teams(24), advance: { perPool: 2, bestRemaining: 3 } }))).map((m) => ({
      ...m,
      bracketPosition: m.bracketPosition ?? 0,
    }));
    expect(() => seedBracketSlots(skeleton, ["a"])).toThrow(/at least two/);
    expect(() => seedBracketSlots(skeleton, Array.from({ length: 8 }, (_, i) => `s${i}`))).toThrow(/seats 9–16/);
    expect(() => seedBracketSlots(skeleton, Array.from({ length: 17 }, (_, i) => `s${i}`))).toThrow(/seats 9–16/);
    expect(() => seedBracketSlots(skeleton, ["a", "a", ...Array.from({ length: 8 }, (_, i) => `s${i}`)])).toThrow(/two seeds/);
    const seeded = draw(options({ format: "single_elim", teams: teams(8, 8) }));
    expect(() =>
      seedBracketSlots(
        bracketOf(seeded).map((m) => ({ ...m, bracketPosition: m.bracketPosition ?? 0 })),
        Array.from({ length: 8 }, (_, i) => `s${i}`),
      ),
    ).toThrow(/already seeded/);
  });
});
