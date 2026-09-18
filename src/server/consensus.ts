import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { findSubmitterTeam, getConsensusView, listLiveSubmissions, type ConsensusView } from "@/db/queries/consensus";
import { getMatchDetail, type MatchDetail } from "@/db/queries/tournaments";
import { matchConsensus, matches, scoreSubmissions, sets, tournaments, type ConsensusState, type Match, type MatchConsensus } from "@/db/schema";
import { advanceWinner } from "@/domain/bracket";
import {
  agreedOutcome,
  assertLegalScoreline,
  assertMayWriteToLucra,
  canonicalizeSubmission,
  CONSENSUS_AUDIT,
  ConsensusError,
  describeDifferences,
  diffScorelines,
  idempotencyKeyFor,
  judgeSubmission,
  OPEN_CONSENSUS_STATES,
  storedSubmissionSets,
  toPerspective,
  transitionConsensus,
  type AgreedOutcome,
  type StoredSubmission,
  type SubmittedScoreline,
} from "@/domain/consensus";
import type { SetScore, Side } from "@/domain/scoreline";
import { TERMINAL_MATCH_STATUSES, transitionMatch, type TransitionActor } from "@/domain/transitions";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
import { uuidv7 } from "@/lib/uuid";
import { SYSTEM_ACTOR, writeAudit, type Tx } from "@/server/audit";
import { seedBracketFromPools } from "@/server/draw";
import { applyAdvancement } from "@/server/matches";

/**
 * The consensus service: the trust boundary between a phone on the sand and
 * anything that moves a prize (spec §10). Two entry points write, each in one
 * transaction with its audit rows:
 *
 * - `submitScoreline`  — a player records their team's result. Legality is
 *                        judged first; the scoreline is canonicalized to the
 *                        match orientation and hashed; the team is resolved
 *                        from `team_members`, never trusted from the client.
 * - `resolveDispute`   — an organizer settles a dispute with an authoritative
 *                        scoreline, attributed to them.
 *
 * Both reach `agreed` through `enterAgreed`: the agreed `sets` rows are
 * written, the match becomes `final` (actor `system`), the winner advances
 * through `@/domain/bracket`, and the idempotency key is minted exactly once.
 *
 * `assertMayWriteToLucra` (re-exported from the domain) is the gate phase 4
 * must call before any Lucra request. Nothing here talks to Lucra.
 */

export { assertMayWriteToLucra };

export type ConsensusOutcome = Extract<ConsensusState, "awaiting_second" | "agreed" | "disputed">;

export interface SubmitResult {
  outcome: ConsensusOutcome;
  /** Whether this submission replaced an earlier one from the same team. */
  replaced: boolean;
  submissionId: string;
  consensus: ConsensusView;
  match: MatchDetail;
  /** The submitter's side and what they typed, echoed for the sheet. */
  perspective: Side;
  /** For an `agreed` outcome on the last pool match: whether the bracket was seeded from the pools as a side effect. */
  bracketSeeded: boolean;
}

export interface ResolveResult {
  consensus: ConsensusView;
  match: MatchDetail;
  submissionId: string;
  bracketSeeded: boolean;
}

interface LoadedMatch {
  match: Match;
  tournamentStatus: string;
  consensus: MatchConsensus | null;
}

function loadMatch(tx: Tx, matchId: string): LoadedMatch {
  const row = tx
    .select({ match: matches, tournamentStatus: tournaments.status })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(eq(matches.id, matchId))
    .get();
  if (!row) throw new ApiFailure("not_found", "No match with that id.");
  const consensus = tx.select().from(matchConsensus).where(eq(matchConsensus.matchId, matchId)).get() ?? null;
  return { match: row.match, tournamentStatus: row.tournamentStatus, consensus };
}

