import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  charities,
  donations,
  matches,
  pools,
  poolTeams,
  sets,
  sponsors,
  teamMembers,
  teams,
  tournaments,
  users,
  type Charity,
  type Match,
  type MatchStatus,
  type SetRow,
  type Sponsor,
  type Team,
  type Tournament,
} from "@/db/schema";

/**
 * Read models for the public screens. Every figure the UI shows is computed
 * here from rows — impact totals are sums of `succeeded` donations, capacity is
 * a count of non-withdrawn teams, and so on. Nothing is stored pre-aggregated.
 */

export interface TournamentSummary {
  tournament: Tournament;
  charity: Charity;
  /** Registered or checked-in teams; withdrawn teams do not count toward capacity. */
  activeTeams: number;
  raisedCents: number;
  donorCount: number;
  sponsorCount: number;
  liveMatchCount: number;
}

const succeededSum = sql<number>`coalesce(sum(case when ${donations.status} = 'succeeded' then ${donations.amountCents} else 0 end), 0)`;

export function listTournamentSummaries(): TournamentSummary[] {
  const db = getDb();
  const rows = db
    .select({ tournament: tournaments, charity: charities })
    .from(tournaments)
    .innerJoin(charities, eq(charities.id, tournaments.beneficiaryId))
    .orderBy(asc(tournaments.startsAt))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.tournament.id);

  const teamCounts = db
    .select({ tournamentId: teams.tournamentId, n: sql<number>`count(*)` })
    .from(teams)
    .where(and(inArray(teams.tournamentId, ids), sql`${teams.status} <> 'withdrawn'`))
    .groupBy(teams.tournamentId)
    .all();
  const donationAgg = db
    .select({
      tournamentId: donations.tournamentId,
      raised: succeededSum,
      donors: sql<number>`count(case when ${donations.status} = 'succeeded' then 1 end)`,
    })
    .from(donations)
    .where(inArray(donations.tournamentId, ids))
    .groupBy(donations.tournamentId)
    .all();
  const sponsorCounts = db
    .select({ tournamentId: sponsors.tournamentId, n: sql<number>`count(*)` })
    .from(sponsors)
    .where(inArray(sponsors.tournamentId, ids))
    .groupBy(sponsors.tournamentId)
    .all();
  const liveCounts = db
    .select({ tournamentId: matches.tournamentId, n: sql<number>`count(*)` })
    .from(matches)
    .where(and(inArray(matches.tournamentId, ids), eq(matches.status, "in_progress")))
    .groupBy(matches.tournamentId)
    .all();

  const by = <T extends { tournamentId: string }>(list: T[]) => new Map(list.map((x) => [x.tournamentId, x]));
  const teamsBy = by(teamCounts);
  const donationsBy = by(donationAgg);
  const sponsorsBy = by(sponsorCounts);
  const liveBy = by(liveCounts);

  return rows.map(({ tournament, charity }) => ({
    tournament,
    charity,
    activeTeams: teamsBy.get(tournament.id)?.n ?? 0,
    raisedCents: donationsBy.get(tournament.id)?.raised ?? 0,
    donorCount: donationsBy.get(tournament.id)?.donors ?? 0,
    sponsorCount: sponsorsBy.get(tournament.id)?.n ?? 0,
    liveMatchCount: liveBy.get(tournament.id)?.n ?? 0,
  }));
}

export function getTournamentSummaryBySlug(slug: string): TournamentSummary | null {
  return listTournamentSummaries().find((s) => s.tournament.slug === slug) ?? null;
}

// ---------------------------------------------------------------------------
// Matches with participants
// ---------------------------------------------------------------------------

export interface TeamWithMembers extends Team {
  members: Array<{ userId: string; displayName: string; role: "captain" | "player" }>;
}

export interface MatchView {
  match: Match;
  teamA: TeamWithMembers | null;
  teamB: TeamWithMembers | null;
  sets: SetRow[];
  poolLabel: string | null;
}

export function listTeamsWithMembers(tournamentId: string): TeamWithMembers[] {
  const db = getDb();
  const teamRows = db.select().from(teams).where(eq(teams.tournamentId, tournamentId)).orderBy(asc(teams.createdAt)).all();
  if (teamRows.length === 0) return [];
  const memberRows = db
    .select({ teamId: teamMembers.teamId, userId: teamMembers.userId, role: teamMembers.role, displayName: users.displayName })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      inArray(
        teamMembers.teamId,
        teamRows.map((t) => t.id),
      ),
    )
    .all();
  const membersBy = new Map<string, TeamWithMembers["members"]>();
  for (const m of memberRows) {
    const list = membersBy.get(m.teamId) ?? [];
    list.push({ userId: m.userId, displayName: m.displayName, role: m.role });
    membersBy.set(m.teamId, list);
  }
  return teamRows.map((t) => ({
    ...t,
    members: (membersBy.get(t.id) ?? []).sort((x, y) => (x.role === "captain" ? -1 : y.role === "captain" ? 1 : 0)),
  }));
}

