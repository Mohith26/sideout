import "server-only";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { bracketRoundLabel, getBracketRoundCount, type MatchDetail } from "@/db/queries/tournaments";
import { matchConsensus, matches, pools, scoreSubmissions, teamMembers, teams, tournaments, users, type ConsensusState, type Match, type Team } from "@/db/schema";
import type { Tx } from "@/server/audit";
import { diffScorelines, storedSubmissionSets, type SetDifference } from "@/domain/consensus";
import type { SetScore, Side } from "@/domain/scoreline";

/**
 * Read models for the consensus surfaces: a match's submissions and state as
 * the match page, the dispute queue and the routes show them. Every scoreline
 * here is match-oriented (team A's points first); the stored payload keeps
 * what each side typed.
 */

export interface SubmissionView {
  id: string;
  /** Null for an organizer's resolution. */
  teamId: string | null;
  teamName: string | null;
  submittedBy: { userId: string; displayName: string; role: "player" | "organizer" };
  sets: SetScore[];
  hash: string;
  createdAt: number;
  supersededById: string | null;
}

export interface ConsensusView {
  matchId: string;
  state: ConsensusState;
  disputedReason: string | null;
  resolvedBy: { userId: string; displayName: string } | null;
  updatedAt: number;
  agreedSets: SetScore[] | null;
  /** The standing submission per side, oldest first; superseded rows are left out. */
  live: SubmissionView[];
  /** Every row ever recorded for the match, newest first. */
  history: SubmissionView[];
  /** Where the two live team submissions disagree (empty unless both exist and differ). */
  differences: SetDifference[];
}

/** The team a user plays for in a match, resolved from `team_members`, never from the client. */
export function findSubmitterTeam(tx: Tx, match: Pick<Match, "teamAId" | "teamBId">, userId: string): { team: Team; side: Side } | null {
  const ids = [match.teamAId, match.teamBId].filter((id): id is string => id !== null);
  if (ids.length === 0) return null;
  const row = tx
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, ids)))
    .get();
  if (!row) return null;
  return { team: row.team, side: row.team.id === match.teamAId ? "a" : "b" };
}

/** Non-superseded team submissions for a match: at most one per side. */
export function listLiveSubmissions(tx: Tx, matchId: string) {
  return tx
    .select()
    .from(scoreSubmissions)
    .where(and(eq(scoreSubmissions.matchId, matchId), isNull(scoreSubmissions.supersededById)))
    .orderBy(asc(scoreSubmissions.createdAt))
    .all();
}

function submissionViews(tx: Tx, matchIds: readonly string[]): Map<string, SubmissionView[]> {
  const out = new Map<string, SubmissionView[]>();
  if (matchIds.length === 0) return out;
  const rows = tx
    .select({ sub: scoreSubmissions, teamName: teams.name, userName: users.displayName, userRole: users.role })
    .from(scoreSubmissions)
    .leftJoin(teams, eq(teams.id, scoreSubmissions.submittedForTeamId))
    .innerJoin(users, eq(users.id, scoreSubmissions.submittedByUserId))
    .where(inArray(scoreSubmissions.matchId, [...matchIds]))
    .orderBy(desc(scoreSubmissions.createdAt))
    .all();
  for (const { sub, teamName, userName, userRole } of rows) {
    const list = out.get(sub.matchId) ?? [];
    list.push({
      id: sub.id,
      teamId: sub.submittedForTeamId,
      teamName,
      submittedBy: { userId: sub.submittedByUserId, displayName: userName, role: userRole },
      sets: storedSubmissionSets(sub.payloadJson),
      hash: sub.payloadHash,
      createdAt: sub.createdAt,
      supersededById: sub.supersededById,
    });
    out.set(sub.matchId, list);
  }
  return out;
}