/** The consensus row, created as `awaiting_first` the first time a match needs one. */
function ensureConsensus(tx: Tx, matchId: string, existing: MatchConsensus | null, now: number): MatchConsensus {
  if (existing) return existing;
  const row: MatchConsensus = {
    id: uuidv7(),
    matchId,
    state: "awaiting_first",
    agreedPayloadJson: null,
    agreedPayloadHash: null,
    disputedReason: null,
    resolvedByUserId: null,
    idempotencyKey: null,
    updatedAt: now,
  };
  tx.insert(matchConsensus).values(row).run();
  return row;
}

function moveConsensus(tx: Tx, consensus: MatchConsensus, to: ConsensusState, actor: TransitionActor, now: number, patch: Partial<MatchConsensus>, detail: Record<string, unknown>): void {
  const verdict = transitionConsensus(consensus.state, to, actor);
  if (!verdict.ok) throw new ConsensusError("invalid_transition", verdict.reason, { code: "invalid_transition", from: consensus.state, to });
  tx.update(matchConsensus)
    .set({ ...patch, state: to, updatedAt: now })
    .where(eq(matchConsensus.id, consensus.id))
    .run();
  writeAudit(tx, {
    actor,
    action: CONSENSUS_AUDIT.stateChanged,
    subjectType: "consensus",
    subjectId: consensus.id,
    detail: { matchId: consensus.matchId, from: consensus.state, to, ...detail },
    at: now,
  });
}

function moveMatch(tx: Tx, match: Match, to: Match["status"], actor: TransitionActor, now: number, patch: Partial<Match>, detail: Record<string, unknown>): void {
  const verdict = transitionMatch(match.status, to, actor);
  if (!verdict.ok) throw new ConsensusError("invalid_transition", verdict.reason, { code: "invalid_transition", from: match.status, to });
  tx.update(matches)
    .set({ ...patch, status: to })
    .where(eq(matches.id, match.id))
    .run();
  writeAudit(tx, { actor, action: "match.status_changed", subjectType: "match", subjectId: match.id, detail: { from: match.status, to, ...detail }, at: now });
}

/**
 * Everything that happens on entering `agreed`, from either path: the agreed
 * `sets` rows replace any provisional ones, the consensus records the payload
 * and hash and mints its key (only if it has none), the match becomes `final`
 * as actor `system`, and the winner moves into the next bracket slot.
 */
function enterAgreed(
  tx: Tx,
  loaded: LoadedMatch,
  consensus: MatchConsensus,
  outcome: AgreedOutcome,
  actor: TransitionActor,
  now: number,
  extra: { resolvedByUserId: string | null; event: "matching_submission" | "organizer_resolution" },
): void {
  const idempotencyKey = idempotencyKeyFor(consensus.idempotencyKey, uuidv7);
  moveConsensus(
    tx,
    consensus,
    "agreed",
    actor,
    now,
    {
      agreedPayloadJson: JSON.stringify(outcome.scoreline),
      agreedPayloadHash: outcome.hash,
      idempotencyKey,
      resolvedByUserId: extra.resolvedByUserId,
    },
    { event: extra.event, hash: outcome.hash, idempotencyKey, mintedKey: consensus.idempotencyKey === null, winnerTeamId: outcome.winnerTeamId, resolvedByUserId: extra.resolvedByUserId },
  );

  tx.delete(sets).where(eq(sets.matchId, loaded.match.id)).run();
  for (const s of outcome.sets) {
    tx.insert(sets).values({ id: uuidv7(), matchId: loaded.match.id, setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints, agreed: true }).run();
  }

  const matchVerdict = transitionMatch(loaded.match.status, "final", SYSTEM_ACTOR);
  if (!matchVerdict.ok) throw new ConsensusError("invalid_transition", matchVerdict.reason, { code: "invalid_transition", from: loaded.match.status, to: "final" });
  const advancement = advanceWinner(loaded.match, outcome.winnerTeamId, "final", now);
  applyAdvancement(tx, advancement, loaded.match.status, SYSTEM_ACTOR, { consensusId: consensus.id, hash: outcome.hash });
}

function assertLive(loaded: LoadedMatch): void {
  if (loaded.tournamentStatus !== "live") {
    throw new ConsensusError("match_not_open", `Scores are recorded while the tournament is live; it is ${loaded.tournamentStatus}.`, {
      code: "match_not_open",
      tournamentStatus: loaded.tournamentStatus,
    });
  }
}

