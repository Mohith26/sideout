import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { bracketRoundLabel, getBracketRoundCount } from "@/db/queries/tournaments";
import {
  lucraLinks,
  lucraScoreSubmissions,
  matchConsensus,
  matches,
  pools,
  teams,
  tournaments,
  type ConsensusState,
  type LucraLink,
  type LucraScoreSubmission,
  type LucraSubmissionOutcome,
  type Tournament,
  type TournamentStatus,
} from "@/db/schema";
import type { Tx } from "@/server/audit";

/**
 * Read models for the Lucra layer: the audit view of every write
 * (`/admin/lucra`, `GET /api/admin/lucra/submissions`), links by user, and the
 * per-tournament targeting state. Nothing here calls Lucra.
 */

export interface LucraSubmissionView {
  row: LucraScoreSubmission;
  tournament: Pick<Tournament, "id" | "slug" | "name" | "venueTimezone">;
  match: { id: string; roundLabel: string; courtLabel: string | null; status: string; teamA: string | null; teamB: string | null };
  consensusState: ConsensusState | null;
  /** True when this is the latest attempt for its key and the consensus may be retried. */
  retryable: boolean;
  /** Attempts recorded for the same idempotency key. */
  attemptsForKey: number;
}

export interface LucraSubmissionFilter {
  tournamentId?: string | undefined;
  outcome?: LucraSubmissionOutcome | undefined;
  matchId?: string | undefined;
}

const RETRYABLE_CONSENSUS: ReadonlySet<ConsensusState> = new Set(["rejected", "partial"]);

