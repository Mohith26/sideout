/**
 * Pool standings with point-differential tiebreaks (spec §11.2). Pure. Phase 2
 * extends this with head-to-head and the full draw engine; phase 1 needs it so
 * bracket seeding in the seed follows from pool results rather than being typed.
 */

export interface StandingsMatch {
  teamAId: string;
  teamBId: string;
  winnerTeamId: string;
  sets: ReadonlyArray<{ teamAPoints: number; teamBPoints: number }>;
}

export interface StandingRow {
  teamId: string;
  played: number;
  wins: number;
  losses: number;
  setsWon: number;
  setsLost: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  rank: number;
}

function emptyRow(teamId: string): StandingRow {
  return {
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
  };
}

/**
 * Order: wins desc, point differential desc, points for desc, then team id so
 * the order is total and deterministic. Ties in every key share a rank.
 */
export function compareStandings(x: StandingRow, y: StandingRow): number {
  if (y.wins !== x.wins) return y.wins - x.wins;
  if (y.pointDiff !== x.pointDiff) return y.pointDiff - x.pointDiff;
  if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
  return x.teamId < y.teamId ? -1 : x.teamId > y.teamId ? 1 : 0;
}

export function computeStandings(teamIds: readonly string[], matches: readonly StandingsMatch[]): StandingRow[] {
  const rows = new Map<string, StandingRow>(teamIds.map((id) => [id, emptyRow(id)]));

  for (const m of matches) {
    const a = rows.get(m.teamAId);
    const b = rows.get(m.teamBId);
    if (!a || !b) throw new Error(`standings: match references a team outside the pool (${m.teamAId} vs ${m.teamBId})`);
    if (m.winnerTeamId !== m.teamAId && m.winnerTeamId !== m.teamBId) {
      throw new Error(`standings: winner ${m.winnerTeamId} is not a participant`);
    }
    a.played += 1;
    b.played += 1;
    if (m.winnerTeamId === m.teamAId) {
      a.wins += 1;
      b.losses += 1;
    } else {
      b.wins += 1;
      a.losses += 1;
    }
    for (const s of m.sets) {
      a.pointsFor += s.teamAPoints;
      a.pointsAgainst += s.teamBPoints;
      b.pointsFor += s.teamBPoints;
      b.pointsAgainst += s.teamAPoints;
      if (s.teamAPoints > s.teamBPoints) {
        a.setsWon += 1;
        b.setsLost += 1;
      } else if (s.teamBPoints > s.teamAPoints) {
        b.setsWon += 1;
        a.setsLost += 1;
      }
    }
  }

  const out = [...rows.values()].map((r) => ({ ...r, pointDiff: r.pointsFor - r.pointsAgainst }));
  out.sort(compareStandings);
  let rank = 0;
  for (let i = 0; i < out.length; i += 1) {
    const row = out[i];
    const prev = out[i - 1];
    if (!row) continue;
    const tied =
      prev !== undefined &&
      prev.wins === row.wins &&
      prev.pointDiff === row.pointDiff &&
      prev.pointsFor === row.pointsFor;
    rank = tied ? rank : i + 1;
    row.rank = rank;
  }
  return out;
}