// ---------------------------------------------------------------------------
// Player submission
// ---------------------------------------------------------------------------

export interface SubmitScorelineInput {
  matchId: string;
  userId: string;
  scoreline: SubmittedScoreline;
}

export function submitScoreline(input: SubmitScorelineInput, clock: Clock = systemClock): SubmitResult {
  const db = getDb();
  const now = clock.now();
  const actor: TransitionActor = { kind: "player", userId: input.userId };

  const result = db.transaction((tx) => {
    const loaded = loadMatch(tx, input.matchId);
    const { match } = loaded;

    // Rule 2: the team is resolved from the roster, never from the request.
    const membership = findSubmitterTeam(tx, match, input.userId);
    if (!membership) throw new ConsensusError("not_on_team", "Only a member of one of the two teams can submit this match's score.", { code: "not_on_team" });
    assertLive(loaded);

    const existing = loaded.consensus;
    if (existing && !OPEN_CONSENSUS_STATES.has(existing.state)) {
      const message =
        existing.state === "disputed"
          ? "Both teams have submitted and the scorelines differ; the organizer will settle it. Nothing more can be submitted."
          : "Both teams have already confirmed this result; it is final.";
      throw new ConsensusError("already_submitted_by_team", message, { code: "already_submitted_by_team", state: existing.state });
    }
    if (match.status !== "in_progress" && match.status !== "awaiting_scores") {
      throw new ConsensusError("match_not_open", `Scores are submitted for a match that is in progress or awaiting scores; this one is ${match.status}.`, {
        code: "match_not_open",
        status: match.status,
      });
    }
    if (!match.teamAId || !match.teamBId) {
      throw new ConsensusError("match_not_open", "This match does not have both teams yet.", { code: "match_not_open", status: match.status });
    }

    // Rule 4: plausibility before anything is stored.
    const canonical = canonicalizeSubmission(match.id, input.scoreline.sets, membership.side, match.bestOf);
    assertLegalScoreline(canonical, match.bestOf);

    const consensus = ensureConsensus(tx, match.id, existing, now);
    const live = listLiveSubmissions(tx, match.id);
    const mine = live.find((s) => s.submittedForTeamId === membership.team.id) ?? null;
    const standing = live.find((s) => s.submittedForTeamId !== null && s.submittedForTeamId !== membership.team.id) ?? null;

    const stored: StoredSubmission = { matchId: match.id, perspective: membership.side, sets: toPerspective(canonical.sets, membership.side) };
    const submissionId = uuidv7();
    tx.insert(scoreSubmissions)
      .values({
        id: submissionId,
        matchId: match.id,
        submittedByUserId: input.userId,
        submittedForTeamId: membership.team.id,
        payloadJson: JSON.stringify(stored),
        payloadHash: canonical.hash,
        createdAt: now,
        supersededById: null,
      })
      .run();
    if (mine) {
      // Never updated, only superseded: the earlier row stays as the audit trail.
      tx.update(scoreSubmissions).set({ supersededById: submissionId }).where(eq(scoreSubmissions.id, mine.id)).run();
      writeAudit(tx, {
        actor,
        action: CONSENSUS_AUDIT.scoreSuperseded,
        subjectType: "match",
        subjectId: match.id,
        detail: { teamId: membership.team.id, supersededId: mine.id, bySubmissionId: submissionId },
        at: now,
      });
    }
    writeAudit(tx, {
      actor,
      action: CONSENSUS_AUDIT.scoreSubmitted,
      subjectType: "match",
      subjectId: match.id,
      detail: { submissionId, teamId: membership.team.id, side: membership.side, hash: canonical.hash, replaced: mine !== null },
      at: now,
    });

    const decision = judgeSubmission({
      state: consensus.state,
      submission: { teamId: membership.team.id, hash: canonical.hash },
      standing: standing?.submittedForTeamId ? { teamId: standing.submittedForTeamId, hash: standing.payloadHash } : null,
      replaces: mine !== null,
      describeDifference: () => {
        const theirs = standing ? storedSubmissionSets(standing.payloadJson) : [];
        const [aSets, bSets] = membership.side === "a" ? [canonical.sets, theirs] : [theirs, canonical.sets];
        return describeDifferences(diffScorelines(aSets, bSets));
      },
    });

    switch (decision.next) {
      case "awaiting_second": {
        if (consensus.state === "awaiting_first") {
          moveConsensus(tx, consensus, "awaiting_second", actor, now, {}, { event: "first_submission", teamId: membership.team.id, submissionId });
        } else {
          tx.update(matchConsensus).set({ updatedAt: now }).where(eq(matchConsensus.id, consensus.id)).run();
        }
        if (match.status === "in_progress") moveMatch(tx, match, "awaiting_scores", actor, now, {}, { submissionId });
        return { outcome: "awaiting_second" as const, replaced: decision.replaced, submissionId, perspective: membership.side };
      }
      case "agreed": {
        if (match.status === "in_progress") {
          // The first submission always moves the match on; reaching here from in_progress means a stale row, not a live one.
          moveMatch(tx, match, "awaiting_scores", actor, now, {}, { submissionId });
          loaded.match = { ...match, status: "awaiting_scores" };
        }
        const outcome = agreedOutcome(match, canonical.sets);
        enterAgreed(tx, loaded, consensus, outcome, actor, now, { resolvedByUserId: null, event: "matching_submission" });
        return { outcome: "agreed" as const, replaced: mine !== null, submissionId, perspective: membership.side };
      }
      case "disputed": {
        if (match.status === "in_progress") {
          moveMatch(tx, match, "awaiting_scores", actor, now, {}, { submissionId });
          loaded.match = { ...match, status: "awaiting_scores" };
        }
        moveConsensus(tx, consensus, "disputed", actor, now, { disputedReason: decision.reason }, { event: "conflicting_submission", reason: decision.reason, hashes: [standing?.payloadHash ?? null, canonical.hash] });
        moveMatch(tx, loaded.match, "disputed", SYSTEM_ACTOR, now, {}, { consensusId: consensus.id, reason: decision.reason });
        return { outcome: "disputed" as const, replaced: false, submissionId, perspective: membership.side };
      }
    }
  });

  const bracketSeeded = result.outcome === "agreed" ? seedBracketIfPoolsComplete(input.matchId, clock) : false;
  const consensus = getConsensusView(input.matchId);
  const match = getMatchDetail(input.matchId);
  if (!consensus || !match) throw new ApiFailure("internal", "The match disappeared while recording the score.");
  return { ...result, consensus, match, bracketSeeded };
}

