import "server-only";
import { listMatches, type MatchView } from "@/db/queries/tournaments";
import type { MatchStatus } from "@/db/schema";

/**
 * The court-by-court live board (spec §11.6): every match of an event grouped
 * by court, in the order it is scheduled, with what is on each court right
 * now. Matches with no court (an unseeded bracket slot) sit in their own group.
 */
export interface CourtBoardGroup {
  courtLabel: string;
  matches: MatchView[];
  /** The match on this court now, else the next one waiting for a result or to start. */
  currentMatchId: string | null;
  byStatus: Partial<Record<MatchStatus, number>>;
}

export interface CourtBoard {
  courts: CourtBoardGroup[];
  bracketRounds: number;
  total: number;
  byStatus: Partial<Record<MatchStatus, number>>;
}

export const UNASSIGNED_COURT = "Unassigned";

const CURRENT_ORDER: Partial<Record<MatchStatus, number>> = { in_progress: 0, awaiting_scores: 1, disputed: 2, scheduled: 3 };

export function getCourtBoard(tournamentId: string): CourtBoard {
  const all = listMatches(tournamentId);
  const bracketRounds = all.filter((m) => m.match.poolId === null).reduce((n, m) => Math.max(n, m.match.round), 0);
  const groups = new Map<string, MatchView[]>();
  for (const view of all) {
    const key = view.match.courtLabel ?? UNASSIGNED_COURT;
    const list = groups.get(key) ?? [];
    list.push(view);
    groups.set(key, list);
  }
  const byStatus: CourtBoard["byStatus"] = {};
  for (const m of all) byStatus[m.match.status] = (byStatus[m.match.status] ?? 0) + 1;

  const courts: CourtBoardGroup[] = [...groups.entries()]
    .sort(([a], [b]) => (a === UNASSIGNED_COURT ? 1 : b === UNASSIGNED_COURT ? -1 : a.localeCompare(b, undefined, { numeric: true })))
    .map(([courtLabel, matches]) => {
      const ordered = [...matches].sort((x, y) => (x.match.scheduledAt ?? 0) - (y.match.scheduledAt ?? 0) || x.match.round - y.match.round || (x.match.bracketPosition ?? 0) - (y.match.bracketPosition ?? 0));
      const current = ordered
        .filter((m) => CURRENT_ORDER[m.match.status] !== undefined && (m.match.status !== "scheduled" || (m.teamA && m.teamB)))
        .sort((x, y) => (CURRENT_ORDER[x.match.status] ?? 9) - (CURRENT_ORDER[y.match.status] ?? 9) || (x.match.scheduledAt ?? 0) - (y.match.scheduledAt ?? 0))[0];
      const counts: CourtBoardGroup["byStatus"] = {};
      for (const m of ordered) counts[m.match.status] = (counts[m.match.status] ?? 0) + 1;
      return { courtLabel, matches: ordered, currentMatchId: current?.match.id ?? null, byStatus: counts };
    });
  return { courts, bracketRounds, total: all.length, byStatus };
}
