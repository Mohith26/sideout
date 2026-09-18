import { describe, expect, it } from "vitest";
import {
  compareStandingKeys,
  compareStandings,
  computeStandings,
  headToHeadResolver,
  TIEBREAK_ORDER,
  type StandingRow,
  type StandingsMatch,
} from "@/domain/standings";

const A = "team-a";
const B = "team-b";
const C = "team-c";
const D = "team-d";

const bo1 = (teamAId: string, teamBId: string, a: number, b: number): StandingsMatch => ({
  teamAId,
  teamBId,
  winnerTeamId: a > b ? teamAId : teamBId,
  sets: [{ teamAPoints: a, teamBPoints: b }],
});

describe("computeStandings", () => {
  it("documents the tiebreak order", () => {
    expect(TIEBREAK_ORDER).toEqual(["wins", "head_to_head", "set_ratio", "point_diff", "points_for", "team_id"]);
  });

  it("ranks by wins, then point differential, then points for", () => {
    const rows = computeStandings(
      [A, B, C, D],
      [bo1(A, B, 21, 15), bo1(C, D, 21, 19), bo1(A, C, 18, 21), bo1(B, D, 12, 21), bo1(A, D, 21, 10), bo1(B, C, 20, 22)],
    );
    expect(rows.map((r) => r.teamId)).toEqual([C, A, D, B]);
    const c = rows[0];
    expect(c).toMatchObject({ wins: 3, losses: 0, played: 3, pointsFor: 64, pointsAgainst: 57, pointDiff: 7, rank: 1 });
    const a = rows[1];
    expect(a).toMatchObject({ wins: 2, losses: 1, pointDiff: 21 - 15 + 18 - 21 + 21 - 10, rank: 2 });
    expect(rows[3]).toMatchObject({ teamId: B, wins: 0, rank: 4 });
  });

  it("shares a rank on a full tie and breaks by point differential otherwise", () => {
    const rows = computeStandings([A, B, C], [bo1(A, B, 21, 10), bo1(B, C, 21, 10), bo1(C, A, 21, 10)]);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 1]);

    const broken = computeStandings([A, B, C], [bo1(A, B, 21, 10), bo1(B, C, 21, 15), bo1(C, A, 21, 19)]);
    // A +9, C -4, B -5 on point differential with everyone at one win.
    expect(broken.map((r) => r.teamId)).toEqual([A, C, B]);
    expect(broken.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("uses head-to-head only for an exactly-two-way tie on wins", () => {
    // A and B both 2–1; B beat A but A has the far better point differential.
    // C and D both 1–2; C beat D.
    const rows = computeStandings(
      [A, B, C, D],
      [bo1(B, A, 21, 19), bo1(A, C, 21, 5), bo1(A, D, 21, 5), bo1(B, C, 21, 19), bo1(D, B, 21, 19), bo1(C, D, 21, 19)],
    );
    expect(rows.map((r) => r.teamId)).toEqual([B, A, C, D]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);

    // Three-way tie at 1–1... skip head-to-head, go straight to set ratio / differential.
    const three = computeStandings([A, B, C], [bo1(A, B, 21, 10), bo1(B, C, 21, 19), bo1(C, A, 21, 19)]);
    expect(three.map((r) => r.teamId)).toEqual([A, C, B]);
  });

  it("counts a forfeit as a win with no sets or points, and ranks set ratio before point differential", () => {
    const rows = computeStandings(
      [A, B, C],
      [
        { teamAId: A, teamBId: B, winnerTeamId: A, sets: [] },
        bo1(B, C, 21, 15),
        bo1(C, A, 21, 12),
      ],
    );
    // Everyone 1–1 (three-way, no head-to-head). Set ratios: A 0/1, B 1/1, C 1/1.
    // B and C tie on set ratio; B is +6, C is −6 + 9 = +3 → B first. A's forfeit
    // win leaves it 0/1 on sets despite a differential (−9) not far behind C.
    expect(rows.map((r) => r.teamId)).toEqual([B, C, A]);
    expect(rows[2]).toMatchObject({ teamId: A, wins: 1, losses: 1, setsWon: 0, setsLost: 1, pointsFor: 12 });
  });

  it("rejects matches that reference teams outside the pool or an impossible winner", () => {
    expect(() =>
      computeStandings([A, B], [{ teamAId: A, teamBId: C, winnerTeamId: A, sets: [] }]),
    ).toThrow(/outside the pool/);
    expect(() =>
      computeStandings([A, B], [{ teamAId: A, teamBId: B, winnerTeamId: C, sets: [] }]),
    ).toThrow(/not a participant/);
  });
});

describe("tiebreak table", () => {
  const row = (teamId: string, patch: Partial<StandingRow>): StandingRow => ({
    teamId,
    played: 0,
    wins: 0,
    losses: 0,
    setsWon: 0,
    setsLost: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointDiff: 0,
    rank: 0,
    ...patch,
  });

  const cases: Array<{ name: string; key: (typeof TIEBREAK_ORDER)[number]; x: StandingRow; y: StandingRow; h2h?: StandingsMatch[] }> = [
    { name: "more wins first", key: "wins", x: row(A, { wins: 2, pointDiff: -30 }), y: row(B, { wins: 1, pointDiff: 40 }) },
    {
      name: "two-way tie on wins: head-to-head winner first",
      key: "head_to_head",
      x: row(A, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: -10 }),
      y: row(B, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: 10 }),
      h2h: [bo1(A, B, 21, 19)],
    },
    {
      name: "better set ratio first, before point differential",
      key: "set_ratio",
      x: row(A, { wins: 1, setsWon: 2, setsLost: 1, pointDiff: -5 }),
      y: row(B, { wins: 1, setsWon: 2, setsLost: 2, pointDiff: 20 }),
    },
    {
      name: "no sets lost beats any ratio",
      key: "set_ratio",
      x: row(A, { wins: 1, setsWon: 1, setsLost: 0, pointDiff: 1 }),
      y: row(B, { wins: 1, setsWon: 5, setsLost: 1, pointDiff: 50 }),
    },
    {
      name: "point differential",
      key: "point_diff",
      x: row(A, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: 3, pointsFor: 30 }),
      y: row(B, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: 2, pointsFor: 60 }),
    },
    {
      name: "points for",
      key: "points_for",
      x: row(A, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: 0, pointsFor: 42 }),
      y: row(B, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: 0, pointsFor: 41 }),
    },
    {
      name: "stable id last",
      key: "team_id",
      x: row(A, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: 0, pointsFor: 42 }),
      y: row(B, { wins: 1, setsWon: 1, setsLost: 1, pointDiff: 0, pointsFor: 42 }),
    },
  ];

  it.each(cases)("$name ($key)", ({ key, x, y, h2h }) => {
    const resolver = h2h ? headToHeadResolver([x, y], h2h) : undefined;
    expect(compareStandings(x, y, resolver)).toBeLessThan(0);
    expect(compareStandings(y, x, resolver)).toBeGreaterThan(0);
    if (key === "team_id") {
      // Tied on every sporting key: the id fixes order but the rank is shared.
      expect(compareStandingKeys(x, y, resolver)).toBe(0);
    } else {
      expect(compareStandingKeys(x, y, resolver)).toBeLessThan(0);
    }
  });

  it("ignores head-to-head when the tie is not exactly two-way", () => {
    const x = row(A, { wins: 1, pointDiff: -10 });
    const y = row(B, { wins: 1, pointDiff: 10 });
    const z = row(C, { wins: 1, pointDiff: 0 });
    const resolver = headToHeadResolver([x, y, z], [bo1(A, B, 21, 19)]);
    expect(resolver(A, B)).toBe(0);
    expect(compareStandings(x, y, resolver)).toBeGreaterThan(0);
  });

  it("head-to-head with more than one meeting uses net wins and falls through on a split", () => {
    const x = row(A, { wins: 2, pointDiff: -10 });
    const y = row(B, { wins: 2, pointDiff: 10 });
    const split = headToHeadResolver([x, y], [bo1(A, B, 21, 19), bo1(B, A, 21, 19)]);
    expect(split(A, B)).toBe(0);
    const swept = headToHeadResolver([x, y], [bo1(A, B, 21, 19), bo1(B, A, 19, 21), bo1(B, A, 21, 19)]);
    expect(swept(A, B)).toBe(-1);
    expect(swept(B, A)).toBe(1);
  });
});