// ---------------------------------------------------------------------------
// Organizer resolution
// ---------------------------------------------------------------------------

export interface ResolveDisputeInput {
  matchId: string;
  organizerUserId: string;
  /** Match-oriented: team A's points first. */
  sets: readonly SetScore[];
}

export function resolveDispute(input: ResolveDisputeInput, clock: Clock = systemClock): ResolveResult {
  const db = getDb();
  const now = clock.now();
  const actor: TransitionActor = { kind: "organizer", userId: input.organizerUserId };

  const submissionId = db.transaction((tx) => {
    const loaded = loadMatch(tx, input.matchId);
    const { match, consensus } = loaded;
    assertLive(loaded);
    if (!consensus || consensus.state !== "disputed") {
      throw new ConsensusError("invalid_transition", `Only a disputed match can be resolved; this one is ${consensus?.state ?? "not yet submitted"}.`, {
        code: "invalid_transition",
        state: consensus?.state ?? null,
      });
    }
    if (!match.teamAId || !match.teamBId) throw new ConsensusError("invalid_transition", "This match does not have both teams.", { code: "invalid_transition" });

    const canonical = canonicalizeSubmission(
      match.id,
      input.sets.map((s) => ({ setNumber: s.setNumber, usPoints: s.teamAPoints, themPoints: s.teamBPoints })),
      "a",
      match.bestOf,
    );
    assertLegalScoreline(canonical, match.bestOf);

    const stored: StoredSubmission = { matchId: match.id, perspective: "a", sets: toPerspective(canonical.sets, "a") };
    const id = uuidv7();
    tx.insert(scoreSubmissions)
      .values({
        id,
        matchId: match.id,
        submittedByUserId: input.organizerUserId,
        submittedForTeamId: null,
        payloadJson: JSON.stringify(stored),
        payloadHash: canonical.hash,
        createdAt: now,
        supersededById: null,
      })
      .run();
    writeAudit(tx, {
      actor,
      action: CONSENSUS_AUDIT.scoreSubmitted,
      subjectType: "match",
      subjectId: match.id,
      detail: { submissionId: id, teamId: null, side: "organizer", hash: canonical.hash, resolution: true },
      at: now,
    });

    const outcome = agreedOutcome(match, canonical.sets);
    enterAgreed(tx, loaded, consensus, outcome, actor, now, { resolvedByUserId: input.organizerUserId, event: "organizer_resolution" });
    return id;
  });

  const bracketSeeded = seedBracketIfPoolsComplete(input.matchId, clock);
  const consensus = getConsensusView(input.matchId);
  const match = getMatchDetail(input.matchId);
  if (!consensus || !match) throw new ApiFailure("internal", "The match disappeared while resolving the dispute.");
  return { consensus, match, submissionId, bracketSeeded };
}

