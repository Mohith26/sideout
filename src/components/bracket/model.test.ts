import { describe, expect, it } from "vitest";
import {
  COLUMN_GAP,
  fitText,
  HEADER_HEIGHT,
  layoutBracket,
  neighborOf,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodesFromMatches,
  nodesFromPlan,
  PADDING,
  pickCurrentMatch,
  ROW_GAP,
  type BracketNode,
  type MatchLike,
} from "@/components/bracket/model";
import { draw } from "@/domain/draw";
import { createRng } from "@/lib/rng";

/** An eight-slot bracket: positions 1–4 feed 5–6, which feed 7. */
function eightSlot(overrides: Partial<Record<number, Partial<BracketNode>>> = {}): BracketNode[] {
  const team = (n: number) => ({ id: `t${n}`, name: `Team ${n}`, seed: n, members: [`Player ${n}a`, `Player ${n}b`] });
  const base = (position: number, round: number, nextId: string | null, nextSlot: "a" | "b" | null): BracketNode => ({
    id: `m${position}`,
    round,
    position,
    teamA: null,
    teamB: null,
    status: "scheduled",
    winnerId: null,
    nextId,
    nextSlot,
    courtLabel: `Court ${position}`,
    scheduledAt: 1_000 * position,
    sets: [],
    href: `/m/m${position}`,
  });
  const nodes = [
    { ...base(1, 1, "m5", "a"), teamA: team(1), teamB: team(8) },
    { ...base(2, 1, "m5", "b"), teamA: team(4), teamB: team(5) },
    { ...base(3, 1, "m6", "a"), teamA: team(2), teamB: team(7) },
    { ...base(4, 1, "m6", "b"), teamA: team(3), teamB: team(6) },
    base(5, 2, "m7", "a"),
    base(6, 2, "m7", "b"),
    base(7, 3, null, null),
  ];
  return nodes.map((n) => ({ ...n, ...overrides[n.position] }));
}

describe("layoutBracket", () => {
  it("stacks round 1 and centers every later match between its feeders", () => {
    const layout = layoutBracket(eightSlot());
    expect(layout.rounds).toBe(3);
    expect(layout.columns.map((c) => c.label)).toEqual(["Quarterfinals", "Semifinals", "Final"]);
    const stride = NODE_HEIGHT + ROW_GAP;
    const first = layout.columns[0]?.nodes ?? [];
    expect(first.map((p) => p.y)).toEqual([0, 1, 2, 3].map((i) => HEADER_HEIGHT + PADDING + i * stride));
    const m5 = layout.byId.get("m5");
    const m1 = layout.byId.get("m1");
    const m2 = layout.byId.get("m2");
    expect(m5?.y).toBe(((m1?.y ?? 0) + (m2?.y ?? 0)) / 2);
    expect(m5?.x).toBe(PADDING + NODE_WIDTH + COLUMN_GAP);
    const m7 = layout.byId.get("m7");
    const m6 = layout.byId.get("m6");
    expect(m7?.y).toBe(((m5?.y ?? 0) + (m6?.y ?? 0)) / 2);
    expect(layout.width).toBe(PADDING * 2 + 3 * NODE_WIDTH + 2 * COLUMN_GAP);
    expect(layout.height).toBe(HEADER_HEIGHT + PADDING + 3 * stride + NODE_HEIGHT + PADDING);
  });

  it("draws one connector per feeder, marked advanced once the feeder has a winner", () => {
    const layout = layoutBracket(eightSlot({ 1: { status: "final", winnerId: "t1" } }));
    expect(layout.connectors).toHaveLength(6);
    const c = layout.connectors.find((x) => x.fromId === "m1");
    expect(c).toMatchObject({ toId: "m5", slot: "a", advanced: true });
    expect(c?.d).toMatch(/^M \d+(\.\d+)? \d+(\.\d+)? H \d+(\.\d+)? V \d+(\.\d+)? H \d+(\.\d+)?$/);
    expect(layout.connectors.filter((x) => x.advanced)).toHaveLength(1);
  });

  it("still lays out a skeleton whose links are missing", () => {
    const nodes = eightSlot().map((n) => ({ ...n, nextId: null, nextSlot: null }));
    const layout = layoutBracket(nodes);
    expect(layout.connectors).toHaveLength(0);
    const ys = layout.columns.map((c) => c.nodes.map((p) => p.y));
    expect(ys[1]?.[0]).toBeGreaterThan(ys[0]?.[0] ?? 0);
    expect(ys[2]?.[0]).toBeGreaterThan(ys[1]?.[0] ?? 0);
  });

  it("returns an empty layout for no nodes", () => {
    const layout = layoutBracket([]);
    expect(layout.rounds).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.columns).toEqual([]);
  });
});

