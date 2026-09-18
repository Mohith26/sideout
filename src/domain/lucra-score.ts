import type { ConsensusState } from "@/db/schema";
import type { SetScore } from "@/domain/scoreline";
import type { ScoreWriteInput, ScoreWriteResult, WriteOutcome } from "@/lucra/adapter";
import type { CallRecord, UserScoreEntry } from "@/lucra/types";

/**
 * The pure mapping from an agreed Sideout match to the Lucra score write
 * (spec §7.2–§7.4), shared by the service (`@/server/lucra`) and the seed so
 * a seeded attempt row is byte-for-byte what the service would have written.
 *
 * - The target is always `matchupMetadata.externalId` = the tournament's
 *   `lucra_external_id` (rule 7.3.1); never a loose bag.
 * - One `userScore` per player, identified by their opaque `lucra_links.external_id`.
 * - `score` is the points the player's team won across the agreed sets; the
 *   full scoreline (from that team's side), the match id, the idempotency key
 *   and the outcome ride in `metadata` for traceability.
 * - `attemptFinished: true` on every entry: this is the agreed, final result.
 */

export const LUCRA_AUDIT = {
  matchupVerified: "lucra.matchup_verified",
  matchupAssertionFailed: "lucra.matchup_assertion_failed",
  alertRaised: "lucra.alert_raised",
  alertCleared: "lucra.alert_cleared",
  scoreWritten: "lucra.score_written",
  settlementCompleted: "lucra.settlement_completed",
  settlementRefused: "lucra.settlement_refused",
  linkMinted: "lucra.link_minted",
  linkUpdated: "lucra.link_updated",
} as const;

export interface LucraWriteTeam {
  id: string;
  members: Array<{ userId: string; externalId: string | null }>;
}

export interface LucraWriteContext {
  match: { id: string; round: number; winnerTeamId: string | null };
  tournament: { slug: string; lucraExternalId: string; lucraGameId: string; lucraLocationId: string | null };
  idempotencyKey: string;
  teamA: LucraWriteTeam;
  teamB: LucraWriteTeam;
  /** Match-oriented agreed sets. */
  sets: readonly SetScore[];
}

/** The scoreline as one side would read it: "21-18,19-21,15-12", own points first. */
export function setsFromPerspective(sets: readonly SetScore[], side: "a" | "b"): string {
  return sets.map((s) => (side === "a" ? `${s.teamAPoints}-${s.teamBPoints}` : `${s.teamBPoints}-${s.teamAPoints}`)).join(",");
}

export function teamPoints(sets: readonly SetScore[], side: "a" | "b"): number {
  return sets.reduce((sum, s) => sum + (side === "a" ? s.teamAPoints : s.teamBPoints), 0);
}

export function buildLucraScoreWrite(ctx: LucraWriteContext): { input: ScoreWriteInput; unlinked: string[] } {
  const userScores: UserScoreEntry[] = [];
  const unlinked: string[] = [];
  for (const [team, side] of [
    [ctx.teamA, "a"],
    [ctx.teamB, "b"],
  ] as const) {
    const points = teamPoints(ctx.sets, side);
    const won = ctx.match.winnerTeamId === team.id;
    for (const member of team.members) {
      if (member.externalId === null) {
        unlinked.push(member.userId);
        continue;
      }
      userScores.push({
        userMetadata: { externalId: member.externalId },
        score: points,
        attemptFinished: true,
        metadata: {
          sets: setsFromPerspective(ctx.sets, side),
          match_id: ctx.match.id,
          idempotency_key: ctx.idempotencyKey,
          team_id: team.id,
          won,
          round: ctx.match.round,
          tournament: ctx.tournament.slug,
        },
      });
    }
  }
  return {
    input: {
      target: { matchupMetadata: { externalId: ctx.tournament.lucraExternalId } },
      gameId: ctx.tournament.lucraGameId,
      ...(ctx.tournament.lucraLocationId ? { locationId: ctx.tournament.lucraLocationId } : {}),
      userScores,
      endpoint: "pool_tournament",
    },
    unlinked,
  };
}

// ---------------------------------------------------------------------------
// What the attempt row stores
// ---------------------------------------------------------------------------

/** `request_json` before the call is the input the adapter is about to send; after it, plus exactly what went over the wire, redacted. */
export interface StoredLucraRequest {
  endpoint: NonNullable<ScoreWriteInput["endpoint"]>;
  target: ScoreWriteInput["target"];
  gameId?: string;
  locationId?: string;
  userScores: UserScoreEntry[];
  calls?: Array<Pick<CallRecord, "method" | "path" | "request" | "tries" | "startedAt" | "finishedAt">>;
}

export interface StoredLucraResponse {
  outcome: WriteOutcome;
  httpStatus: number | null;
  error: ScoreWriteResult["error"];
  calls: Array<{ path: string; response: CallRecord["response"]; error: CallRecord["error"] }>;
}

export function storedRequestFor(input: ScoreWriteInput): StoredLucraRequest {
  return {
    endpoint: input.endpoint ?? "pool_tournament",
    target: input.target,
    ...(input.gameId !== undefined ? { gameId: input.gameId } : {}),
    ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
    userScores: input.userScores,
  };
}

export function callsForStorage(calls: readonly CallRecord[]): NonNullable<StoredLucraRequest["calls"]> {
  return calls.map((c) => ({ method: c.method, path: c.path, request: c.request, tries: c.tries, startedAt: c.startedAt, finishedAt: c.finishedAt }));
}

export function storedResponseFor(result: ScoreWriteResult): StoredLucraResponse {
  return { outcome: result.outcome, httpStatus: result.httpStatus, error: result.error, calls: result.calls.map((c) => ({ path: c.path, response: c.response, error: c.error })) };
}

/** Where each write outcome takes the consensus (§10): a transport failure is a rejection the organizer may retry. */
export const OUTCOME_TO_STATE: Record<WriteOutcome, Extract<ConsensusState, "accepted" | "partial" | "rejected">> = {
  accepted: "accepted",
  partial: "partial",
  rejected: "rejected",
  transport_error: "rejected",
};

export const OUTCOME_EVENT: Record<WriteOutcome, "lucra_accepted" | "lucra_partial" | "lucra_rejected"> = {
  accepted: "lucra_accepted",
  partial: "lucra_partial",
  rejected: "lucra_rejected",
  transport_error: "lucra_rejected",
};
