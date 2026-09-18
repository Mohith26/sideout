import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getConsensusView, type ConsensusView } from "@/db/queries/consensus";
import { linksForUsers, listAllLinks, listAttemptsForKey, listLandedSubmissions } from "@/db/queries/lucra";
import { listTeamsWithMembers, type TeamWithMembers } from "@/db/queries/tournaments";
import {
  lucraLinks,
  lucraScoreSubmissions,
  matchConsensus,
  matches,
  rewards,
  sets,
  tournaments,
  users,
  type ConsensusState,
  type LucraLink,
  type LucraScoreSubmission,
  type Match,
  type MatchConsensus,
  type Tournament,
  type User,
} from "@/db/schema";
import { assertMayRetryLucraWrite, assertMayWriteToLucra, LucraWriteRefused } from "@/domain/consensus";
import { buildLucraScoreWrite, callsForStorage, LUCRA_AUDIT, OUTCOME_EVENT, OUTCOME_TO_STATE, storedRequestFor, storedResponseFor, type StoredLucraRequest, type StoredLucraResponse } from "@/domain/lucra-score";
import type { SetScore } from "@/domain/scoreline";
import { transitionTournament, type TransitionActor } from "@/domain/transitions";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
import { uuidFromSeed, uuidv7 } from "@/lib/uuid";
import { getLucraAdapter, isLucraError, LUCRA_ERROR_MESSAGE, LucraError, metadataSchema, type LucraAdapter, type LucraErrorCode, type MockSeed, type MockSeedMatchup, type MockSeedUser, type PaymentStructureEntry, type ScoreWriteInput, type ScoreWriteResult, type TournamentMatchup, type WriteOutcome } from "@/lucra";
import { SYSTEM_ACTOR, writeAudit, type Tx } from "@/server/audit";
import type { StoredClosePreview } from "@/server/close";
import { moveConsensus } from "@/server/consensus";

/**
 * The Lucra write path (spec §7, §8, §10): everything between an `agreed`
 * consensus and a settled tournament. Every function here owns its
 * transactions and audit rows and calls the adapter (`@/lucra`) for the wire;
 * nothing else in `src/server` talks to Lucra.
 *
 *   agreed ──submitConsensusScores──► submitting ──► accepted | partial | rejected
 *   rejected | partial ──retryConsensusScores──► submitting (same idempotency key)
 *   awaiting_settlement ──settleTournament──► settled   (the organizer's close is the trigger)
 *
 * Before the first write to a tournament, `ensureMatchupTarget` runs the
 * §7.3.4 assertion — the pre-write query must return exactly one matchup — and
 * caches the result on `tournaments.lucra_matchup_id`. A count other than one
 * marks the tournament with a blocking `LucraAlert` (and, while it is live,
 * moves it to `awaiting_settlement`, as the rule requires) and refuses the
 * write; the organizer's "Verify targeting" thaws it back to `live` once the
 * count is one again, and the close may also run straight from the frozen
 * state. A query that never answered has no count: the consensus stays
 * `agreed` for the settlement sweep under a non-blocking alert.
 *
 * A process that dies between the pending row and Lucra's answer leaves the
 * consensus `submitting`; `sweepStaleSubmissions` (at boot and before every
 * settlement) turns such an attempt into `transport_error`/`rejected` after
 * `STALE_SUBMISSION_MS`, which puts the organizer's retry back in reach.
 *
 * `attemptFinished: true` goes out exactly once per team per match: at the
 * consensus write. A retry after `rejected`/`partial` re-sends the same
 * request under the same key (Lucra's finished-attempt rule makes it a no-op
 * for any user already landed); a second write after `accepted` is refused by
 * `assertMayWriteToLucra` before anything is built.
 */

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const LUCRA_ALERT_CODES = ["matchup_ambiguous", "matchup_missing", "matchup_query_failed", "settlement_refused", "settlement_partial", "unlinked_players", "settlement_blocked", "tournament_canceled"] as const;
export type LucraAlertCode = (typeof LUCRA_ALERT_CODES)[number];