export function listMatches(tournamentId: string, statuses?: readonly MatchStatus[]): MatchView[] {
  const db = getDb();
  const where = statuses
    ? and(eq(matches.tournamentId, tournamentId), inArray(matches.status, [...statuses]))
    : eq(matches.tournamentId, tournamentId);
  const matchRows = db
    .select({ match: matches, poolLabel: pools.label })
    .from(matches)
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .where(where)
    .orderBy(asc(matches.round), asc(matches.bracketPosition), asc(matches.scheduledAt))
    .all();
  if (matchRows.length === 0) return [];

  const teamsById = new Map(listTeamsWithMembers(tournamentId).map((t) => [t.id, t]));
  const setRows = db
    .select()
    .from(sets)
    .where(
      inArray(
        sets.matchId,
        matchRows.map((m) => m.match.id),
      ),
    )
    .orderBy(asc(sets.setNumber))
    .all();
  const setsBy = new Map<string, SetRow[]>();
  for (const s of setRows) {
    const list = setsBy.get(s.matchId) ?? [];
    list.push(s);
    setsBy.set(s.matchId, list);
  }

  return matchRows.map(({ match, poolLabel }) => ({
    match,
    poolLabel,
    teamA: match.teamAId ? (teamsById.get(match.teamAId) ?? null) : null,
    teamB: match.teamBId ? (teamsById.get(match.teamBId) ?? null) : null,
    sets: setsBy.get(match.id) ?? [],
  }));
}

/** Number of bracket rounds a tournament has (0 before a draw exists). */
export function getBracketRoundCount(tournamentId: string): number {
  const row = getDb()
    .select({ rounds: sql<number>`coalesce(max(${matches.round}), 0)` })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), sql`${matches.poolId} IS NULL`))
    .get();
  return row?.rounds ?? 0;
}

/** Matches that are on the sand or waiting for a result right now. */
export function listLiveMatches(tournamentId: string): MatchView[] {
  const order: Record<string, number> = { in_progress: 0, awaiting_scores: 1, disputed: 2 };
  return listMatches(tournamentId, ["in_progress", "awaiting_scores", "disputed"]).sort(
    (x, y) => (order[x.match.status] ?? 9) - (order[y.match.status] ?? 9) || (x.match.scheduledAt ?? 0) - (y.match.scheduledAt ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface PoolView {
  id: string;
  label: string;
  courtLabel: string;
  teams: TeamWithMembers[];
}

export interface RoundView {
  key: string;
  label: string;
  /** Earliest scheduled time across the round. */
  startsAt: number | null;
  courts: string[];
  total: number;
  byStatus: Partial<Record<MatchStatus, number>>;
}

export interface TournamentOverview {
  pools: PoolView[];
  courts: string[];
  rounds: RoundView[];
  sponsors: Sponsor[];
  matchCount: number;
}

export function bracketRoundLabel(round: number, totalBracketRounds: number): string {
  const remaining = totalBracketRounds - round;
  if (remaining === 0) return "Final";
  if (remaining === 1) return "Semifinals";
  if (remaining === 2) return "Quarterfinals";
  return `Round of ${2 ** (remaining + 1)}`;
}

export function getTournamentOverview(tournamentId: string): TournamentOverview {
  const db = getDb();
  const poolRows = db.select().from(pools).where(eq(pools.tournamentId, tournamentId)).orderBy(asc(pools.label)).all();
  const teamsById = new Map(listTeamsWithMembers(tournamentId).map((t) => [t.id, t]));
  const poolTeamRows = poolRows.length
    ? db
        .select()
        .from(poolTeams)
        .where(
          inArray(
            poolTeams.poolId,
            poolRows.map((p) => p.id),
          ),
        )
        .all()
    : [];
  const poolViews: PoolView[] = poolRows.map((p) => ({
    id: p.id,
    label: p.label,
    courtLabel: p.courtLabel,
    teams: poolTeamRows
      .filter((pt) => pt.poolId === p.id)
      .map((pt) => teamsById.get(pt.teamId))
      .filter((t): t is TeamWithMembers => t !== undefined),
  }));

  const all = listMatches(tournamentId);
  const courts = [...new Set([...poolRows.map((p) => p.courtLabel), ...all.map((m) => m.match.courtLabel ?? "")])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const poolMatches = all.filter((m) => m.match.poolId !== null);
  const bracket = all.filter((m) => m.match.poolId === null);
  const bracketRounds = bracket.length ? Math.max(...bracket.map((m) => m.match.round)) : 0;

  const rounds: RoundView[] = [];
  const groupInto = (key: string, label: string, list: MatchView[]) => {
    if (list.length === 0) return;
    const byStatus: Partial<Record<MatchStatus, number>> = {};
    for (const m of list) byStatus[m.match.status] = (byStatus[m.match.status] ?? 0) + 1;
    const times = list.map((m) => m.match.scheduledAt).filter((t): t is number => t !== null);
    rounds.push({
      key,
      label,
      startsAt: times.length ? Math.min(...times) : null,
      courts: [...new Set(list.map((m) => m.match.courtLabel).filter((c): c is string => Boolean(c)))].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
      total: list.length,
      byStatus,
    });
  };
  const poolRoundNumbers = [...new Set(poolMatches.map((m) => m.match.round))].sort((a, b) => a - b);
  for (const r of poolRoundNumbers) {
    groupInto(
      `pool-${r}`,
      `Pool play · round ${r}`,
      poolMatches.filter((m) => m.match.round === r),
    );
  }
  for (let r = 1; r <= bracketRounds; r += 1) {
    groupInto(
      `bracket-${r}`,
      bracketRoundLabel(r, bracketRounds),
      bracket.filter((m) => m.match.round === r),
    );
  }

  const sponsorRows = db.select().from(sponsors).where(eq(sponsors.tournamentId, tournamentId)).all();

  return { pools: poolViews, courts, rounds, sponsors: sortSponsors(sponsorRows), matchCount: all.length };
}

const TIER_ORDER: Record<Sponsor["tier"], number> = { presenting: 0, court: 1, prize: 2 };
export function sortSponsors(list: Sponsor[]): Sponsor[] {
  return [...list].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.prizeContributionCents - a.prizeContributionCents);
}
