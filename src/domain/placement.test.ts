import { describe, expect, it } from "vitest";
import { computePlacements, type PlacementMatch, type PlacementPool } from "@/domain/placement";
import { computeStandings } from "@/domain/standings";

const bracketMatch = (id: string, round: number, pos: number, a: string | null, b: string | null, winner: string | null, status: PlacementMatch["status"] = "final"): PlacementMatch => ({
  id,
  poolId: null,
  round,
  bracketPosition: pos,
  teamAId: a,
  teamBId: b,
  status,
  winnerTeamId: winner,
});

const poolMatch = (id: string, poolId: string, a: string, b: string, winner: string): PlacementMatch => ({
  id,
  poolId,
  round: 1,
  bracketPosition: null,
  teamAId: a,
  teamBId: b,
  status: "final",
  winnerTeamId: winner,
});

const set = (a: number, b: number) => ({ teamAPoints: a, teamBPoints: b });

describe("computePlacements", () => {
  it("places a single-elimination bracket by round of elimination with shared placements", () => {
    // Eight teams, three rounds: t1 beats everyone; t8 had a bye into the semis and lost there.
    const matches = [
      bracketMatch("q1", 1, 1, "t1", "t2", "t1"),
      bracketMatch("q2", 1, 2, "t3", "t4", "t4"),
      bracketMatch("q3", 1, 3, "t5", "t6", "t5", "forfeited"),
      bracketMatch("q4", 1, 4, "t8", null, "t8", "bye"),
      bracketMatch("s1", 2, 5, "t1", "t4", "t1"),
      bracketMatch("s2", 2, 6, "t5", "t8", "t5"),
      bracketMatch("f", 3, 7, "t1", "t5", "t1"),
    ];
    const out = computePlacements({ teamIds: ["t1", "t2", "t3", "t4", "t5", "t6", "t8"], matches, pools: [] });
    expect(out.map((p) => [p.placement, p.teamId])).toEqual([
      [1, "t1"],
      [2, "t5"],
      [3, "t4"],
      [3, "t8"],
      [5, "t2"],
      [5, "t3"],
      [5, "t6"],
    ]);
    expect(out.find((p) => p.teamId === "t1")?.detail).toBe("Won the final");
    expect(out.find((p) => p.teamId === "t8")?.detail).toBe("Lost in the semifinals");
    expect(out.find((p) => p.teamId === "t6")?.detail).toBe("Lost in the quarterfinals");
    expect(out.every((p) => p.basis === "bracket")).toBe(true);
  });

  it("places nobody by elimination until the final is decided: every bracket team is unplayed", () => {
    // Quarterfinals done, one semifinal decided, the other on the sand, the final waiting on it.
    const matches = [
      bracketMatch("q1", 1, 1, "t1", "t2", "t1"),
      bracketMatch("q2", 1, 2, "t3", "t4", "t4"),
      bracketMatch("q3", 1, 3, "t5", "t6", "t5", "forfeited"),
      bracketMatch("q4", 1, 4, "t7", "t8", "t8"),
      bracketMatch("s1", 2, 5, "t1", "t4", "t1"),
      bracketMatch("s2", 2, 6, "t5", "t8", null, "in_progress"),
      bracketMatch("f", 3, 7, "t1", null, null, "scheduled"),
    ];
    const pool: PlacementPool = {
      poolId: "p",
      label: "Pool A",
      rows: computeStandings(
        ["t1", "t9"],
        [{ teamAId: "t1", teamBId: "t9", winnerTeamId: "t1", sets: [set(21, 15)] }],
      ),
    };
    const out = computePlacements({ teamIds: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"], matches, pools: [pool] });
    const bracketTeams = out.filter((p) => p.teamId !== "t9");
    expect(bracketTeams.every((p) => p.basis === "unplayed" && p.detail === "Bracket not decided")).toBe(true);
    expect(out.some((p) => p.basis === "bracket")).toBe(false);
    // No quarterfinal or semifinal loser is ranked above the teams still playing.
    expect(bracketTeams.map((p) => [p.placement, p.teamId])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, `t${n}`]));
    expect(out.find((p) => p.teamId === "t9")).toMatchObject({ placement: 9, basis: "pool", detail: "2nd in Pool A" });
  });

  it("follows the bracket with pool non-advancers by pool finish, then cross-pool order", () => {
    // Two pools of three; the winners meet in a one-match bracket.
    const poolA: PlacementPool = {
      poolId: "pa",
      label: "Pool A",
      rows: computeStandings(
        ["a1", "a2", "a3"],
        [
          { teamAId: "a1", teamBId: "a2", winnerTeamId: "a1", sets: [set(21, 15)] },
          { teamAId: "a1", teamBId: "a3", winnerTeamId: "a1", sets: [set(21, 10)] },
          { teamAId: "a2", teamBId: "a3", winnerTeamId: "a2", sets: [set(21, 19)] },
        ],
      ),
    };
    const poolB: PlacementPool = {
      poolId: "pb",
      label: "Pool B",
      rows: computeStandings(
        ["b1", "b2", "b3"],
        [
          { teamAId: "b1", teamBId: "b2", winnerTeamId: "b1", sets: [set(21, 12)] },
          { teamAId: "b1", teamBId: "b3", winnerTeamId: "b1", sets: [set(21, 18)] },
          { teamAId: "b2", teamBId: "b3", winnerTeamId: "b2", sets: [set(21, 8)] },
        ],
      ),
    };
    const matches = [
      poolMatch("pa1", "pa", "a1", "a2", "a1"),
      poolMatch("pa2", "pa", "a1", "a3", "a1"),
      poolMatch("pa3", "pa", "a2", "a3", "a2"),
      poolMatch("pb1", "pb", "b1", "b2", "b1"),
      poolMatch("pb2", "pb", "b1", "b3", "b1"),
      poolMatch("pb3", "pb", "b2", "b3", "b2"),
      bracketMatch("f", 1, 1, "a1", "b1", "b1"),
    ];
    const out = computePlacements({ teamIds: ["a1", "a2", "a3", "b1", "b2", "b3"], matches, pools: [poolA, poolB] });
    // Runners-up by cross-pool order: b2 (+13 point diff over 2 matches) ahead of a2 (+4); thirds: a3 (−13) ahead of b3 (−16).
    expect(out.map((p) => [p.placement, p.teamId])).toEqual([
      [1, "b1"],
      [2, "a1"],
      [3, "b2"],
      [4, "a2"],
      [5, "a3"],
      [6, "b3"],
    ]);
    expect(out.find((p) => p.teamId === "b2")).toMatchObject({ basis: "pool", detail: "2nd in Pool B" });
  });

  it("uses pool rank, ties included, as the placement for a round robin", () => {
    const pool: PlacementPool = {
      poolId: "p",
      label: "Pool A",
      rows: computeStandings(
        ["x", "y", "z"],
        [
          { teamAId: "x", teamBId: "y", winnerTeamId: "x", sets: [set(21, 15)] },
          { teamAId: "y", teamBId: "z", winnerTeamId: "y", sets: [set(21, 15)] },
          { teamAId: "z", teamBId: "x", winnerTeamId: "z", sets: [set(21, 15)] },
        ],
      ),
    };
    const out = computePlacements({ teamIds: ["x", "y", "z"], matches: [], pools: [pool] });
    expect(out.map((p) => p.placement)).toEqual([1, 1, 1]);
    expect(out.map((p) => p.teamId)).toEqual(["x", "y", "z"]);
  });

  it("places entrants that never played last, and a bracket team with no decided match as unplayed", () => {
    const matches = [bracketMatch("f", 1, 1, "t1", "t2", null, "scheduled")];
    const out = computePlacements({ teamIds: ["t1", "t2", "t3"], matches, pools: [] });
    expect(out.map((p) => [p.placement, p.teamId, p.basis])).toEqual([
      [1, "t1", "unplayed"],
      [2, "t2", "unplayed"],
      [3, "t3", "unplayed"],
    ]);
    expect(out[2]?.detail).toBe("Did not play");
  });
});
