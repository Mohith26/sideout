import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getPoolStandings } from "@/db/queries/standings";
import { bracketRoundLabel, getBracketRoundCount, getTournamentDetail, type TournamentDetail } from "@/db/queries/tournaments";
import { matchConsensus, matches, pools, rewards, teams, tournaments, type ConsensusState, type MatchStatus, type Reward, type Tournament } from "@/db/schema";
import { CLOSE_BLOCKING_CONSENSUS_STATES } from "@/domain/consensus";
import { computePlacements, type PlacementBasis } from "@/domain/placement";
import { TERMINAL_MATCH_STATUSES, transitionTournament, type TransitionActor } from "@/domain/transitions";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { writeAudit } from "@/server/audit";
import { requireTournamentById } from "@/server/tournaments";

/**
 * Closing a tournament (spec §10.7, §11.6): an explicit two-step confirm over
 * a frozen preview. `previewClose` computes the final standings and the
 * projected rewards and hashes a canonical serialization of them;
 * `closeTournament` recomputes, refuses while anything blocks or the hash the
 * organizer confirmed no longer matches, and only then moves
 * `live → awaiting_settlement`, storing the preview it froze on the row.
 *
 * Settlement itself is Lucra's (phase 4): `lucraSettlementHook` is the single
 * named seam that phase fills in. Tournaments never auto-settle (spec §7.4);
 * this organizer action is the trigger.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CloseBlocker {
  matchId: string;
  roundLabel: string;
  courtLabel: string | null;
  teamA: { id: string; name: string } | null;
  teamB: { id: string; name: string } | null;
  status: MatchStatus;
  consensusState: ConsensusState | null;
  /** Plain words for the organizer console: what is blocking and who can clear it. */
  reason: string;
}

export interface FinalStandingRow {
  placement: number;
  teamId: string;
  teamName: string;
  basis: PlacementBasis;
  detail: string;
  wins: number;
  losses: number;
}

export interface ProjectedReward {
  id: string;
  placement: number;
  teamId: string;
  teamName: string;
  kind: Reward["kind"];
  amountCents: number | null;
  currency: string | null;
  description: string;
}

/** What the organizer confirms. Exactly this object, in this key order, is what `previewHash` covers. */
export interface FrozenPreview {
  tournamentId: string;
  standings: FinalStandingRow[];
  rewards: ProjectedReward[];
}

export interface ClosePreview extends FrozenPreview {
  tournamentStatus: Tournament["status"];
  blockers: CloseBlocker[];
  /** sha256 hex over `canonicalPreview(frozen)`. */
  previewHash: string;
  /** Matches counted / matches in the event. */
  matchesFinal: number;
  matchesTotal: number;
}

/** What `tournaments.close_preview_json` records. */
export interface StoredClosePreview extends FrozenPreview {
  previewHash: string;
  closedAt: number;
  closedByUserId: string;
}

export const closeRequestSchema = z.object({ previewHash: z.string().regex(/^[0-9a-f]{64}$/, "previewHash must be a sha256 hex digest.") }).strict();

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Deterministic serialization: fixed key order, rows sorted, no whitespace. */
export function canonicalPreview(frozen: FrozenPreview): string {
  const standings = [...frozen.standings]
    .sort((x, y) => x.placement - y.placement || x.teamId.localeCompare(y.teamId))
    .map((r) => `{"placement":${r.placement},"teamId":${JSON.stringify(r.teamId)},"teamName":${JSON.stringify(r.teamName)},"basis":${JSON.stringify(r.basis)},"detail":${JSON.stringify(r.detail)},"wins":${r.wins},"losses":${r.losses}}`);
  const rewardRows = [...frozen.rewards]
    .sort((x, y) => x.placement - y.placement || x.teamId.localeCompare(y.teamId) || x.id.localeCompare(y.id))
    .map(
      (r) =>
        `{"id":${JSON.stringify(r.id)},"placement":${r.placement},"teamId":${JSON.stringify(r.teamId)},"teamName":${JSON.stringify(r.teamName)},"kind":${JSON.stringify(r.kind)},"amountCents":${r.amountCents === null ? "null" : r.amountCents},"currency":${r.currency === null ? "null" : JSON.stringify(r.currency)},"description":${JSON.stringify(r.description)}}`,
    );
  return `{"tournamentId":${JSON.stringify(frozen.tournamentId)},"standings":[${standings.join(",")}],"rewards":[${rewardRows.join(",")}]}`;
}