describe("pickCurrentMatch", () => {
  it("prefers what is on the sand, then scores waiting, then disputes, then the next scheduled match with both teams", () => {
    expect(pickCurrentMatch(eightSlot({ 3: { status: "in_progress" }, 2: { status: "awaiting_scores" } }))?.id).toBe("m3");
    expect(pickCurrentMatch(eightSlot({ 2: { status: "awaiting_scores" }, 4: { status: "disputed" } }))?.id).toBe("m2");
    expect(pickCurrentMatch(eightSlot({ 4: { status: "disputed" } }))?.id).toBe("m4");
    // Nothing started: the earliest scheduled match that has both teams, never an empty round-2 slot.
    expect(pickCurrentMatch(eightSlot())?.id).toBe("m1");
    expect(pickCurrentMatch(eightSlot({ 1: { scheduledAt: 9_000 } }))?.id).toBe("m2");
  });

  it("falls back to the latest resolved match when everything is played", () => {
    const nodes = eightSlot().map((n) => ({ ...n, status: "final" as const, winnerId: "t1", teamA: n.teamA ?? { id: "t1", name: "Team 1", seed: 1, members: [] }, teamB: n.teamB ?? { id: "t2", name: "Team 2", seed: 2, members: [] } }));
    expect(pickCurrentMatch(nodes)?.id).toBe("m7");
    expect(pickCurrentMatch([])).toBeNull();
  });
});

describe("neighborOf", () => {
  const layout = layoutBracket(eightSlot());
  it("moves up and down within a round and stops at the edges", () => {
    expect(neighborOf(layout, "m1", "down")).toBe("m2");
    expect(neighborOf(layout, "m2", "up")).toBe("m1");
    expect(neighborOf(layout, "m1", "up")).toBeNull();
    expect(neighborOf(layout, "m4", "down")).toBeNull();
    expect(neighborOf(layout, "m3", "home")).toBe("m1");
    expect(neighborOf(layout, "m3", "end")).toBe("m4");
  });
  it("moves right along the winner's path and left to the nearest feeder", () => {
    expect(neighborOf(layout, "m1", "right")).toBe("m5");
    expect(neighborOf(layout, "m4", "right")).toBe("m6");
    expect(neighborOf(layout, "m5", "right")).toBe("m7");
    expect(neighborOf(layout, "m7", "right")).toBeNull();
    expect(neighborOf(layout, "m5", "left")).toBe("m1");
    expect(neighborOf(layout, "m7", "left")).toBe("m5");
    expect(neighborOf(layout, "m1", "left")).toBeNull();
    expect(neighborOf(layout, "nope", "left")).toBeNull();
  });
});

describe("sources", () => {
  it("builds nodes from match rows, dropping pool matches and disputed numbers", () => {
    const team = (id: string, seed: number | null) => ({ id, name: id.toUpperCase(), seed, members: [{ displayName: "Ana Ruiz" }, { displayName: "Bo Lee" }] });
    const row = (id: string, status: MatchLike["match"]["status"], poolId: string | null): MatchLike => ({
      match: { id, round: 1, bracketPosition: 1, poolId, status, winnerTeamId: null, nextMatchId: null, nextMatchSlot: null, courtLabel: "Court 1", scheduledAt: 5 },
      teamA: team("a", 1),
      teamB: team("b", null),
      sets: [{ teamAPoints: 21, teamBPoints: 18 }],
    });
    const nodes = nodesFromMatches([row("pool", "final", "p1"), row("x", "final", null), row("d", "disputed", null)]);
    expect(nodes.map((n) => n.id)).toEqual(["x", "d"]);
    expect(nodes[0]).toMatchObject({ href: "/m/x", sets: [{ a: 21, b: 18 }], teamA: { id: "a", seed: 1, members: ["Ana Ruiz", "Bo Lee"] } });
    expect(nodes[1]?.sets).toEqual([]);
  });

  it("builds a linked, unfilled skeleton from a draw plan, including engine-placed byes", () => {
    const teams = Array.from({ length: 6 }, (_, i) => ({ id: `t${i + 1}`, seed: i + 1 }));
    const plan = draw({
      format: "single_elim",
      teams,
      rng: createRng(1),
      courts: 2,
      poolSize: 4,
      advance: { perPool: 1, bestRemaining: 0 },
      poolBestOf: "1",
      bracketBestOf: "3",
      schedule: { startsAt: 0, poolMatchMinutes: 30, bracketMatchMinutes: 45, restMinutes: 10 },
    });
    const names = Object.fromEntries(teams.map((t) => [t.id, { name: `Team ${t.id}`, seed: t.seed }]));
    const nodes = nodesFromPlan(plan, names);
    expect(nodes).toHaveLength(7);
    expect(nodes.every((n) => n.href === null)).toBe(true);
    const byes = nodes.filter((n) => n.status === "bye");
    expect(byes).toHaveLength(2);
    expect(byes.every((b) => b.teamA !== null && b.teamB === null && b.winnerId === b.teamA?.id)).toBe(true);
    const layout = layoutBracket(nodes);
    expect(layout.connectors.filter((c) => c.advanced)).toHaveLength(2);
    expect(layout.columns.map((c) => c.label)).toEqual(["Quarterfinals", "Semifinals", "Final"]);
  });
});

describe("fitText", () => {
  it("truncates with an ellipsis only when needed", () => {
    expect(fitText("Delgado / Okafor", 200)).toBe("Delgado / Okafor");
    expect(fitText("A very long team name indeed", 70)).toBe("A very lo…");
    expect(fitText("abcdef", 10)).toBe("ab…");
  });
});
