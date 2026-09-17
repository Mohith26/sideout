import type { MatchView } from "@/db/queries/tournaments";
import { bracketRoundLabel } from "@/db/queries/tournaments";
import { MATCH_STATUS_PILL, StatusPill } from "@/components/ui/StatusPill";
import { TeamName } from "@/components/tournament/TeamName";
import { cx } from "@/lib/cx";

/**
 * One match as a card: court, round, both teams, and the set scores that exist.
 * A live match shows its provisional sets; a disputed one shows no numbers at
 * all, because there is no agreed number to show.
 */
export interface MatchCardProps {
  view: MatchView;
  bracketRounds: number;
  className?: string;
}

export function roundLabelFor(view: MatchView, bracketRounds: number): string {
  if (view.match.poolId !== null) return `${view.poolLabel ?? "Pool"} · round ${view.match.round}`;
  return bracketRoundLabel(view.match.round, bracketRounds);
}

export function MatchCard({ view, bracketRounds, className }: MatchCardProps) {
  const { match, sets, teamA, teamB } = view;
  const live = match.status === "in_progress";
  const showSets = sets.length > 0 && match.status !== "disputed";
  const winnerSide = match.winnerTeamId ? (match.winnerTeamId === match.teamAId ? "a" : "b") : null;
  const roundLabel = roundLabelFor(view, bracketRounds);
  const note =
    match.status === "in_progress"
      ? { text: `Set ${sets.length || 1} in play`, className: "text-surf" }
      : match.status === "disputed"
        ? { text: "Scorelines differ · organizer reviewing", className: "text-fault" }
        : match.status === "awaiting_scores"
          ? { text: "Waiting on both teams to confirm", className: "text-text-tertiary" }
          : null;
  return (
    <article
      aria-label={`${roundLabel} on ${match.courtLabel ?? "court"}`}
      className={cx("surface-raised flex w-72 shrink-0 flex-col gap-3 rounded-md p-3", live && "border-surf/40", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate type-label text-text-secondary">
          {match.courtLabel ?? "Court"}
          <span className="text-text-tertiary"> · {roundLabel}</span>
        </div>
        <StatusPill spec={MATCH_STATUS_PILL[match.status]} size="sm" className="shrink-0" />
      </div>
      <div className="space-y-1.5">
        <TeamLine team={teamA} points={showSets ? sets.map((s) => s.teamAPoints) : []} won={winnerSide === "a"} live={live} />
        <TeamLine team={teamB} points={showSets ? sets.map((s) => s.teamBPoints) : []} won={winnerSide === "b"} live={live} bye={match.status === "bye"} />
      </div>
      {note ? <div className={cx("type-label", note.className)}>{note.text}</div> : null}
    </article>
  );
}

function TeamLine({
  team,
  points,
  won,
  live,
  bye = false,
}: {
  team: MatchView["teamA"];
  points: number[];
  won: boolean;
  live: boolean;
  bye?: boolean;
}) {
  return (
    <div className={cx("flex items-center justify-between gap-3", won ? "text-text-primary" : "text-text-secondary")}>
      <span className="min-w-0 flex-1 truncate font-medium">
        {bye && !team ? <span className="text-text-tertiary">Bye</span> : <TeamName team={team} seed />}
      </span>
      {points.length ? (
        <span className={cx("tabular flex gap-2 type-mono-stat", live && "text-surf")}>
          {points.map((p, i) => (
            <span key={i} className="w-6 text-end">
              {p}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
