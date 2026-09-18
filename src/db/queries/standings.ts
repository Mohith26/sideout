import "server-only";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { matches, pools, poolTeams, sets } from "@/db/schema";
import { computeStandings, type StandingRow, type StandingsMatch } from "@/domain/standings";

/**
 * Pool standings, computed from rows on every read (spec §9: "computed,
 * cacheable 10s"). Wins come from `matches.winner_team_id` on `final` and
 * `forfeited` matches; sets and points from `sets` rows marked `agreed`, which
 * only the consensus state machine (and the seed) writes. A forfeit counts as
 * a win with no sets. Nothing is stored pre-aggregated.
 */

export interface PoolStandings {
  poolId: string;
  label: string;
  courtLabel: string;
  rows: StandingRow[];
  /** Matches counted so far / matches in the pool. */
  played: number;
  total: number;
}

export function getPoolStandings(tournamentId: string): PoolStandings[] {
  const db = getDb();
  const poolRows = db.select().from(pools).where(eq(pools.tournamentId, tournamentId)).orderBy(asc(pools.label)).all();
  if (poolRows.length === 0) return [];
  const poolIds = poolRows.map((p) => p.id);

  const membership = db.select().from(poolTeams).where(inArray(poolTeams.poolId, poolIds)).all();
  const matchRows = db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), isNotNull(matches.poolId)))
    .all();
  const setRows = matchRows.length
    ? db
        .select()
        .from(sets)
        .where(
          and(
            inArray(
              sets.matchId,
              matchRows.map((m) => m.id),
            ),
            eq(sets.agreed, true),
          ),
        )
        .orderBy(asc(sets.setNumber))
        .all()
    : [];
  const setsBy = new Map<string, Array<{ teamAPoints: number; teamBPoints: number }>>();
  for (const s of setRows) {
    const list = setsBy.get(s.matchId) ?? [];
    list.push({ teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints });
    setsBy.set(s.matchId, list);
  }

  return poolRows.map((pool) => {
    const teamIds = membership.filter((pt) => pt.poolId === pool.id).map((pt) => pt.teamId);
    const inPool = matchRows.filter((m) => m.poolId === pool.id);
    const counted: StandingsMatch[] = [];
    for (const m of inPool) {
      if ((m.status !== "final" && m.status !== "forfeited") || !m.teamAId || !m.teamBId || !m.winnerTeamId) continue;
      counted.push({ teamAId: m.teamAId, teamBId: m.teamBId, winnerTeamId: m.winnerTeamId, sets: m.status === "final" ? (setsBy.get(m.id) ?? []) : [] });
    }
    return {
      poolId: pool.id,
      label: pool.label,
      courtLabel: pool.courtLabel,
      rows: computeStandings(teamIds, counted),
      played: counted.length,
      total: inPool.length,
    };
  });
}
