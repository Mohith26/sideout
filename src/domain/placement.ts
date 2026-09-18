import type { MatchStatus } from "@/db/schema";
import { compareAcrossPools, type StandingRow } from "@/domain/standings";

/**
 * Final placements for the close preview (spec §11.6): the standings that are
 * frozen before an organizer commits to settlement. Pure.
 *
 * With a bracket, placement follows elimination: the final's winner is 1st,
 * its loser 2nd, the semifinal losers share 3rd, the quarterfinal losers share
 * 5th, and so on (standard competition ranking, so the next placement after a
 * shared one skips). Teams that did not reach the bracket follow, ordered by
 * their pool finish and then the cross-pool order from `@/domain/standings`,
 * each with its own placement. Without a bracket (round robin, or a
 * pool-to-bracket event whose bracket was never seeded), pool rank is the
 * placement for a single pool, and the same pool-finish-then-cross-pool order
 * applies across several.
 *
 * Byes eliminate nobody. A forfeit places its loser like a played loss.
 */

export interface PlacementMatch {
  id: string;
  poolId: string | null;
  round: number;
  bracketPosition: number | null;
  teamAId: string | null;
  teamBId: string | null;
  status: MatchStatus;
  winnerTeamId: string | null;
}

export interface PlacementPool {
  poolId: string;
  label: string;
  rows: readonly StandingRow[];
}

export interface PlacementInput {
  /** Every entrant that should appear: registered or checked-in teams. */
  teamIds: readonly string[];
  matches: readonly PlacementMatch[];
  pools: readonly PlacementPool[];
}

export type PlacementBasis = "bracket" | "pool" | "unplayed";

export interface Placement {
  placement: number;
  teamId: string;
  basis: PlacementBasis;
  /** "Won the final", "Lost in the semifinals", "3rd in Pool B". */
  detail: string;
}

const DECIDED: ReadonlySet<MatchStatus> = new Set(["final", "forfeited"]);

function roundName(round: number, rounds: number): string {
  const remaining = rounds - round;
  if (remaining === 0) return "the final";
  if (remaining === 1) return "the semifinals";
  if (remaining === 2) return "the quarterfinals";
  return `the round of ${2 ** (remaining + 1)}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function loserOf(m: PlacementMatch): string | null {
  if (!DECIDED.has(m.status) || !m.winnerTeamId || !m.teamAId || !m.teamBId) return null;
  return m.winnerTeamId === m.teamAId ? m.teamBId : m.teamAId;
}

/** Pool finishers not yet placed, best first: pool rank, then the cross-pool order. */
function poolOrder(pools: readonly PlacementPool[], exclude: ReadonlySet<string>): Array<{ row: StandingRow; pool: PlacementPool }> {
  const rows: Array<{ row: StandingRow; pool: PlacementPool }> = [];
  for (const pool of pools) for (const row of pool.rows) if (!exclude.has(row.teamId)) rows.push({ row, pool });
  return rows.sort((x, y) => x.row.rank - y.row.rank || compareAcrossPools(x.row, y.row));
}

export function computePlacements(input: PlacementInput): Placement[] {
  const out: Placement[] = [];
  const placed = new Set<string>();
  const place = (teamId: string, placement: number, basis: PlacementBasis, detail: string) => {
    if (placed.has(teamId)) return;
    placed.add(teamId);
    out.push({ placement, teamId, basis, detail });
  };

  const bracket = input.matches.filter((m) => m.poolId === null && m.bracketPosition !== null);
  if (bracket.length > 0) {
    const rounds = Math.max(...bracket.map((m) => m.round));
    const finalMatch = bracket.find((m) => m.round === rounds);
    if (finalMatch && DECIDED.has(finalMatch.status) && finalMatch.winnerTeamId) {
      place(finalMatch.winnerTeamId, 1, "bracket", finalMatch.status === "forfeited" ? "Won the final by forfeit" : "Won the final");
      const runnerUp = loserOf(finalMatch);
      if (runnerUp) place(runnerUp, 2, "bracket", "Lost the final");
    }
    for (let round = rounds - 1; round >= 1; round -= 1) {
      const losers = bracket
        .filter((m) => m.round === round)
        .map(loserOf)
        .filter((id): id is string => id !== null)
        .sort();
      const placement = placed.size + 1;
      for (const teamId of losers) place(teamId, placement, "bracket", `Lost in ${roundName(round, rounds)}`);
    }
    // A bracket team with no decided match (a bye into an unplayed round) has no elimination to place by.
    const unplaced = [...new Set(bracket.flatMap((m) => [m.teamAId, m.teamBId]))].filter((id): id is string => id !== null && !placed.has(id)).sort();
    for (const teamId of unplaced) place(teamId, placed.size + 1, "unplayed", "Bracket match not played");
  }

  const fromPools = poolOrder(input.pools, placed);
  if (bracket.length === 0 && input.pools.length === 1) {
    // Round robin: the pool table is the final table, shared ranks included.
    for (const { row, pool } of fromPools) place(row.teamId, row.rank, "pool", `${ordinal(row.rank)} in ${pool.label}`);
  } else {
    for (const { row, pool } of fromPools) place(row.teamId, placed.size + 1, "pool", `${ordinal(row.rank)} in ${pool.label}`);
  }

  for (const teamId of [...input.teamIds].sort()) place(teamId, placed.size + 1, "unplayed", "Did not play");

  return out.sort((x, y) => x.placement - y.placement || x.teamId.localeCompare(y.teamId));
}