export function listLucraSubmissions(filter: LucraSubmissionFilter = {}): LucraSubmissionView[] {
  const db = getDb();
  const conditions = [
    filter.tournamentId ? eq(lucraScoreSubmissions.tournamentId, filter.tournamentId) : undefined,
    filter.outcome ? eq(lucraScoreSubmissions.outcome, filter.outcome) : undefined,
    filter.matchId ? eq(lucraScoreSubmissions.matchId, filter.matchId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const rows = db
    .select({ row: lucraScoreSubmissions, tournament: tournaments, match: matches, poolLabel: pools.label, consensusState: matchConsensus.state })
    .from(lucraScoreSubmissions)
    .innerJoin(tournaments, eq(tournaments.id, lucraScoreSubmissions.tournamentId))
    .innerJoin(matches, eq(matches.id, lucraScoreSubmissions.matchId))
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .leftJoin(matchConsensus, eq(matchConsensus.matchId, matches.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(lucraScoreSubmissions.createdAt), desc(lucraScoreSubmissions.attempt))
    .all();
  if (rows.length === 0) return [];

  const teamIds = new Set<string>();
  for (const r of rows) {
    if (r.match.teamAId) teamIds.add(r.match.teamAId);
    if (r.match.teamBId) teamIds.add(r.match.teamBId);
  }
  const teamName = new Map(
    teamIds.size
      ? db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inArray(teams.id, [...teamIds]))
          .all()
          .map((t) => [t.id, t.name])
      : [],
  );
  const bracketRounds = new Map<string, number>();
  const latestByKey = new Map<string, number>();
  const countByKey = new Map<string, number>();
  const allForKeys = db
    .select({ key: lucraScoreSubmissions.idempotencyKey, attempt: lucraScoreSubmissions.attempt })
    .from(lucraScoreSubmissions)
    .where(inArray(lucraScoreSubmissions.idempotencyKey, [...new Set(rows.map((r) => r.row.idempotencyKey))]))
    .all();
  for (const a of allForKeys) {
    latestByKey.set(a.key, Math.max(latestByKey.get(a.key) ?? 0, a.attempt));
    countByKey.set(a.key, (countByKey.get(a.key) ?? 0) + 1);
  }

  return rows.map(({ row, tournament, match, poolLabel, consensusState }) => {
    if (!bracketRounds.has(tournament.id)) bracketRounds.set(tournament.id, getBracketRoundCount(tournament.id));
    const isLatest = latestByKey.get(row.idempotencyKey) === row.attempt;
    return {
      row,
      tournament: { id: tournament.id, slug: tournament.slug, name: tournament.name, venueTimezone: tournament.venueTimezone },
      match: {
        id: match.id,
        roundLabel: match.poolId !== null ? `${poolLabel ?? "Pool"} · round ${match.round}` : bracketRoundLabel(match.round, bracketRounds.get(tournament.id) ?? 0),
        courtLabel: match.courtLabel,
        status: match.status,
        teamA: match.teamAId ? (teamName.get(match.teamAId) ?? null) : null,
        teamB: match.teamBId ? (teamName.get(match.teamBId) ?? null) : null,
      },
      consensusState: consensusState ?? null,
      retryable: isLatest && consensusState !== null && consensusState !== undefined && RETRYABLE_CONSENSUS.has(consensusState),
      attemptsForKey: countByKey.get(row.idempotencyKey) ?? 1,
    };
  });
}

/** Rows for one idempotency key, oldest attempt first. */
export function listAttemptsForKey(tx: Tx, idempotencyKey: string): LucraScoreSubmission[] {
  return tx.select().from(lucraScoreSubmissions).where(eq(lucraScoreSubmissions.idempotencyKey, idempotencyKey)).orderBy(asc(lucraScoreSubmissions.attempt)).all();
}

/** Every accepted or partial row, oldest first: what the mock replays at boot to mirror the database. */
export function listLandedSubmissions(): LucraScoreSubmission[] {
  return getDb()
    .select()
    .from(lucraScoreSubmissions)
    .where(inArray(lucraScoreSubmissions.outcome, ["accepted", "partial"]))
    .orderBy(asc(lucraScoreSubmissions.createdAt), asc(lucraScoreSubmissions.attempt))
    .all();
}

export function linksForUsers(tx: Tx, userIds: readonly string[]): Map<string, LucraLink> {
  if (userIds.length === 0) return new Map();
  return new Map(
    tx
      .select()
      .from(lucraLinks)
      .where(inArray(lucraLinks.userId, [...new Set(userIds)]))
      .all()
      .map((l) => [l.userId, l]),
  );
}

export function listAllLinks(tx: Tx = getDb()): LucraLink[] {
  return tx.select().from(lucraLinks).all();
}

export interface TournamentLucraStatus {
  tournament: Pick<Tournament, "id" | "slug" | "name" | "status" | "lucraExternalId" | "lucraGameId" | "lucraLocationId" | "lucraMatchupId" | "lucraMatchupVerifiedAt" | "lucraAlertJson" | "venueTimezone">;
  counts: Record<LucraSubmissionOutcome, number>;
  /** Consensus rows that are agreed but have no attempt yet: written at settlement, or by hand from the console. */
  agreedUnwritten: number;
  blocking: number;
}

const OUTCOMES: readonly LucraSubmissionOutcome[] = ["pending", "accepted", "partial", "rejected", "transport_error"];

/** Per-tournament targeting state and write counts, for the console. Drafts are included: this is an organizer surface. */
export function listTournamentLucraStatus(statuses?: readonly TournamentStatus[]): TournamentLucraStatus[] {
  const db = getDb();
  const rows = db
    .select()
    .from(tournaments)
    .where(statuses ? inArray(tournaments.status, [...statuses]) : undefined)
    .orderBy(desc(tournaments.startsAt))
    .all();
  const counts = db
    .select({ tournamentId: lucraScoreSubmissions.tournamentId, outcome: lucraScoreSubmissions.outcome, n: sql<number>`count(*)` })
    .from(lucraScoreSubmissions)
    .groupBy(lucraScoreSubmissions.tournamentId, lucraScoreSubmissions.outcome)
    .all();
  const consensusRows = db
    .select({ tournamentId: matches.tournamentId, state: matchConsensus.state, n: sql<number>`count(*)` })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .groupBy(matches.tournamentId, matchConsensus.state)
    .all();
  return rows.map((t) => {
    const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<LucraSubmissionOutcome, number>;
    for (const c of counts) if (c.tournamentId === t.id) byOutcome[c.outcome] = Number(c.n);
    let agreedUnwritten = 0;
    let blocking = 0;
    for (const c of consensusRows) {
      if (c.tournamentId !== t.id) continue;
      if (c.state === "agreed") agreedUnwritten += Number(c.n);
      if (c.state === "submitting" || c.state === "rejected" || c.state === "partial" || c.state === "disputed") blocking += Number(c.n);
    }
    return {
      tournament: {
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        lucraExternalId: t.lucraExternalId,
        lucraGameId: t.lucraGameId,
        lucraLocationId: t.lucraLocationId,
        lucraMatchupId: t.lucraMatchupId,
        lucraMatchupVerifiedAt: t.lucraMatchupVerifiedAt,
        lucraAlertJson: t.lucraAlertJson,
        venueTimezone: t.venueTimezone,
      },
      counts: byOutcome,
      agreedUnwritten,
      blocking,
    };
  });
}