// ---------------------------------------------------------------------------
// Bracket trigger
// ---------------------------------------------------------------------------

/**
 * When the last pool match of a `pool_to_bracket` event finalizes, seed the
 * bracket from the pool standings so organizers do not have to
 * (`docs/open-questions.md`, follow-ups). Runs after the consensus
 * transaction committed: a failure here must never undo a recorded score, so
 * it is logged and reported, and the organizer's `{ stage: "bracket" }` draw
 * request remains available.
 */
function seedBracketIfPoolsComplete(matchId: string, clock: Clock): boolean {
  const db = getDb();
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match || match.poolId === null) return false;
  const t = db.select({ format: tournaments.format, status: tournaments.status }).from(tournaments).where(eq(tournaments.id, match.tournamentId)).get();
  if (!t || t.format !== "pool_to_bracket" || t.status !== "live") return false;
  const poolMatches = db
    .select({ status: matches.status })
    .from(matches)
    .where(and(eq(matches.tournamentId, match.tournamentId), isNotNull(matches.poolId)))
    .all();
  if (poolMatches.some((m) => !TERMINAL_MATCH_STATUSES.has(m.status))) return false;
  const roundOne = db
    .select({ teamAId: matches.teamAId, teamBId: matches.teamBId, status: matches.status })
    .from(matches)
    .where(and(eq(matches.tournamentId, match.tournamentId), isNull(matches.poolId), eq(matches.round, 1)))
    .all();
  // Already seeded (or no bracket): nothing to do.
  if (roundOne.length === 0 || roundOne.some((m) => m.teamAId !== null || m.teamBId !== null || m.status !== "scheduled")) return false;
  try {
    seedBracketFromPools(match.tournamentId, SYSTEM_ACTOR, { preview: false, clock });
    return true;
  } catch (err) {
    log.error("consensus: bracket seeding after the last pool match failed", { tournamentId: match.tournamentId, message: errorMessage(err) }, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The Lucra gate, loaded from rows
// ---------------------------------------------------------------------------

/**
 * Load a match's consensus and assert it may be written to Lucra. Phase 4
 * builds every request from the row this returns and nothing else.
 */
export function requireLucraWritableConsensus(matchId: string): MatchConsensus & { idempotencyKey: string } {
  const row = getDb().select().from(matchConsensus).where(eq(matchConsensus.matchId, matchId)).get();
  if (!row) throw new ApiFailure("conflict", `Match ${matchId} has no consensus; nothing to write.`);
  assertMayWriteToLucra(row);
  return row;
}