export function hashPreview(frozen: FrozenPreview): string {
  return createHash("sha256").update(canonicalPreview(frozen)).digest("hex");
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Why a match blocks the close, or null. A forfeit or a bye settles a match
 * whatever its consensus row says (a forfeit on a disputed match leaves that
 * row `disputed`; nothing will ever be written to Lucra for it). A `final`
 * match blocks only while its Lucra write is in flight or did not fully land.
 */
function blockerReason(status: MatchStatus, consensus: ConsensusState | null): string | null {
  if (status === "forfeited" || status === "bye") return null;
  if (consensus !== null && CLOSE_BLOCKING_CONSENSUS_STATES.has(consensus)) {
    switch (consensus) {
      case "disputed":
        return "The two scorelines differ. Resolve the dispute with an authoritative scoreline, or forfeit one side.";
      case "submitting":
        return "The score is being written to Lucra. Wait for the attempt to finish.";
      case "rejected":
        return "Lucra rejected the score. Retry the submission or resolve the cause.";
      case "partial":
        return "Lucra accepted the score only partially. Retry the submission.";
      default:
        return null;
    }
  }
  if (TERMINAL_MATCH_STATUSES.has(status)) return null;
  switch (status) {
    case "scheduled":
      return "Not played yet. Play it, or forfeit one side.";
    case "in_progress":
      return "On the sand now. Both teams must submit the result.";
    case "awaiting_scores":
      return consensus === "awaiting_second" ? "One team has submitted; waiting on the other." : "Waiting on both teams to submit the result.";
    case "disputed":
      return "The two scorelines differ. Resolve the dispute with an authoritative scoreline, or forfeit one side.";
    default:
      return `Match is ${status}.`;
  }
}

export function previewClose(tournamentId: string): ClosePreview {
  const db = getDb();
  const t = requireTournamentById(tournamentId).tournament;

  const matchRows = db
    .select({ match: matches, poolLabel: pools.label, consensusState: matchConsensus.state })
    .from(matches)
    .leftJoin(pools, eq(pools.id, matches.poolId))
    .leftJoin(matchConsensus, eq(matchConsensus.matchId, matches.id))
    .where(eq(matches.tournamentId, tournamentId))
    .orderBy(asc(matches.round), asc(matches.bracketPosition), asc(matches.scheduledAt))
    .all();
  const teamRows = db
    .select({ id: teams.id, name: teams.name, status: teams.status })
    .from(teams)
    .where(and(eq(teams.tournamentId, tournamentId), inArray(teams.status, ["registered", "checked_in"])))
    .all();
  const teamName = new Map(teamRows.map((x) => [x.id, x.name]));
  const bracketRounds = getBracketRoundCount(tournamentId);

  const blockers: CloseBlocker[] = [];
  for (const { match, poolLabel, consensusState } of matchRows) {
    const reason = blockerReason(match.status, consensusState);
    if (!reason) continue;
    blockers.push({
      matchId: match.id,
      roundLabel: match.poolId !== null ? `${poolLabel ?? "Pool"} · round ${match.round}` : bracketRoundLabel(match.round, bracketRounds),
      courtLabel: match.courtLabel,
      teamA: match.teamAId ? { id: match.teamAId, name: teamName.get(match.teamAId) ?? "" } : null,
      teamB: match.teamBId ? { id: match.teamBId, name: teamName.get(match.teamBId) ?? "" } : null,
      status: match.status,
      consensusState,
      reason,
    });
  }

  const record = new Map<string, { wins: number; losses: number }>();
  for (const { match } of matchRows) {
    if ((match.status !== "final" && match.status !== "forfeited") || !match.winnerTeamId || !match.teamAId || !match.teamBId) continue;
    const loser = match.winnerTeamId === match.teamAId ? match.teamBId : match.teamAId;
    const w = record.get(match.winnerTeamId) ?? { wins: 0, losses: 0 };
    const l = record.get(loser) ?? { wins: 0, losses: 0 };
    record.set(match.winnerTeamId, { wins: w.wins + 1, losses: w.losses });
    record.set(loser, { wins: l.wins, losses: l.losses + 1 });
  }

  const poolStandings = getPoolStandings(tournamentId);
  const placements = computePlacements({
    teamIds: teamRows.map((x) => x.id),
    matches: matchRows.map(({ match }) => ({
      id: match.id,
      poolId: match.poolId,
      round: match.round,
      bracketPosition: match.bracketPosition,
      teamAId: match.teamAId,
      teamBId: match.teamBId,
      status: match.status,
      winnerTeamId: match.winnerTeamId,
    })),
    pools: poolStandings.map((p) => ({ poolId: p.poolId, label: p.label, rows: p.rows })),
  });
  const standings: FinalStandingRow[] = placements.map((p) => ({
    placement: p.placement,
    teamId: p.teamId,
    teamName: teamName.get(p.teamId) ?? "",
    basis: p.basis,
    detail: p.detail,
    wins: record.get(p.teamId)?.wins ?? 0,
    losses: record.get(p.teamId)?.losses ?? 0,
  }));

  const projected: ProjectedReward[] = db
    .select({ reward: rewards, teamName: teams.name })
    .from(rewards)
    .innerJoin(teams, eq(teams.id, rewards.teamId))
    .where(and(eq(rewards.tournamentId, tournamentId), eq(rewards.status, "projected")))
    .orderBy(asc(rewards.placement))
    .all()
    .map(({ reward, teamName: name }) => ({
      id: reward.id,
      placement: reward.placement,
      teamId: reward.teamId,
      teamName: name,
      kind: reward.kind,
      amountCents: reward.amountCents,
      currency: reward.currency,
      description: reward.description,
    }));

  const frozen: FrozenPreview = { tournamentId, standings, rewards: projected };
  return {
    ...frozen,
    tournamentStatus: t.status,
    blockers,
    previewHash: hashPreview(frozen),
    matchesFinal: matchRows.filter(({ match }) => TERMINAL_MATCH_STATUSES.has(match.status)).length,
    matchesTotal: matchRows.length,
  };
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

export interface CloseTournamentInput {
  tournamentId: string;
  organizerUserId: string;
  /** The hash from the preview the organizer confirmed. */
  previewHash: string;
}

export interface CloseResult {
  detail: TournamentDetail;
  frozen: StoredClosePreview;
  settlement: SettlementHookResult;
}

export function closeTournament(input: CloseTournamentInput, clock: Clock = systemClock): CloseResult {
  const db = getDb();
  const actor: TransitionActor = { kind: "organizer", userId: input.organizerUserId };
  const t = requireTournamentById(input.tournamentId).tournament;
  if (t.status !== "live") {
    throw new ApiFailure("conflict", `Only a live tournament can be closed; this one is ${t.status}.`, { code: "not_live", status: t.status });
  }

  const preview = previewClose(input.tournamentId);
  if (preview.blockers.length > 0) {
    throw new ApiFailure("conflict", `${preview.blockers.length} match${preview.blockers.length === 1 ? " is" : "es are"} unresolved; the tournament cannot close yet.`, {
      code: "close_blocked",
      blockers: preview.blockers,
    });
  }
  if (preview.previewHash !== input.previewHash) {
    throw new ApiFailure("conflict", "The standings or rewards changed since the preview was taken. Review the new preview before closing.", {
      code: "preview_stale",
      previewHash: preview.previewHash,
    });
  }

  const verdict = transitionTournament(t.status, "awaiting_settlement", actor);
  if (!verdict.ok) throw new ApiFailure("conflict", verdict.reason);

  const now = clock.now();
  const frozen: StoredClosePreview = {
    tournamentId: preview.tournamentId,
    standings: preview.standings,
    rewards: preview.rewards,
    previewHash: preview.previewHash,
    closedAt: now,
    closedByUserId: input.organizerUserId,
  };
  let settlement: SettlementHookResult = { state: "not_available" };
  db.transaction((tx) => {
    tx.update(tournaments).set({ status: "awaiting_settlement", closePreviewJson: JSON.stringify(frozen) }).where(eq(tournaments.id, t.id)).run();
    writeAudit(tx, { actor, action: "tournament.status_changed", subjectType: "tournament", subjectId: t.id, detail: { from: t.status, to: "awaiting_settlement" }, at: now });
    writeAudit(tx, {
      actor,
      action: "tournament.closed",
      subjectType: "tournament",
      subjectId: t.id,
      detail: { previewHash: frozen.previewHash, standings: frozen.standings.length, rewards: frozen.rewards.length, matches: preview.matchesTotal },
      at: now,
    });
    settlement = lucraSettlementHook(frozen);
  });
  return { detail: getTournamentDetail(requireTournamentById(t.id)), frozen, settlement };
}

/** The stored preview of a closed tournament, or null while it is still live. */
export function readStoredClosePreview(t: Pick<Tournament, "closePreviewJson">): StoredClosePreview | null {
  if (!t.closePreviewJson) return null;
  return JSON.parse(t.closePreviewJson) as StoredClosePreview;
}

// ---------------------------------------------------------------------------
// Settlement hook (phase 4)
// ---------------------------------------------------------------------------

export type SettlementHookResult = { state: "not_available" } | { state: "triggered"; reference: string };

/**
 * Phase 4 replaces the body of this function with the Lucra settlement
 * trigger: every `agreed` consensus of the closed tournament is written
 * through the adapter (after `assertMayWriteToLucra`), then the documented
 * close call. Until then it reports honestly that nothing was triggered; the
 * tournament sits in `awaiting_settlement` and `settled` is not reachable.
 */
export function lucraSettlementHook(_frozen: StoredClosePreview): SettlementHookResult {
  return { state: "not_available" };
}
