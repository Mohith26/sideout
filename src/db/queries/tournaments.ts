import "server-only";
import { cache } from "react";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  charities,
  donations,
  matchConsensus,
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
  type ConsensusState,
  type Match,
  type MatchStatus,
  type SetRow,
  type Sponsor,
  type SponsorTier,
  type Team,
  type Tournament,
  type TournamentStatus,
} from "@/db/schema";
import { getPoolStandings, type PoolStandings } from "@/db/queries/standings";
import { UNLISTED_TEAM_STATUSES } from "@/db/queries/teams";
import { bracketRoundLabel } from "@/lib/rounds";

/**
 * Read models for the public screens. Every figure the UI shows is computed
 * here from rows — impact totals are sums of `succeeded` donations, capacity is
 * a count of non-withdrawn teams, and so on. Nothing is stored pre-aggregated.
 */

/** A draft is unpublished: nothing public lists it, links to it, or counts its goal. */
export const UNPUBLISHED_STATUS: TournamentStatus = "draft";
export function isPublished(status: TournamentStatus): boolean {
  return status !== UNPUBLISHED_STATUS;
}

export interface TournamentSummary {
  tournament: Tournament;
  charity: Charity;
  /** Registered or checked-in teams; forming and withdrawn teams do not count toward capacity. */
  activeTeams: number;
  raisedCents: number;
  donorCount: number;
  sponsorCount: number;
  liveMatchCount: number;
}

const succeededSum = sql<number>`coalesce(sum(case when ${donations.status} = 'succeeded' then ${donations.amountCents} else 0 end), 0)`;

function summarize(where: SQL | undefined): TournamentSummary[] {
  const db = getDb();
  const rows = db
    .select({ tournament: tournaments, charity: charities })
    .from(tournaments)
    .innerJoin(charities, eq(charities.id, tournaments.beneficiaryId))
    .where(where)
    .orderBy(asc(tournaments.startsAt))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.tournament.id);

  const teamCounts = db
    .select({ tournamentId: teams.tournamentId, n: sql<number>`count(*)` })
    .from(teams)
    .where(and(inArray(teams.tournamentId, ids), inArray(teams.status, ["registered", "checked_in"])))
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

export function listTournamentSummaries(statuses?: readonly TournamentStatus[]): TournamentSummary[] {
  return summarize(statuses && statuses.length > 0 ? inArray(tournaments.status, [...statuses]) : undefined);
}

export function getTournamentSummaryById(id: string): TournamentSummary | null {
  return summarize(eq(tournaments.id, id))[0] ?? null;
}

/**
 * One request renders the `[slug]` layout, its metadata and a tab page, each of
 * which needs the same summary; `cache` shares one read across them.
 */
export const getTournamentSummaryBySlug = cache((slug: string): TournamentSummary | null => {
  return summarize(eq(tournaments.slug, slug))[0] ?? null;
});

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

/**
 * The tournament row as the public routes serialize it: every Lucra identifier
 * stays on the server (spec §9, "never leak Lucra internals"), as do the
 * organizer's draw configuration and the frozen close preview — both are
 * organizer inputs and outputs, read by the organizer routes and pages from
 * the full row, and the standings and rewards they contain are served by their
 * own public reads. Organizer routes return the full row.
 */
export type PublicTournament = Omit<Tournament, "lucraMatchupId" | "lucraExternalId" | "lucraGameId" | "lucraLocationId" | "drawConfigJson" | "closePreviewJson">;
export type PublicTournamentSummary = Omit<TournamentSummary, "tournament"> & { tournament: PublicTournament };

export function publicTournament(t: Tournament): PublicTournament {
  const { lucraMatchupId: _matchup, lucraExternalId: _external, lucraGameId: _game, lucraLocationId: _location, drawConfigJson: _draw, closePreviewJson: _close, ...rest } = t;
  return rest;
}