export const lucraAlertSchema = z.object({
  code: z.enum(LUCRA_ALERT_CODES),
  message: z.string(),
  at: z.number(),
  /** Whether the alert blocks settlement (a `settlement_partial` notice does not). */
  blocking: z.boolean(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type LucraAlert = z.infer<typeof lucraAlertSchema>;

export function readLucraAlert(t: Pick<Tournament, "lucraAlertJson">): LucraAlert | null {
  if (!t.lucraAlertJson) return null;
  const parsed = lucraAlertSchema.safeParse(JSON.parse(t.lucraAlertJson));
  return parsed.success ? parsed.data : null;
}

function setAlert(tx: Tx, tournamentId: string, alert: LucraAlert | null, actor: TransitionActor, now: number): void {
  tx.update(tournaments)
    .set({ lucraAlertJson: alert ? JSON.stringify(alert) : null })
    .where(eq(tournaments.id, tournamentId))
    .run();
  writeAudit(tx, {
    actor,
    action: alert ? LUCRA_AUDIT.alertRaised : LUCRA_AUDIT.alertCleared,
    subjectType: "tournament",
    subjectId: tournamentId,
    detail: alert ? { code: alert.code, message: alert.message, blocking: alert.blocking, ...alert.detail } : undefined,
    at: now,
  });
}

export { LUCRA_AUDIT };

// ---------------------------------------------------------------------------
// Adapter + mock seeding
// ---------------------------------------------------------------------------

declare global {
  var __sideoutLucraMockSeeded: boolean | undefined;
  var __sideoutLucraSwept: boolean | undefined;
}

/** Metadata the mock attaches to a tournament's matchup: the strict key plus the loose fields a careless query would match on. */
export function mockMatchupMetadata(t: Pick<Tournament, "lucraExternalId" | "slug" | "venueName" | "venueCity" | "startsAt">): Record<string, string> {
  return { externalId: t.lucraExternalId, sideout_slug: t.slug, season: `${new Date(t.startsAt).getUTCFullYear()}`, venue: t.venueName, city: t.venueCity };
}

/** The Lucra user id the mock knows a link by: the recorded one, else a stable id derived from the external id. */
export function mockLucraUserId(link: Pick<LucraLink, "lucraUserId" | "externalId">): string {
  return link.lucraUserId ?? uuidFromSeed(`lucra-user:${link.externalId}`);
}

/**
 * Build the mock's world from the database: one matchup per tournament
 * (targeted by its `lucra_external_id`), every linked player as a Lucra user,
 * the players of registered teams as participants, and the deliberately
 * overlapping matchups spec §13 asks for — three sharing loose `season` and
 * `venue` metadata with one player in all of them, plus a recreational
 * `AUTOMATED` game so auto-settlement is reachable and provably off the
 * tournament path. Accepted and partial attempt rows are replayed so the
 * mock's scores match what the database says was written.
 */
export function buildMockSeedFromDb(): MockSeed {
  const db = getDb();
  const links = listAllLinks(db);
  const userRows = new Map(db.select().from(users).all().map((u) => [u.id, u]));
  const mockUsers: MockSeedUser[] = links.map((l) => ({
    id: mockLucraUserId(l),
    username: userRows.get(l.userId)?.displayName.toLowerCase().replace(/[^a-z0-9]+/g, ".") ?? l.externalId,
    phoneNumber: userRows.get(l.userId)?.phoneE164 ?? null,
    metadata: { externalId: l.externalId },
  }));
  const lucraIdByUser = new Map(links.map((l) => [l.userId, mockLucraUserId(l)]));

  const matchups: MockSeedMatchup[] = [];
  const tournamentRows = db.select().from(tournaments).orderBy(asc(tournaments.startsAt)).all();
  let overlapAnchor: string | null = null;
  for (const t of tournamentRows) {
    const roster = listTeamsWithMembers(t.id).filter((team) => team.status === "registered" || team.status === "checked_in");
    const participants: string[] = [];
    for (const team of roster) {
      for (const m of team.members) {
        const lucraId = lucraIdByUser.get(m.userId);
        if (lucraId && !participants.includes(lucraId)) participants.push(lucraId);
      }
    }
    // The upcoming event shows the reconciliation panel real divergence: one
    // registered player whose auto-join was silently skipped (§7.5), and one
    // Lucra participant who is on no Sideout team.
    if (t.status === "registration_open" && participants.length > 1) participants.pop();
    const extra = links.find((l) => !participants.includes(mockLucraUserId(l)) && !roster.some((team) => team.members.some((m) => m.userId === l.userId)));
    if (t.status === "registration_open" && extra) participants.push(mockLucraUserId(extra));
    overlapAnchor ??= participants[0] ?? null;
    matchups.push({
      id: t.lucraMatchupId ?? uuidFromSeed(`matchup:${t.lucraExternalId}`),
      kind: "pool_tournament",
      title: t.name,
      gameId: t.lucraGameId,
      locationIds: t.lucraLocationId ? [t.lucraLocationId] : [],
      metadata: mockMatchupMetadata(t),
      participants,
      status: t.status === "settled" ? "CLOSED" : t.status === "cancelled" ? "CANCELED" : "OPEN",
      maxAttempts: 1,
      buyInAmount: 0,
      createdAt: t.createdAt,
    });
  }

  // Three matchups sharing `season` and `venue`, one player in all of them:
  // a loose `{ season }` query returns every one, which is exactly what rule 7.3.2 forbids writing with.
  const overlapPlayer = overlapAnchor ?? mockUsers[0]?.id ?? null;
  const overlapping = ["Sandbar Invitational", "Sandbar Night Session", "Sandbar Juniors"].map((title, i) => ({
    id: uuidFromSeed(`matchup:overlap:${i}`),
    kind: "pool_tournament" as const,
    title,
    gameId: "SIDEOUT_BEACH_2V2",
    metadata: { externalId: `sideout-overlap-${i + 1}`, season: "2026-spring", venue: "Sandbar", series: ["sandbar", "spring"] },
    participants: overlapPlayer ? [overlapPlayer] : [],
    createdAt: 0,
  }));
  matchups.push(...overlapping);

  // Recreational games: the AUTOMATED one settles itself; the MANUAL one never does.
  const recPlayers = mockUsers.slice(0, 2).map((u) => u.id);
  matchups.push(
    { id: uuidFromSeed("matchup:rec:auto"), kind: "recreational", title: "Sandbar side game (automated)", gameId: "SIDEOUT_SIDE_GAME", metadata: { externalId: "sideout-rec-auto" }, participants: recPlayers, trackResults: "AUTOMATED", howToWin: "HIGHEST_SCORE", createdAt: 0 },
    { id: uuidFromSeed("matchup:rec:manual"), kind: "recreational", title: "Sandbar side game (manual)", gameId: "SIDEOUT_SIDE_GAME", metadata: { externalId: "sideout-rec-manual" }, participants: recPlayers, trackResults: "MANUAL", howToWin: "HIGHEST_SCORE", createdAt: 0 },
  );
  return { users: mockUsers, matchups };
}

/** Replay every landed attempt's user scores into the mock so its leaderboard agrees with the rows. */
function replayLandedSubmissions(adapter: LucraAdapter): void {
  const mock = adapter.mock;
  if (!mock) return;
  const externalIdByTournament = new Map(getDb().select({ id: tournaments.id, externalId: tournaments.lucraExternalId }).from(tournaments).all().map((t) => [t.id, t.externalId]));
  const matchupByExternalId = new Map(mock.listMatchups().map((m) => [m.metadata.externalId, m]));
  const lucraIdByExternalId = new Map(mock.state().users.map((u) => [u.metadata.externalId, u.id]));
  for (const row of listLandedSubmissions()) {
    const stored = storedRequestSchema.safeParse(JSON.parse(row.requestJson));
    if (!stored.success) continue;
    const matchup = matchupByExternalId.get(externalIdByTournament.get(row.tournamentId) ?? "");
    if (!matchup) continue;
    for (const entry of stored.data.userScores) {
      const lucraId = lucraIdByExternalId.get(entry.userMetadata?.externalId ?? "");
      const participant = lucraId ? matchup.participants.get(lucraId) : undefined;
      if (!participant || participant.attemptFinished) continue;
      participant.score = entry.score;
      participant.scoreMetadata = entry.metadata ?? null;
      participant.attemptFinished = entry.attemptFinished === true;
      participant.updatedAt = row.createdAt;
    }
  }
}

/**
 * The adapter, with two once-per-process steps on first use (and again after a
 * test installs a fresh database): the stale-attempt sweep, and in mock mode
 * the mock seeded from the database.
 */
export function getLucra(): LucraAdapter {
  const adapter = getLucraAdapter();
  if (!globalThis.__sideoutLucraSwept) {
    globalThis.__sideoutLucraSwept = true;
    sweepStaleSubmissions();
  }
  if (adapter.mock && !globalThis.__sideoutLucraMockSeeded) {
    globalThis.__sideoutLucraMockSeeded = true;
    adapter.mock.reset();
    adapter.mock.seed(buildMockSeedFromDb());
    replayLandedSubmissions(adapter);
    log.info("lucra: mock seeded from the database", { users: adapter.mock.state().users.length, matchups: adapter.mock.listMatchups().length });
  }
  return adapter;
}

/** Forget the seeded state so the next `getLucra()` rebuilds it (tests install a new database per case). */
export function resetLucraForTests(): void {
  globalThis.__sideoutLucraMockSeeded = false;
  globalThis.__sideoutLucraSwept = false;
}

// ---------------------------------------------------------------------------
// 7.3.4: exactly one matchup per tournament
// ---------------------------------------------------------------------------

export interface MatchupTargetResult {
  matchupId: string;
  count: number;
  verifiedAt: number;
  /** Whether this call ran the query (false when the cached result was used). */
  queried: boolean;
}

/** The codes rule 7.3.4 keys on: the query answered with a count other than one. */
const MATCHUP_COUNT_CODES: ReadonlySet<LucraErrorCode> = new Set(["ambiguous_matchup", "matchup_not_found"]);

/**
 * The matchup this tournament writes to, verified by the pre-write query. The
 * result is cached on the row; `force` re-runs the query (the organizer's
 * "verify targeting" action). On a count other than one the cache is dropped
 * — so the next write re-runs the assertion rather than trusting a stale id —
 * the blocking alert is raised, a `LucraError` (`ambiguous_matchup` or
 * `matchup_not_found`) is thrown, and — on the write path only
 * (`freezeOnFailure`), as rule 7.3.4 says — a live tournament is moved to
 * `awaiting_settlement`. A query that failed to answer (transport, 5xx,
 * shape) raises a non-blocking alert and throws without freezing anything:
 * there is no count to judge.
 *
 * The organizer's forced verify is the only thaw: when it finds exactly one
 * matchup for a tournament the rule froze (`awaiting_settlement` with no
 * frozen close preview), the tournament goes back to `live`, audited. A
 * participant read never changes a tournament's status. The query can take
 * tens of seconds, so every status decision is made on the row as it is when
 * the transaction runs, not as it was before the call.
 */
export async function ensureMatchupTarget(tournamentId: string, actor: TransitionActor, clock: Clock = systemClock, options: { force?: boolean; freezeOnFailure?: boolean } = {}): Promise<MatchupTargetResult> {
  const db = getDb();
  const t = db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).get();
  if (!t) throw new ApiFailure("not_found", "No tournament with that id.");
  if (t.lucraMatchupId && t.lucraMatchupVerifiedAt !== null && !options.force) {
    return { matchupId: t.lucraMatchupId, count: 1, verifiedAt: t.lucraMatchupVerifiedAt, queried: false };
  }
  const adapter = getLucra();
  const now = clock.now();
  const fresh = (tx: Tx): Tournament => {
    const row = tx.select().from(tournaments).where(eq(tournaments.id, t.id)).get();
    if (!row) throw new ApiFailure("not_found", "The tournament disappeared during the Lucra query.");
    return row;
  };
  try {
    const { matchupId, count } = await adapter.assertSingleMatchup({ matchupMetadata: { externalId: t.lucraExternalId } });
    db.transaction((tx) => {
      const current = fresh(tx);
      tx.update(tournaments).set({ lucraMatchupId: matchupId, lucraMatchupVerifiedAt: now }).where(eq(tournaments.id, t.id)).run();
      writeAudit(tx, { actor, action: LUCRA_AUDIT.matchupVerified, subjectType: "tournament", subjectId: t.id, detail: { externalId: t.lucraExternalId, matchupId, count }, at: now });
      const existing = readLucraAlert(current);
      if (existing && (existing.code === "matchup_ambiguous" || existing.code === "matchup_missing" || existing.code === "matchup_query_failed")) setAlert(tx, t.id, null, actor, now);
      if (options.force && current.status === "awaiting_settlement" && current.closePreviewJson === null && transitionTournament(current.status, "live", actor).ok) {
        tx.update(tournaments).set({ status: "live" }).where(eq(tournaments.id, t.id)).run();
        writeAudit(tx, { actor, action: "tournament.status_changed", subjectType: "tournament", subjectId: t.id, detail: { from: current.status, to: "live", reason: "matchup_verified", matchupId, count }, at: now });
      }
    });
    return { matchupId, count, verifiedAt: now, queried: true };
  } catch (err) {
    if (!isLucraError(err)) throw err;
    const count = typeof err.detail.body === "object" && err.detail.body !== null && "count" in err.detail.body ? Number((err.detail.body as { count: number }).count) : null;
    const counted = MATCHUP_COUNT_CODES.has(err.code);
    const code: LucraAlertCode = err.code === "ambiguous_matchup" ? "matchup_ambiguous" : err.code === "matchup_not_found" ? "matchup_missing" : "matchup_query_failed";
    const alert: LucraAlert = {
      code,
      blocking: counted,
      at: now,
      message:
        code === "matchup_ambiguous"
          ? `Lucra returned ${count} matchups for externalId ${t.lucraExternalId}; scores are not written until exactly one matches. Fix the matchups in Lucra, then verify targeting again.`
          : code === "matchup_missing"
            ? `Lucra returned no matchup for externalId ${t.lucraExternalId}. Create the tournament in Lucra with that externalId, then verify targeting again.`
            : `The pre-write query did not answer (${err.code}); agreed scores stay queued and are written at settlement, or verify targeting once Lucra is reachable.`,
      detail: { externalId: t.lucraExternalId, count, lucraCode: err.code },
    };
    log.error("lucra: pre-write matchup assertion failed", { tournamentId: t.id, externalId: t.lucraExternalId, count, code: err.code });
    db.transaction((tx) => {
      const current = fresh(tx);
      writeAudit(tx, { actor, action: LUCRA_AUDIT.matchupAssertionFailed, subjectType: "tournament", subjectId: t.id, detail: { externalId: t.lucraExternalId, count, lucraCode: err.code }, at: now });
      setAlert(tx, t.id, alert, actor, now);
      if (counted) tx.update(tournaments).set({ lucraMatchupId: null, lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, t.id)).run();
      // Rule 7.3.4: a count other than one refuses the write and marks the tournament awaiting_settlement.
      if (counted && options.freezeOnFailure && current.status === "live" && transitionTournament(current.status, "awaiting_settlement", SYSTEM_ACTOR).ok) {
        tx.update(tournaments).set({ status: "awaiting_settlement" }).where(eq(tournaments.id, t.id)).run();
        writeAudit(tx, { actor: SYSTEM_ACTOR, action: "tournament.status_changed", subjectType: "tournament", subjectId: t.id, detail: { from: current.status, to: "awaiting_settlement", reason: code }, at: now });
      }
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Building the write
// ---------------------------------------------------------------------------

/** The stored request, parsed back for the mock replay at boot. */
const storedRequestSchema = z.object({
  userScores: z.array(
    z.object({
      userMetadata: z.object({ externalId: z.string() }).optional(),
      score: z.number(),
      metadata: metadataSchema.optional(),
      attemptFinished: z.boolean().optional(),
    }),
  ),
});

interface LoadedForLucra {
  match: Match;
  tournament: Tournament;
  consensus: MatchConsensus;
  teamA: TeamWithMembers;
  teamB: TeamWithMembers;
  sets: SetScore[];
  links: Map<string, LucraLink>;
}

function loadForLucra(tx: Tx, matchId: string): LoadedForLucra {
  const row = tx.select({ match: matches, tournament: tournaments }).from(matches).innerJoin(tournaments, eq(tournaments.id, matches.tournamentId)).where(eq(matches.id, matchId)).get();
  if (!row) throw new ApiFailure("not_found", "No match with that id.");
  const consensus = tx.select().from(matchConsensus).where(eq(matchConsensus.matchId, matchId)).get();
  if (!consensus) throw new LucraWriteRefused("not_agreed", `Match ${matchId} has no consensus; nothing is written to Lucra.`);
  const rosters = new Map(listTeamsWithMembers(row.tournament.id).map((t) => [t.id, t]));
  const teamA = row.match.teamAId ? rosters.get(row.match.teamAId) : undefined;
  const teamB = row.match.teamBId ? rosters.get(row.match.teamBId) : undefined;
  if (!teamA || !teamB) throw new LucraWriteRefused("not_agreed", `Match ${matchId} does not have both teams.`);
  const setRows = tx.select().from(sets).where(and(eq(sets.matchId, matchId), eq(sets.agreed, true))).orderBy(asc(sets.setNumber)).all();
  const links = linksForUsers(tx, [...teamA.members, ...teamB.members].map((m) => m.userId));
  return { match: row.match, tournament: row.tournament, consensus, teamA, teamB, sets: setRows.map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints })), links };
}

/** The write for a loaded match, through the pure mapping in `@/domain/lucra-score`; a player without a link refuses the whole write. */
export function buildScoreWriteInput(loaded: Pick<LoadedForLucra, "match" | "tournament" | "consensus" | "teamA" | "teamB" | "sets" | "links">): ScoreWriteInput {
  const team = (t: TeamWithMembers) => ({ id: t.id, members: t.members.map((m) => ({ userId: m.userId, externalId: loaded.links.get(m.userId)?.externalId ?? null })) });
  const { input, unlinked } = buildLucraScoreWrite({
    match: { id: loaded.match.id, round: loaded.match.round, winnerTeamId: loaded.match.winnerTeamId },
    tournament: { slug: loaded.tournament.slug, lucraExternalId: loaded.tournament.lucraExternalId, lucraGameId: loaded.tournament.lucraGameId, lucraLocationId: loaded.tournament.lucraLocationId },
    idempotencyKey: loaded.consensus.idempotencyKey ?? "",
    teamA: team(loaded.teamA),
    teamB: team(loaded.teamB),
    sets: loaded.sets,
  });
  if (unlinked.length > 0) {
    throw new LucraError("unlinked_user", `${unlinked.length} player${unlinked.length === 1 ? " has" : "s have"} no Lucra link; they must sign in to Lucra before their score can be written.`, { body: { userIds: unlinked } });
  }
  return input;
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

export interface LucraWriteReport {
  matchId: string;
  tournamentId: string;
  submissionId: string;
  attempt: number;
  outcome: WriteOutcome;
  consensusState: ConsensusState;
  affectedMatchupIds: string[];
  failedMatchupIds: string[];
  httpStatus: number | null;
  error: ScoreWriteResult["error"];
}

/**
 * Write one agreed consensus to Lucra. `mode: "first"` passes
 * `assertMayWriteToLucra` (only `agreed`); `mode: "retry"` passes
 * `assertMayRetryLucraWrite` (only `rejected`/`partial`). In both the attempt
 * row is persisted as `pending` and the consensus moved to `submitting` in one
 * transaction *before* the call, then updated from exactly what went over the
 * wire afterwards, so a crashed process still leaves evidence.
 */
export async function submitConsensusScores(matchId: string, actor: TransitionActor, clock: Clock = systemClock, mode: "first" | "retry" = "first"): Promise<LucraWriteReport> {
  const db = getDb();
  const adapter = getLucra();

  // The gate, before anything else (including the pre-write query).
  const gate = db.transaction((tx) => loadForLucra(tx, matchId));
  if (mode === "first") assertMayWriteToLucra(gate.consensus);
  else assertMayRetryLucraWrite(gate.consensus);

  // 7.3.4, once per tournament; throws (and alerts, freezing a live event) when it is not exactly one.
  await ensureMatchupTarget(gate.tournament.id, actor, clock, { freezeOnFailure: true });

  const startedAt = clock.now();
  const prepared = db.transaction((tx) => {
    const loaded = loadForLucra(tx, matchId);
    if (mode === "first") assertMayWriteToLucra(loaded.consensus);
    else assertMayRetryLucraWrite(loaded.consensus);
    const key = loaded.consensus.idempotencyKey;
    const attempt = listAttemptsForKey(tx, key).length + 1;
    let input: ScoreWriteInput | null = null;
    let buildError: LucraError | null = null;
    try {
      input = buildScoreWriteInput(loaded);
    } catch (err) {
      if (!isLucraError(err)) throw err;
      buildError = err;
    }
    const stored: StoredLucraRequest = input ? storedRequestFor(input) : { endpoint: "pool_tournament", target: { matchupMetadata: { externalId: loaded.tournament.lucraExternalId } }, userScores: [] };
    const row: LucraScoreSubmission = {
      id: uuidv7(),
      matchId,
      tournamentId: loaded.tournament.id,
      idempotencyKey: key,
      requestJson: JSON.stringify(stored),
      responseJson: null,
      httpStatus: null,
      affectedMatchupIdsJson: "[]",
      failedMatchupIdsJson: "[]",
      outcome: "pending",
      attempt,
      createdAt: startedAt,
    };
    tx.insert(lucraScoreSubmissions).values(row).run();
    moveConsensus(tx, loaded.consensus, "submitting", actor, startedAt, {}, { event: mode === "first" ? "lucra_submit" : "organizer_retry", attempt, submissionId: row.id, idempotencyKey: key });
    return { loaded, row, input, buildError, stored };
  });

  let result: ScoreWriteResult;
  if (prepared.input) {
    try {
      result = await adapter.submitScores(prepared.input);
    } catch (err) {
      // Strict targeting or a programming error: never a wire failure, but the row and consensus must still land somewhere honest.
      const code = isLucraError(err) ? err.code : "validation";
      result = { outcome: "rejected", endpoint: prepared.input.endpoint ?? "pool_tournament", calls: [], affectedMatchupIds: [], failedMatchupIds: [], httpStatus: null, error: { code, message: errorMessage(err) } };
      log.error("lucra: score write threw before or during the call", { matchId, code, message: errorMessage(err) });
    }
  } else {
    result = { outcome: "rejected", endpoint: "pool_tournament", calls: [], affectedMatchupIds: [], failedMatchupIds: [], httpStatus: null, error: { code: prepared.buildError?.code ?? "validation", message: prepared.buildError?.message ?? "The request could not be built." } };
  }

  const finishedAt = clock.now();
  const nextState = OUTCOME_TO_STATE[result.outcome];
  db.transaction((tx) => {
    const consensus = tx.select().from(matchConsensus).where(eq(matchConsensus.id, prepared.loaded.consensus.id)).get();
    if (!consensus) throw new ApiFailure("internal", "The consensus row disappeared during the Lucra write.");
    tx.update(lucraScoreSubmissions)
      .set({
        requestJson: JSON.stringify({ ...prepared.stored, calls: callsForStorage(result.calls) } satisfies StoredLucraRequest),
        responseJson: JSON.stringify(storedResponseFor(result)),
        httpStatus: result.httpStatus,
        affectedMatchupIdsJson: JSON.stringify(result.affectedMatchupIds),
        failedMatchupIdsJson: JSON.stringify(result.failedMatchupIds),
        outcome: result.outcome,
      })
      .where(eq(lucraScoreSubmissions.id, prepared.row.id))
      .run();
    moveConsensus(tx, consensus, nextState, SYSTEM_ACTOR, finishedAt, {}, { event: OUTCOME_EVENT[result.outcome], outcome: result.outcome, attempt: prepared.row.attempt, submissionId: prepared.row.id, httpStatus: result.httpStatus, error: result.error });
    writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: LUCRA_AUDIT.scoreWritten,
      subjectType: "match",
      subjectId: matchId,
      detail: { submissionId: prepared.row.id, attempt: prepared.row.attempt, outcome: result.outcome, affected: result.affectedMatchupIds, failed: result.failedMatchupIds, httpStatus: result.httpStatus, error: result.error, calls: result.calls.length },
      at: finishedAt,
    });
  });
  if (result.outcome !== "accepted") {
    log.warn("lucra: score write did not fully land", { matchId, attempt: prepared.row.attempt, outcome: result.outcome, code: result.error?.code ?? null, status: result.httpStatus });
  }
  return {
    matchId,
    tournamentId: prepared.loaded.tournament.id,
    submissionId: prepared.row.id,
    attempt: prepared.row.attempt,
    outcome: result.outcome,
    consensusState: nextState,
    affectedMatchupIds: result.affectedMatchupIds,
    failedMatchupIds: result.failedMatchupIds,
    httpStatus: result.httpStatus,
    error: result.error,
  };
}

/** The organizer's retry (§10's `organizer_retry` edges): same request, same key, next attempt number. */
export function retryConsensusScores(matchId: string, organizerUserId: string, clock: Clock = systemClock): Promise<LucraWriteReport> {
  return submitConsensusScores(matchId, { kind: "organizer", userId: organizerUserId }, clock, "retry");
}

export type AfterAgreedResult = { state: "written"; report: LucraWriteReport } | { state: "refused"; code: string; message: string } | { state: "failed"; message: string };

export const LUCRA_WRITE_FAILED_MESSAGE = "The result is recorded, but the Lucra write could not run; the organizer can retry it from the console.";

/**
 * What the score and resolve routes call once a consensus has reached
 * `agreed` and its transaction has committed: the write, with every failure
 * turned into a reported state rather than an error, so a Lucra problem never
 * unwinds a recorded result. The consensus and its attempt row say what
 * happened; the message a player sees is the plain sentence for the code,
 * never Lucra's own text (§9). The attempt row keeps the verbatim detail.
 */
export async function writeAgreedConsensus(matchId: string, clock: Clock = systemClock): Promise<AfterAgreedResult> {
  try {
    const report = await submitConsensusScores(matchId, SYSTEM_ACTOR, clock, "first");
    return { state: "written", report: { ...report, error: report.error ? { code: report.error.code, message: LUCRA_ERROR_MESSAGE[report.error.code] } : null } };
  } catch (err) {
    if (err instanceof LucraWriteRefused) return { state: "refused", code: err.code, message: err.message };
    if (isLucraError(err)) return { state: "refused", code: err.code, message: LUCRA_ERROR_MESSAGE[err.code] };
    log.error("lucra: write after consensus failed", { matchId, message: errorMessage(err) }, err);
    return { state: "failed", message: LUCRA_WRITE_FAILED_MESSAGE };
  }
}

/** The consensus view after a Lucra write, for route responses. */
export function consensusAfterWrite(matchId: string): ConsensusView | null {
  return getConsensusView(matchId);
}

// ---------------------------------------------------------------------------
// Recovery: attempts the process never got to finish
// ---------------------------------------------------------------------------

/**
 * How long a `pending` attempt may stay pending before it is presumed dead.
 * One write is at most four tries of 10s each plus backoff per player, the
 * players in parallel, so no live call is older than about 45s; two minutes
 * leaves room for a slow host without holding a tournament's close hostage.
 */
export const STALE_SUBMISSION_MS = 2 * 60_000;

/**
 * A consensus left `submitting` with its latest attempt row still `pending`
 * past `STALE_SUBMISSION_MS` belongs to a process that died mid-call. The
 * row becomes `transport_error` and the consensus `rejected` (actor `system`,
 * event `lucra_rejected`), so `assertMayRetryLucraWrite` admits the
 * organizer's retry under the same key; a young pending row is left alone
 * because its call may still be in flight. Runs once at boot (`getLucra`) and
 * before every settlement sweep. Returns the match ids swept.
 */
export function sweepStaleSubmissions(clock: Clock = systemClock, tournamentId?: string): string[] {
  const db = getDb();
  const now = clock.now();
  const candidates = db
    .select({ consensus: matchConsensus })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .where(and(eq(matchConsensus.state, "submitting"), tournamentId ? eq(matches.tournamentId, tournamentId) : undefined))
    .all();
  const swept: string[] = [];
  for (const { consensus } of candidates) {
    if (!consensus.idempotencyKey) continue;
    db.transaction((tx) => {
      const latest = listAttemptsForKey(tx, consensus.idempotencyKey ?? "").at(-1);
      if (!latest || latest.outcome !== "pending" || now - latest.createdAt < STALE_SUBMISSION_MS) return;
      const current = tx.select().from(matchConsensus).where(eq(matchConsensus.id, consensus.id)).get();
      if (!current || current.state !== "submitting") return;
      const error = { code: "transport" as const, message: `No answer was recorded within ${STALE_SUBMISSION_MS / 1000}s of the attempt; the process did not finish the call.` };
      tx.update(lucraScoreSubmissions)
        .set({ outcome: "transport_error", responseJson: JSON.stringify({ outcome: "transport_error", httpStatus: null, error, calls: [] } satisfies StoredLucraResponse) })
        .where(eq(lucraScoreSubmissions.id, latest.id))
        .run();
      moveConsensus(tx, current, "rejected", SYSTEM_ACTOR, now, {}, { event: OUTCOME_EVENT.transport_error, outcome: "transport_error", attempt: latest.attempt, submissionId: latest.id, httpStatus: null, error, reason: "stale_pending" });
      writeAudit(tx, { actor: SYSTEM_ACTOR, action: LUCRA_AUDIT.staleAttemptSwept, subjectType: "match", subjectId: consensus.matchId, detail: { submissionId: latest.id, attempt: latest.attempt, pendingForMs: now - latest.createdAt }, at: now });
      swept.push(consensus.matchId);
    });
  }
  if (swept.length > 0) log.warn("lucra: stale pending attempts swept to transport_error; the organizer may retry them", { matches: swept.join(","), count: swept.length });
  return swept;
}

// ---------------------------------------------------------------------------
// Settlement (the organizer's close is the trigger; tournaments never auto-settle)
// ---------------------------------------------------------------------------

export type SettlementReport =
  | { state: "settled"; matchupId: string; unassignedUserIds: string[]; paymentStructure: PaymentStructureEntry[]; writes: LucraWriteReport[] }
  | { state: "refused"; alert: LucraAlert; writes: LucraWriteReport[] };

/**
 * Split a team reward across its two players as Lucra's documented tie
 * shape: consecutive `position`s, both overridden to the team's placement,
 * the amount split in whole cents. Only `lucra_reward` rows with an amount are
 * Lucra's to pay; sponsor items and credits are awarded by Sideout.
 */
export function buildPaymentStructure(frozen: Pick<StoredClosePreview, "rewards">, rosters: ReadonlyMap<string, TeamWithMembers>, links: ReadonlyMap<string, LucraLink>): { entries: PaymentStructureEntry[]; unlinked: Array<{ teamId: string; userId: string }> } {
  const entries: PaymentStructureEntry[] = [];
  const unlinked: Array<{ teamId: string; userId: string }> = [];
  let position = 0;
  const lucraRewards = [...frozen.rewards].filter((r) => r.kind === "lucra_reward" && r.amountCents !== null).sort((x, y) => x.placement - y.placement || x.teamId.localeCompare(y.teamId));
  for (const reward of lucraRewards) {
    const team = rosters.get(reward.teamId);
    const members = team?.members ?? [];
    const cents = reward.amountCents ?? 0;
    const share = Math.floor(cents / Math.max(1, members.length));
    let remainder = cents - share * members.length;
    for (const member of members) {
      const link = links.get(member.userId);
      if (!link?.lucraUserId) {
        unlinked.push({ teamId: reward.teamId, userId: member.userId });
        continue;
      }
      position += 1;
      const amount = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      entries.push({ position, positionOverride: reward.placement, value: amount / 100, userId: link.lucraUserId });
    }
  }
  return { entries, unlinked };
}

/**
 * Settle a closed tournament through Lucra: sweep any `agreed` consensus
 * that was never written, refuse while any write is not `accepted`, then the
 * documented complete call with the frozen preview's rewards. Success moves
 * `awaiting_settlement → settled` and the projected rewards to `awarded`; a
 * refusal leaves the tournament where it is with a blocking alert the
 * organizer can act on and retry.
 */
export async function settleTournament(tournamentId: string, actor: TransitionActor, clock: Clock = systemClock): Promise<SettlementReport> {
  const db = getDb();
  const adapter = getLucra();
  const t = db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).get();
  if (!t) throw new ApiFailure("not_found", "No tournament with that id.");
  if (t.status !== "awaiting_settlement") throw new ApiFailure("conflict", `Only a closed tournament awaiting settlement can be settled; this one is ${t.status}.`, { code: "not_awaiting_settlement", status: t.status });
  if (!t.closePreviewJson) throw new ApiFailure("conflict", "The tournament has no frozen close preview; close it through the organizer console first.", { code: "no_close_preview" });
  const frozen = JSON.parse(t.closePreviewJson) as StoredClosePreview;
  const writes: LucraWriteReport[] = [];
  const now = () => clock.now();

  const refuse = (alert: Omit<LucraAlert, "at" | "blocking"> & { blocking?: boolean }): SettlementReport => {
    const full: LucraAlert = { ...alert, blocking: alert.blocking ?? true, at: now() };
    db.transaction((tx) => {
      setAlert(tx, t.id, full, actor, full.at);
      writeAudit(tx, { actor, action: LUCRA_AUDIT.settlementRefused, subjectType: "tournament", subjectId: t.id, detail: { code: full.code, message: full.message, ...full.detail }, at: full.at });
    });
    log.error("lucra: settlement refused", { tournamentId: t.id, code: full.code });
    return { state: "refused", alert: full, writes };
  };

  // 7.3.4 first: without exactly one matchup there is nothing to settle into.
  let matchupId: string;
  try {
    ({ matchupId } = await ensureMatchupTarget(t.id, actor, clock));
  } catch (err) {
    if (!isLucraError(err)) throw err;
    if (!MATCHUP_COUNT_CODES.has(err.code)) {
      return refuse({ code: "settlement_refused", message: `Lucra did not answer the pre-write query (${err.code}); settle again once it is reachable.`, detail: { lucraCode: err.code } });
    }
    const current = db.select({ lucraAlertJson: tournaments.lucraAlertJson }).from(tournaments).where(eq(tournaments.id, t.id)).get();
    const alert = current ? readLucraAlert(current) : null;
    return { state: "refused", alert: alert ?? { code: "matchup_query_failed", message: LUCRA_ERROR_MESSAGE[err.code], at: now(), blocking: true }, writes };
  }

  // Sweep: an attempt a dead process never finished is closed out, then every agreed consensus that never reached Lucra is written now.
  sweepStaleSubmissions(clock, t.id);
  const agreed = db
    .select({ matchId: matchConsensus.matchId })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .where(and(eq(matches.tournamentId, t.id), eq(matchConsensus.state, "agreed")))
    .all();
  for (const { matchId } of agreed) {
    try {
      writes.push(await submitConsensusScores(matchId, actor, clock, "first"));
    } catch (err) {
      if (!isLucraError(err) && !(err instanceof LucraWriteRefused)) throw err;
      log.error("lucra: settlement sweep could not write a match", { matchId, message: errorMessage(err) });
    }
  }
  const notLanded = db
    .select({ matchId: matchConsensus.matchId, state: matchConsensus.state })
    .from(matchConsensus)
    .innerJoin(matches, eq(matches.id, matchConsensus.matchId))
    .where(and(eq(matches.tournamentId, t.id), inArray(matchConsensus.state, ["agreed", "submitting", "rejected", "partial"])))
    .all();
  if (notLanded.length > 0) {
    return refuse({
      code: "settlement_blocked",
      message: `${notLanded.length} match${notLanded.length === 1 ? "" : "es"} ${notLanded.length === 1 ? "has" : "have"} no accepted Lucra write (${notLanded.map((n) => n.state).join(", ")}). Retry them from /admin/lucra, then settle again.`,
      detail: { matches: notLanded },
    });
  }

  // The payment structure names Lucra user ids: read the participant list back
  // first and record the ids Lucra reports for our external ids (§7.5).
  try {
    await syncLucraUserIds(t.id, matchupId, actor, clock);
  } catch (err) {
    if (!isLucraError(err)) throw err;
    return refuse({ code: "settlement_refused", message: `Lucra would not return the participant list (${err.code}): ${err.message}`, detail: { lucraCode: err.code, matchupId } });
  }
  const rosters = new Map(listTeamsWithMembers(t.id).map((team) => [team.id, team]));
  const links = linksForUsers(db, [...rosters.values()].flatMap((team) => team.members.map((m) => m.userId)));
  const { entries, unlinked } = buildPaymentStructure(frozen, rosters, links);
  if (unlinked.length > 0) {
    return refuse({
      code: "unlinked_players",
      message: `${unlinked.length} prize-winning player${unlinked.length === 1 ? " is" : "s are"} not linked to a Lucra account, so their reward cannot be assigned. They must sign in to Lucra; then settle again.`,
      detail: { unlinked },
    });
  }

  const request = { object: { paymentStructure: entries, title: `${t.name} — final results`, metadataString: JSON.stringify({ previewHash: frozen.previewHash, closedAt: frozen.closedAt, sideout_tournament_id: t.id }) } };
  let response: Awaited<ReturnType<LucraAdapter["completeTournament"]>>;
  try {
    response = await adapter.completeTournament(matchupId, request);
  } catch (err) {
    if (!isLucraError(err)) throw err;
    return refuse({
      code: "settlement_refused",
      message: `Lucra refused the close (${err.code}): ${err.message}`,
      detail: { lucraCode: err.code, httpStatus: err.detail.httpStatus ?? null, matchupId, response: err.detail.body ?? null },
    });
  }

  const settledAt = now();
  db.transaction((tx) => {
    const verdict = transitionTournament("awaiting_settlement", "settled", actor);
    if (!verdict.ok) throw new ApiFailure("conflict", verdict.reason);
    tx.update(tournaments).set({ status: "settled" }).where(eq(tournaments.id, t.id)).run();
    writeAudit(tx, { actor, action: "tournament.status_changed", subjectType: "tournament", subjectId: t.id, detail: { from: "awaiting_settlement", to: "settled", matchupId }, at: settledAt });
    tx.update(rewards)
      .set({ status: "awarded", lucraRewardRef: matchupId })
      .where(and(eq(rewards.tournamentId, t.id), eq(rewards.status, "projected"), eq(rewards.kind, "lucra_reward")))
      .run();
    tx.update(rewards)
      .set({ status: "awarded" })
      .where(and(eq(rewards.tournamentId, t.id), eq(rewards.status, "projected")))
      .run();
    writeAudit(tx, {
      actor,
      action: LUCRA_AUDIT.settlementCompleted,
      subjectType: "tournament",
      subjectId: t.id,
      detail: { matchupId, paymentStructure: entries, unassignedUserIds: response.response.unassignedUserIds, request: response.record.request, response: response.record.response, tries: response.record.tries },
      at: settledAt,
    });
    const notice: LucraAlert | null =
      response.response.unassignedUserIds.length > 0
        ? {
            code: "settlement_partial",
            blocking: false,
            at: settledAt,
            message: `Lucra settled the tournament but could not assign ${response.response.unassignedUserIds.length} reward${response.response.unassignedUserIds.length === 1 ? "" : "s"}: the listed Lucra users are not participants of the matchup.`,
            detail: { unassignedUserIds: response.response.unassignedUserIds, matchupId },
          }
        : null;
    setAlert(tx, t.id, notice, actor, settledAt);
  });
  log.info("lucra: tournament settled", { tournamentId: t.id, matchupId, prizes: entries.length, unassigned: response.response.unassignedUserIds.length });
  return { state: "settled", matchupId, unassignedUserIds: response.response.unassignedUserIds, paymentStructure: entries, writes };
}

// ---------------------------------------------------------------------------
// Participants: read back from Lucra, reconciled against `teams`
// ---------------------------------------------------------------------------

/**
 * Read the matchup's participants and record, on every link whose
 * `external_id` Lucra echoes in `userMetadata`, the Lucra user id it belongs
 * to — the only way a Sideout account learns its Lucra id server-side before
 * a webhook or the SDK sign-in (phase 4b) reports it. An id already claimed
 * by another link is never moved. Returns how many links were updated.
 */
export async function syncLucraUserIds(tournamentId: string, matchupId: string, actor: TransitionActor, clock: Clock = systemClock): Promise<number> {
  const db = getDb();
  const adapter = getLucra();
  const { matchup } = await adapter.getTournament(matchupId);
  const now = clock.now();
  let updated = 0;
  db.transaction((tx) => {
    for (const u of matchup.users) {
      const ext = u.userMetadata?.externalId;
      if (typeof ext !== "string") continue;
      const link = tx.select().from(lucraLinks).where(eq(lucraLinks.externalId, ext)).get();
      if (!link || link.lucraUserId === u.userId) continue;
      if (link.lucraUserId !== null) continue;
      const claimed = tx.select({ id: lucraLinks.id }).from(lucraLinks).where(eq(lucraLinks.lucraUserId, u.userId)).get();
      if (claimed) continue;
      tx.update(lucraLinks).set({ lucraUserId: u.userId, linkedAt: link.linkedAt ?? now, lastSyncedAt: now }).where(eq(lucraLinks.id, link.id)).run();
      writeAudit(tx, { actor, action: LUCRA_AUDIT.linkUpdated, subjectType: "user", subjectId: link.userId, detail: { externalId: ext, lucraUserId: u.userId, source: "participant_sync", tournamentId, matchupId }, at: now });
      updated += 1;
    }
  });
  if (updated > 0) log.info("lucra: recorded Lucra user ids from the participant list", { tournamentId, matchupId, updated });
  return updated;
}

export interface ParticipantReconciliation {
  tournamentId: string;
  matchupId: string;
  lucraStatus: string;
  lucraParticipants: number;
  /** Registered players Lucra also lists. */
  matched: Array<{ userId: string; displayName: string; teamId: string; teamName: string; externalId: string; lucraUserId: string }>;
  /** Registered, linked, but absent from the Lucra matchup: auto-join was skipped or has not happened. */
  missing: Array<{ userId: string; displayName: string; teamId: string; teamName: string; externalId: string }>;
  /** Registered but never linked to Lucra at all. */
  unlinked: Array<{ userId: string; displayName: string; teamId: string; teamName: string }>;
  /** Lucra participants on no registered Sideout team. */
  extra: Array<{ lucraUserId: string; externalId: string | null; userName: string | null }>;
}

export async function reconcileParticipants(tournamentId: string, actor: TransitionActor, clock: Clock = systemClock): Promise<ParticipantReconciliation> {
  const db = getDb();
  const adapter = getLucra();
  const { matchupId } = await ensureMatchupTarget(tournamentId, actor, clock);
  const { matchup } = await adapter.getTournament(matchupId);
  const rosters = listTeamsWithMembers(tournamentId).filter((team) => team.status === "registered" || team.status === "checked_in");
  const links = linksForUsers(db, rosters.flatMap((team) => team.members.map((m) => m.userId)));
  const byExternalId = new Map<string, TournamentMatchup["users"][number]>();
  const byLucraId = new Map<string, TournamentMatchup["users"][number]>();
  for (const u of matchup.users) {
    byLucraId.set(u.userId, u);
    const ext = u.userMetadata?.externalId;
    if (typeof ext === "string") byExternalId.set(ext, u);
  }
  const out: ParticipantReconciliation = { tournamentId, matchupId, lucraStatus: matchup.status, lucraParticipants: matchup.users.length, matched: [], missing: [], unlinked: [], extra: [] };
  const claimed = new Set<string>();
  for (const team of rosters) {
    for (const member of team.members) {
      const link = links.get(member.userId);
      if (!link) {
        out.unlinked.push({ userId: member.userId, displayName: member.displayName, teamId: team.id, teamName: team.name });
        continue;
      }
      const hit = byExternalId.get(link.externalId) ?? (link.lucraUserId ? byLucraId.get(link.lucraUserId) : undefined);
      if (hit) {
        claimed.add(hit.userId);
        out.matched.push({ userId: member.userId, displayName: member.displayName, teamId: team.id, teamName: team.name, externalId: link.externalId, lucraUserId: hit.userId });
      } else {
        out.missing.push({ userId: member.userId, displayName: member.displayName, teamId: team.id, teamName: team.name, externalId: link.externalId });
      }
    }
  }
  for (const u of matchup.users) {
    if (claimed.has(u.userId)) continue;
    const ext = u.userMetadata?.externalId;
    out.extra.push({ lucraUserId: u.userId, externalId: typeof ext === "string" ? ext : null, userName: u.userName ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export const linkRequestSchema = z.object({}).strict();

export interface LinkResult {
  externalId: string;
  lucraUserId: string | null;
  verificationState: LucraLink["verificationState"];
  linkedAt: number | null;
  /** True when this call minted the external id. */
  minted: boolean;
}

/**
 * `POST /api/me/lucra/link`: mint the stable opaque `external_id` once per
 * user (a UUID v7, never the phone or email) and report the link as it
 * stands. The Lucra user id is never taken from the caller: it is the payout
 * destination and the key the verification webhook matches on, so it is
 * learned only from Lucra itself — the participant read-back
 * (`syncLucraUserIds`) and the `TournamentUserJoined` / `UserSignedUp`
 * webhooks, each keyed on the `externalId` Lucra echoes back.
 */
export function linkLucraAccount(user: Pick<User, "id">, clock: Clock = systemClock): LinkResult {
  const db = getDb();
  const now = clock.now();
  return db.transaction((tx) => {
    const existing = tx.select().from(lucraLinks).where(eq(lucraLinks.userId, user.id)).get();
    if (existing) return { externalId: existing.externalId, lucraUserId: existing.lucraUserId, verificationState: existing.verificationState, linkedAt: existing.linkedAt, minted: false };
    const row: LucraLink = { id: uuidv7(), userId: user.id, lucraUserId: null, externalId: uuidv7(), verificationState: "unverified", linkedAt: null, lastSyncedAt: null };
    tx.insert(lucraLinks).values(row).run();
    writeAudit(tx, { actor: { kind: "player", userId: user.id }, action: LUCRA_AUDIT.linkMinted, subjectType: "user", subjectId: user.id, detail: { externalId: row.externalId }, at: now });
    return { externalId: row.externalId, lucraUserId: null, verificationState: row.verificationState, linkedAt: null, minted: true };
  });
}

/**
 * The roster's link state for the entry step's honest report. Only the
 * caller's own `external_id` is returned: it is the key Lucra's participant
 * list and webhooks bind a Lucra account to, so a teammate sees whether the
 * others are linked, never their ids.
 */
export function lucraEntryState(tournamentId: string, userIds: readonly string[], callerUserId: string): { players: Array<{ userId: string; linked: boolean }>; externalId: string | null; matchupVerified: boolean } {
  const db = getDb();
  const links = linksForUsers(db, userIds);
  const t = db.select({ verifiedAt: tournaments.lucraMatchupVerifiedAt }).from(tournaments).where(eq(tournaments.id, tournamentId)).get();
  return {
    players: userIds.map((userId) => ({ userId, linked: links.has(userId) })),
    externalId: links.get(callerUserId)?.externalId ?? null,
    matchupVerified: t?.verifiedAt !== null && t?.verifiedAt !== undefined,
  };
}
