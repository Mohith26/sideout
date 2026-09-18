import "server-only";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getPoolStandings } from "@/db/queries/standings";
import { listUserTeams, type UserTeamView } from "@/db/queries/teams";
import { matches, pools, poolTeams, sets, teams, type MatchStatus } from "@/db/schema";
import { bracketRoundLabel } from "@/lib/rounds";

/**
 * A player's tournament history (spec §11.5), derived from their teams'
 * matches: record, pool finish, how far the bracket went, and each match as a
 * line with the opponent and the agreed sets. Nothing here is stored; a
 * placement is read off the bracket, not typed anywhere.
 */

export interface HistoryMatch {
  matchId: string;
  roundLabel: string;
  opponentName: string | null;
  status: MatchStatus;
  /** From this team's side. */
  sets: Array<{ mine: number; theirs: number }>;
  won: boolean | null;
  scheduledAt: number | null;
}

export interface TeamHistory extends UserTeamView {
  played: number;
  wins: number;
  losses: number;
  poolLabel: string | null;
  poolRank: number | null;
  /** Null until the team has appeared in a bracket match. */
  bracketRoundReached: string | null;
  champion: boolean;
  matches: HistoryMatch[];
}

const COUNTED: ReadonlySet<MatchStatus> = new Set(["final", "forfeited"]);

export function getUserHistory(userId: string): TeamHistory[] {
  const db = getDb();
  const userTeams = listUserTeams(userId);
  if (userTeams.length === 0) return [];
  const teamIds = userTeams.map((t) => t.team.id);
  const matchRows = db
    .select()
    .from(matches)
    .where(or(inArray(matches.teamAId, teamIds), inArray(matches.teamBId, teamIds)))
    .orderBy(asc(matches.scheduledAt), asc(matches.round), asc(matches.bracketPosition))
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
  const opponentIds = [...new Set(matchRows.flatMap((m) => [m.teamAId, m.teamBId]).filter((id): id is string => id !== null && !teamIds.includes(id)))];
  const opponentNames = new Map(
    (opponentIds.length ? db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, opponentIds)).all() : []).map((t) => [t.id, t.name]),
  );
  const poolRows = db
    .select({ teamId: poolTeams.teamId, poolId: pools.id, label: pools.label, tournamentId: pools.tournamentId })
    .from(poolTeams)
    .innerJoin(pools, eq(pools.id, poolTeams.poolId))
    .where(inArray(poolTeams.teamId, teamIds))
    .all();
  const bracketRoundsBy = new Map<string, number>();
  for (const t of userTeams) {
    if (bracketRoundsBy.has(t.tournament.id)) continue;
    const row = db
      .select({ rounds: sql<number>`coalesce(max(${matches.round}), 0)` })
      .from(matches)
      .where(and(eq(matches.tournamentId, t.tournament.id), isNull(matches.poolId)))
      .get();
    bracketRoundsBy.set(t.tournament.id, row?.rounds ?? 0);
  }
  const standingsCache = new Map<string, ReturnType<typeof getPoolStandings>>();

  return userTeams.map((view) => {
    const teamId = view.team.id;
    const mine = matchRows.filter((m) => m.teamAId === teamId || m.teamBId === teamId);
    const bracketRounds = bracketRoundsBy.get(view.tournament.id) ?? 0;
    const history: HistoryMatch[] = mine.map((m) => {
      const isA = m.teamAId === teamId;
      const opponentId = isA ? m.teamBId : m.teamAId;
      const agreed = m.status === "final" ? setRows.filter((s) => s.matchId === m.id) : [];
      return {
        matchId: m.id,
        roundLabel: m.poolId === null ? bracketRoundLabel(m.round, bracketRounds) : `Pool round ${m.round}`,
        opponentName: opponentId ? (opponentNames.get(opponentId) ?? null) : null,
        status: m.status,
        sets: agreed.map((s) => ({ mine: isA ? s.teamAPoints : s.teamBPoints, theirs: isA ? s.teamBPoints : s.teamAPoints })),
        won: m.winnerTeamId === null ? null : m.winnerTeamId === teamId,
        scheduledAt: m.scheduledAt,
      };
    });
    const counted = mine.filter((m) => COUNTED.has(m.status));
    const wins = counted.filter((m) => m.winnerTeamId === teamId).length;
    const pool = poolRows.find((p) => p.teamId === teamId);
    let poolRank: number | null = null;
    if (pool) {
      const standings = standingsCache.get(pool.tournamentId) ?? getPoolStandings(pool.tournamentId);
      standingsCache.set(pool.tournamentId, standings);
      poolRank = standings.find((s) => s.poolId === pool.poolId)?.rows.find((r) => r.teamId === teamId)?.rank ?? null;
    }
    const bracketAppearances = mine.filter((m) => m.poolId === null && m.status !== "bye");
    const deepest = bracketAppearances.length ? Math.max(...bracketAppearances.map((m) => m.round)) : null;
    const finalMatch = mine.find((m) => m.poolId === null && m.round === bracketRounds && bracketRounds > 0);
    return {
      ...view,
      played: counted.length,
      wins,
      losses: counted.length - wins,
      poolLabel: pool?.label ?? null,
      poolRank,
      bracketRoundReached: deepest === null ? null : bracketRoundLabel(deepest, bracketRounds),
      champion: finalMatch?.winnerTeamId === teamId,
      matches: history,
    };
  });
}