export function publicSummary<T extends TournamentSummary>(summary: T): Omit<T, "tournament"> & { tournament: PublicTournament } {
  return { ...summary, tournament: publicTournament(summary.tournament) };
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

/** One match with everything a match screen or `GET /api/matches/:id` shows. */
export interface MatchDetail extends MatchView {
  tournament: Pick<Tournament, "id" | "slug" | "name" | "status" | "venueTimezone">;
  consensusState: ConsensusState | null;
  /** Seat this match feeds, for the bracket view. */
  next: { matchId: string; slot: "a" | "b"; bracketPosition: number | null } | null;
}

export function getMatchDetail(matchId: string): MatchDetail | null {
  const db = getDb();
  const row = db
    .select({ match: matches, tournament: tournaments, poolLabel: pools.label })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .where(eq(matches.id, matchId))
    .get();
  if (!row) return null;
  const teamsById = new Map(listTeamsWithMembers(row.tournament.id).map((t) => [t.id, t]));
  const setRows = db.select().from(sets).where(eq(sets.matchId, matchId)).orderBy(asc(sets.setNumber)).all();
  const consensus = db.select({ state: matchConsensus.state }).from(matchConsensus).where(eq(matchConsensus.matchId, matchId)).get();
  const nextRow = row.match.nextMatchId
    ? db.select({ id: matches.id, bracketPosition: matches.bracketPosition }).from(matches).where(eq(matches.id, row.match.nextMatchId)).get()
    : undefined;
  return {
    match: row.match,
    poolLabel: row.poolLabel,
    teamA: row.match.teamAId ? (teamsById.get(row.match.teamAId) ?? null) : null,
    teamB: row.match.teamBId ? (teamsById.get(row.match.teamBId) ?? null) : null,
    sets: setRows,
    tournament: {
      id: row.tournament.id,
      slug: row.tournament.slug,
      name: row.tournament.name,
      status: row.tournament.status,
      venueTimezone: row.tournament.venueTimezone,
    },
    consensusState: consensus?.state ?? null,
    next:
      nextRow && row.match.nextMatchSlot ? { matchId: nextRow.id, slot: row.match.nextMatchSlot, bracketPosition: nextRow.bracketPosition } : null,
  };
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

export { bracketRoundLabel };

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

// ---------------------------------------------------------------------------
// Detail: everything `GET /api/tournaments/:slug` returns
// ---------------------------------------------------------------------------

export interface PoolDetail extends PoolView {
  standings: PoolStandings["rows"];
  played: number;
  total: number;
  matches: MatchView[];
}

export interface BracketDetail {
  rounds: number;
  /** Ordered by round then position. */
  matches: MatchView[];
}

export interface TournamentDetail extends TournamentSummary {
  sponsors: Sponsor[];
  teams: TeamWithMembers[];
  pools: PoolDetail[];
  bracket: BracketDetail;
}
export type PublicTournamentDetail = Omit<TournamentDetail, "tournament"> & { tournament: PublicTournament };

export function getTournamentDetail(summary: TournamentSummary): TournamentDetail {
  const id = summary.tournament.id;
  const overview = getTournamentOverview(id);
  const all = listMatches(id);
  const standings = getPoolStandings(id);
  const poolDetails: PoolDetail[] = overview.pools.map((pool) => {
    const st = standings.find((s) => s.poolId === pool.id);
    return {
      ...pool,
      standings: st?.rows ?? [],
      played: st?.played ?? 0,
      total: st?.total ?? 0,
      matches: all.filter((m) => m.match.poolId === pool.id),
    };
  });
  const bracketMatches = all
    .filter((m) => m.match.poolId === null)
    .sort((x, y) => x.match.round - y.match.round || (x.match.bracketPosition ?? 0) - (y.match.bracketPosition ?? 0));
  return {
    ...summary,
    sponsors: overview.sponsors,
    teams: listTeamsWithMembers(id).filter((t) => !UNLISTED_TEAM_STATUSES.includes(t.status)),
    pools: poolDetails,
    bracket: { rounds: bracketMatches.length ? Math.max(...bracketMatches.map((m) => m.match.round)) : 0, matches: bracketMatches },
  };
}

/** Display order of sponsor tiers, most prominent first. */
export const SPONSOR_TIER_ORDER: readonly SponsorTier[] = ["presenting", "court", "prize"];

export function sortSponsors(list: Sponsor[]): Sponsor[] {
  return [...list].sort(
    (a, b) => SPONSOR_TIER_ORDER.indexOf(a.tier) - SPONSOR_TIER_ORDER.indexOf(b.tier) || b.prizeContributionCents - a.prizeContributionCents,
  );
}
