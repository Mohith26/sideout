import type { MatchSlot, MatchStatus } from "@/db/schema";

/**
 * Bracket advancement (spec §6.2 `next_match_id` / `next_match_slot`). Pure:
 * takes the match as it stands, returns the patches to apply, and never touches
 * the database. Three ways a bracket match resolves:
 *
 * - `final`      — the consensus state machine (phase 3) calls `advanceWinner`
 *                  with the agreed winner once a match reaches `agreed`.
 * - `forfeited`  — an organizer forfeits one side; the other side advances.
 *                  `forfeitMatch` is the only path phase 2 exposes on a route.
 * - `bye`        — a round-1 match with one team auto-advances that team
 *                  (`resolveBye`). Byes never occur past round 1.
 *
 * Pool matches (no `nextMatchId`) resolve the same way; they simply advance
 * nobody.
 */

export const BRACKET_ERROR_CODES = ["not_a_participant", "already_resolved", "missing_opponent", "not_a_bye", "slot_taken"] as const;
export type BracketErrorCode = (typeof BRACKET_ERROR_CODES)[number];

export class BracketError extends Error {
  constructor(
    readonly code: BracketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BracketError";
  }
}

export interface BracketMatch {
  id: string;
  round: number;
  teamAId: string | null;
  teamBId: string | null;
  status: MatchStatus;
  winnerTeamId: string | null;
  nextMatchId: string | null;
  nextMatchSlot: MatchSlot | null;
}

/** Statuses a match can still be resolved from. */
export const RESOLVABLE_STATUSES: ReadonlySet<MatchStatus> = new Set(["scheduled", "in_progress", "awaiting_scores", "disputed"]);

export interface Advancement {
  /** The resolved match. */
  match: { id: string; status: "final" | "forfeited" | "bye"; winnerTeamId: string; finalizedAt: number };
  /** The slot the winner moves into, if the match feeds another. */
  next: { matchId: string; slot: MatchSlot; teamId: string } | null;
}

function assertResolvable(match: BracketMatch): void {
  if (!RESOLVABLE_STATUSES.has(match.status)) {
    throw new BracketError("already_resolved", `Match ${match.id} is ${match.status} and cannot be resolved again.`);
  }
}

function nextSlotFor(match: BracketMatch, teamId: string): Advancement["next"] {
  if (match.nextMatchId === null || match.nextMatchSlot === null) return null;
  return { matchId: match.nextMatchId, slot: match.nextMatchSlot, teamId };
}

/**
 * Resolve a match with a winner. `outcome` is `final` for a consensus result
 * and `forfeited` when the loser forfeited; the caller decides which.
 */
export function advanceWinner(match: BracketMatch, winnerTeamId: string, outcome: "final" | "forfeited", finalizedAt: number): Advancement {
  assertResolvable(match);
  if (winnerTeamId !== match.teamAId && winnerTeamId !== match.teamBId) {
    throw new BracketError("not_a_participant", `Team ${winnerTeamId} is not playing match ${match.id}.`);
  }
  if (match.teamAId === null || match.teamBId === null) {
    throw new BracketError("missing_opponent", `Match ${match.id} does not have both teams yet.`);
  }
  return {
    match: { id: match.id, status: outcome, winnerTeamId, finalizedAt },
    next: nextSlotFor(match, winnerTeamId),
  };
}

/** Forfeit path: the named team loses, the other advances. */
export function forfeitMatch(match: BracketMatch, forfeitingTeamId: string, finalizedAt: number): Advancement {
  assertResolvable(match);
  if (forfeitingTeamId !== match.teamAId && forfeitingTeamId !== match.teamBId) {
    throw new BracketError("not_a_participant", `Team ${forfeitingTeamId} is not playing match ${match.id}.`);
  }
  const winner = forfeitingTeamId === match.teamAId ? match.teamBId : match.teamAId;
  if (winner === null) {
    throw new BracketError("missing_opponent", `Match ${match.id} has no opponent to award the forfeit to.`);
  }
  return advanceWinner(match, winner, "forfeited", finalizedAt);
}

/** A round-1 match with exactly one team is a bye: that team advances untouched. */
export function resolveBye(match: BracketMatch, at: number): Advancement {
  if (match.status !== "scheduled") throw new BracketError("already_resolved", `Match ${match.id} is ${match.status}, not a pending bye.`);
  if (match.round !== 1) throw new BracketError("not_a_bye", `Byes only exist in round 1; match ${match.id} is in round ${match.round}.`);
  const present = match.teamAId ?? match.teamBId;
  if (present === null || (match.teamAId !== null && match.teamBId !== null)) {
    throw new BracketError("not_a_bye", `Match ${match.id} is not a bye: it needs exactly one team.`);
  }
  return {
    match: { id: match.id, status: "bye", winnerTeamId: present, finalizedAt: at },
    next: nextSlotFor(match, present),
  };
}

/**
 * Apply an advancement's `next` half to the receiving match, refusing to
 * overwrite a slot that already holds a different team.
 */
export function fillSlot(next: Pick<BracketMatch, "id" | "teamAId" | "teamBId">, slot: MatchSlot, teamId: string): { teamAId: string | null; teamBId: string | null } {
  const current = slot === "a" ? next.teamAId : next.teamBId;
  if (current !== null && current !== teamId) {
    throw new BracketError("slot_taken", `Slot ${slot} of match ${next.id} already holds ${current}.`);
  }
  return slot === "a" ? { teamAId: teamId, teamBId: next.teamBId } : { teamAId: next.teamAId, teamBId: teamId };
}