function consensusViews(tx: Tx, matchIds: readonly string[]): Map<string, ConsensusView> {
  const out = new Map<string, ConsensusView>();
  if (matchIds.length === 0) return out;
  const rows = tx
    .select({ consensus: matchConsensus, resolverName: users.displayName })
    .from(matchConsensus)
    .leftJoin(users, eq(users.id, matchConsensus.resolvedByUserId))
    .where(inArray(matchConsensus.matchId, [...matchIds]))
    .all();
  const submissions = submissionViews(tx, matchIds);
  for (const { consensus, resolverName } of rows) {
    const history = submissions.get(consensus.matchId) ?? [];
    const live = history.filter((s) => s.supersededById === null).sort((x, y) => x.createdAt - y.createdAt);
    const teamSides = live.filter((s) => s.teamId !== null);
    const [first, second] = teamSides;
    let agreedSets: SetScore[] | null = null;
    if (consensus.agreedPayloadJson) {
      const parsed: unknown = JSON.parse(consensus.agreedPayloadJson);
      if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sets?: unknown }).sets)) {
        agreedSets = (parsed as { sets: SetScore[] }).sets;
      }
    }
    out.set(consensus.matchId, {
      matchId: consensus.matchId,
      state: consensus.state,
      disputedReason: consensus.disputedReason,
      resolvedBy: consensus.resolvedByUserId ? { userId: consensus.resolvedByUserId, displayName: resolverName ?? "" } : null,
      updatedAt: consensus.updatedAt,
      agreedSets,
      live,
      history,
      differences: first && second && first.teamId !== second.teamId ? diffScorelines(first.sets, second.sets) : [],
    });
  }
  return out;
}

export function getConsensusView(matchId: string, tx: Tx = getDb()): ConsensusView | null {
  return consensusViews(tx, [matchId]).get(matchId) ?? null;
}

// ---------------------------------------------------------------------------
// Dispute queue
// ---------------------------------------------------------------------------

export interface DisputeView {
  match: Match;
  tournament: { id: string; slug: string; name: string };
  poolLabel: string | null;
  roundLabel: string;
  teamA: { id: string; name: string } | null;
  teamB: { id: string; name: string } | null;
  consensus: ConsensusView;
}

/**
 * Every match still standing as `disputed`, oldest dispute first; optionally
 * one tournament's. Both the consensus and the match must say so: a forfeit
 * on a disputed match settles it without touching the consensus row, and it
 * then needs nobody's attention.
 */
export function listDisputes(tournamentId?: string): DisputeView[] {
  const db = getDb();
  const open = and(eq(matchConsensus.state, "disputed"), eq(matches.status, "disputed"));
  const where = tournamentId ? and(open, eq(matches.tournamentId, tournamentId)) : open;
  const rows = db
    .select({ match: matches, tournament: tournaments, poolLabel: pools.label })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .where(where)
    .orderBy(asc(matchConsensus.updatedAt))
    .all();
  if (rows.length === 0) return [];
  const teamIds = [...new Set(rows.flatMap((r) => [r.match.teamAId, r.match.teamBId]).filter((id): id is string => id !== null))];
  const teamRows = teamIds.length ? db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)).all() : [];
  const teamsById = new Map(teamRows.map((t) => [t.id, t]));
  const views = consensusViews(db, rows.map((r) => r.match.id));
  const roundsBy = new Map<string, number>();
  return rows.flatMap(({ match, tournament, poolLabel }) => {
    const consensus = views.get(match.id);
    if (!consensus) return [];
    if (!roundsBy.has(tournament.id)) roundsBy.set(tournament.id, getBracketRoundCount(tournament.id));
    return [
      {
        match,
        tournament: { id: tournament.id, slug: tournament.slug, name: tournament.name },
        poolLabel,
        roundLabel: match.poolId !== null ? `${poolLabel ?? "Pool"} · round ${match.round}` : bracketRoundLabel(match.round, roundsBy.get(tournament.id) ?? 0),
        teamA: match.teamAId ? (teamsById.get(match.teamAId) ?? null) : null,
        teamB: match.teamBId ? (teamsById.get(match.teamBId) ?? null) : null,
        consensus,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Match page
// ---------------------------------------------------------------------------

/** The consensus rows a match page needs, plus the viewer's side in the match. */
export interface MatchConsensusContext {
  consensus: ConsensusView | null;
  viewerSide: Side | null;
}

export function getMatchConsensusContext(detail: MatchDetail, viewerUserId: string | null): MatchConsensusContext {
  const db = getDb();
  const consensus = getConsensusView(detail.match.id, db);
  let viewerSide: Side | null = null;
  if (viewerUserId) {
    const ids = [detail.match.teamAId, detail.match.teamBId].filter((id): id is string => id !== null);
    const membership = ids.length
      ? db
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, viewerUserId), or(...ids.map((id) => eq(teamMembers.teamId, id)))))
          .get()
      : undefined;
    if (membership) viewerSide = membership.teamId === detail.match.teamAId ? "a" : "b";
  }
  return { consensus, viewerSide };
}
