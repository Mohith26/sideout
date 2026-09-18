import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getMatchDetail, type MatchDetail } from "@/db/queries/tournaments";
import { matches, tournaments } from "@/db/schema";
import { fillSlot, forfeitMatch as forfeitInDomain, type Advancement } from "@/domain/bracket";
import { TERMINAL_MATCH_STATUSES, transitionMatch, type TransitionActor } from "@/domain/transitions";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
import { SYSTEM_ACTOR, writeAudit, type Tx } from "@/server/audit";
import { seedBracketFromPools } from "@/server/draw";

/**
 * Match service. The one write here is an organizer forfeit; a played result
 * reaches `final` only through `@/server/consensus`. Both paths share the same
 * tail: `applyAdvancement` writes the resolved match, moves the winner into
 * the next slot, and audits both, inside the caller's transaction; then, once
 * that transaction has committed, `seedBracketIfPoolsComplete` unlocks the
 * bracket if this was the last pool match.
 */

export function requireMatch(matchId: string): MatchDetail {
  const detail = getMatchDetail(matchId);
  if (!detail) throw new ApiFailure("not_found", "No match with that id.");
  return detail;
}

/** Persist an `Advancement` from `@/domain/bracket` and audit it. */
export function applyAdvancement(tx: Tx, advancement: Advancement, from: string, actor: TransitionActor, detail: Record<string, unknown>): void {
  const { match, next } = advancement;
  tx.update(matches)
    .set({ status: match.status, winnerTeamId: match.winnerTeamId, finalizedAt: match.finalizedAt })
    .where(eq(matches.id, match.id))
    .run();
  writeAudit(tx, {
    actor,
    action: "match.status_changed",
    subjectType: "match",
    subjectId: match.id,
    detail: { from, to: match.status, winnerTeamId: match.winnerTeamId, ...detail },
    at: match.finalizedAt,
  });
  if (!next) return;
  const target = tx.select().from(matches).where(eq(matches.id, next.matchId)).get();
  if (!target) throw new ApiFailure("conflict", `Match ${match.id} advances to a match that no longer exists.`);
  const slots = fillSlot(target, next.slot, next.teamId);
  tx.update(matches).set(slots).where(eq(matches.id, target.id)).run();
  writeAudit(tx, {
    actor: { kind: "system", userId: null },
    action: "match.slot_filled",
    subjectType: "match",
    subjectId: target.id,
    detail: { slot: next.slot, teamId: next.teamId, fromMatchId: match.id },
    at: match.finalizedAt,
  });
}

/**
 * When the last pool match of a `pool_to_bracket` event becomes terminal —
 * agreed, resolved or forfeited — seed the bracket from the pool standings so
 * organizers do not have to (`docs/open-questions.md`, follow-ups). Runs after
 * the resolving transaction committed: a failure here must never undo a
 * recorded result, so it is logged and reported as `false`, and the
 * organizer's `{ stage: "bracket" }` draw request remains available.
 */
export function seedBracketIfPoolsComplete(matchId: string, clock: Clock): boolean {
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
    log.error("matches: bracket seeding after the last pool match failed", { tournamentId: match.tournamentId, message: errorMessage(err) }, err);
    return false;
  }
}

export type ForfeitResult = MatchDetail & {
  /** Whether this forfeit completed pool play and the bracket was seeded from the pools as a side effect. */
  bracketSeeded: boolean;
};

/** Organizer forfeit: `forfeitingTeamId` loses, the opponent advances. */
export function forfeitMatch(matchId: string, forfeitingTeamId: string, actor: TransitionActor, clock: Clock = systemClock): ForfeitResult {
  const db = getDb();
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match) throw new ApiFailure("not_found", "No match with that id.");
  const tournament = db.select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, match.tournamentId)).get();
  if (tournament?.status !== "live") throw new ApiFailure("conflict", `Matches can only be forfeited while the tournament is live; it is ${tournament?.status}.`);

  const verdict = transitionMatch(match.status, "forfeited", actor);
  if (!verdict.ok) throw new ApiFailure("conflict", verdict.reason);
  const advancement = forfeitInDomain(match, forfeitingTeamId, clock.now());

  db.transaction((tx) => {
    applyAdvancement(tx, advancement, match.status, actor, { forfeitedTeamId: forfeitingTeamId });
  });
  const bracketSeeded = seedBracketIfPoolsComplete(matchId, clock);
  return { ...requireMatch(matchId), bracketSeeded };
}
