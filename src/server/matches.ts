import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getMatchDetail, type MatchDetail } from "@/db/queries/tournaments";
import { matches, tournaments } from "@/db/schema";
import { fillSlot, forfeitMatch as forfeitInDomain, type Advancement } from "@/domain/bracket";
import { transitionMatch, type TransitionActor } from "@/domain/transitions";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { writeAudit, type Tx } from "@/server/audit";

/**
 * Match service. Phase 2 exposes one write: an organizer forfeit, which is
 * the one bracket-advancing action that exists before the consensus state
 * machine (phase 3) lands. `applyAdvancement` is the shared tail both paths
 * use: it writes the resolved match, moves the winner into the next slot, and
 * audits both, inside the caller's transaction.
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

/** Organizer forfeit: `forfeitingTeamId` loses, the opponent advances. */
export function forfeitMatch(matchId: string, forfeitingTeamId: string, actor: TransitionActor, clock: Clock = systemClock): MatchDetail {
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
  return requireMatch(matchId);
}
