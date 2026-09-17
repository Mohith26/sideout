import { describe, expect, it } from "vitest";
import { computeStandings } from "@/domain/standings";

const A = "team-a";
const B = "team-b";
const C = "team-c";
const D = "team-d";

describe("computeStandings", () => {
  it("ranks by wins, then point differential, then points for", () => {
    const rows = computeStandings(
      [A, B, C, D],
      [
        { teamAId: A, teamBId: B, winnerTeamId: A, sets: [{ teamAPoints: 21, teamBPoints: 15 }] },
        { teamAId: C, teamBId: D, winnerTeamId: C, sets: [{ teamAPoints: 21, teamBPoints: 19 }] },
        { teamAId: A, teamBId: C, winnerTeamId: C, sets: [{ teamAPoints: 18, teamBPoints: 21 }] },
        { teamAId: B, teamBId: D, winnerTeamId: D, sets: [{ teamAPoints: 12, teamBPoints: 21 }] },
        { teamAId: A, teamBId: D, winnerTeamId: A, sets: [{ teamAPoints: 21, teamBPoints: 10 }] },
        { teamAId: B, teamBId: C, winnerTeamId: C, sets: [{ teamAPoints: 20, teamBPoints: 22 }] },
      ],
    );
    expect(rows.map((r) => r.teamId)).toEqual([C, A, D, B]);
    const c = rows[0];
    expect(c).toMatchObject({ wins: 3, losses: 0, played: 3, pointsFor: 64, pointsAgainst: 57, pointDiff: 7, rank: 1 });
    const a = rows[1];
    expect(a).toMatchObject({ wins: 2, losses: 1, pointDiff: 21 - 15 + 18 - 21 + 21 - 10, rank: 2 });
    expect(rows[3]).toMatchObject({ teamId: B, wins: 0, rank: 4 });
  });

  it("shares a rank on a full tie and breaks by point differential otherwise", () => {
    const rows = computeStandings(
      [A, B, C],
      [
        { teamAId: A, teamBId: B, winnerTeamId: A, sets: [{ teamAPoints: 21, teamBPoints: 10 }] },
        { teamAId: B, teamBId: C, winnerTeamId: B, sets: [{ teamAPoints: 21, teamBPoints: 10 }] },
        { teamAId: C, teamBId: A, winnerTeamId: C, sets: [{ teamAPoints: 21, teamBPoints: 10 }] },
      ],
    );
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 1]);

    const broken = computeStandings(
      [A, B, C],
      [
        { teamAId: A, teamBId: B, winnerTeamId: A, sets: [{ teamAPoints: 21, teamBPoints: 10 }] },
        { teamAId: B, teamBId: C, winnerTeamId: B, sets: [{ teamAPoints: 21, teamBPoints: 15 }] },
        { teamAId: C, teamBId: A, winnerTeamId: C, sets: [{ teamAPoints: 21, teamBPoints: 19 }] },
      ],
    );
    // A +9, C -4, B -5 on point differential with everyone at one win.
    expect(broken.map((r) => r.teamId)).toEqual([A, C, B]);
    expect(broken.map((r) => r.rank)).toEqual([1, 2, 3]);
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
