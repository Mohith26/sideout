import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ForfeitControl } from "@/components/organizer/ForfeitControl";
import { Container } from "@/components/shell/Container";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icons } from "@/components/ui/icons";
import { LiveRefresh } from "@/components/ui/LiveRefresh";
import { MATCH_STATUS_PILL, StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { getCourtBoard, type CourtBoardGroup } from "@/db/queries/board";
import { getTournamentSummaryById, type MatchView } from "@/db/queries/tournaments";
import { MATCH_STATUSES, type MatchStatus } from "@/db/schema";
import { RESOLVABLE_STATUSES } from "@/domain/bracket";
import { formatTime } from "@/lib/format";
import { bracketRoundLabel } from "@/lib/rounds";
import { cx } from "@/lib/cx";
import { requireOrganizerViewer } from "../../../_lib";

export const dynamic = "force-dynamic";

const LIVE_REFRESH_MS = 10_000;

export async function generateMetadata({ params }: PageProps<"/organizer/events/[id]/board">): Promise<Metadata> {
  const { id } = await params;
  const name = getTournamentSummaryById(id)?.tournament.name;
  return { title: name ? `${name} board` : "Live board" };
}

function StatusCounts({ byStatus }: { byStatus: Partial<Record<MatchStatus, number>> }) {
  const parts = MATCH_STATUSES.filter((s) => (byStatus[s] ?? 0) > 0);
  return (
    <span className="flex flex-wrap gap-1.5">
      {parts.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StatusPill spec={MATCH_STATUS_PILL[s]} size="sm" />
          <span className="tabular type-label text-text-tertiary">{byStatus[s]}</span>
        </span>
      ))}
    </span>
  );
}

function Sets({ view, side }: { view: MatchView; side: "a" | "b" }) {
  if (view.sets.length === 0 || view.match.status === "disputed") return null;
  return (
    <span className={cx("tabular flex shrink-0 gap-2 type-mono-stat", view.match.status === "in_progress" ? "text-surf" : "text-text-secondary")}>
      {view.sets.map((s) => (
        <span key={s.id} className="w-6 text-end">
          {side === "a" ? s.teamAPoints : s.teamBPoints}
        </span>
      ))}
    </span>
  );
}

function CourtColumn({ group, bracketRounds, timeZone, live }: { group: CourtBoardGroup; bracketRounds: number; timeZone: string; live: boolean }) {
  return (
    <section aria-label={group.courtLabel} className="surface-raised flex min-w-0 flex-col rounded-md">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2.5">
        <h2 className="type-subheading">
          {group.courtLabel}
        </h2>
        <StatusCounts byStatus={group.byStatus} />
      </div>
      <ol className="divide-y divide-border-subtle">
        {group.matches.map((view) => {
          const { match, teamA, teamB } = view;
          const current = match.id === group.currentMatchId;
          const roundLabel = match.poolId === null ? bracketRoundLabel(match.round, bracketRounds) : `${view.poolLabel ?? "Pool"} · R${match.round}`;
          const winner = match.winnerTeamId;
          const forfeitable = live && RESOLVABLE_STATUSES.has(match.status) && teamA && teamB;
          return (
            <li key={match.id} data-match-id={match.id} data-current={current ? "true" : undefined} className={cx("p-3", current && "bg-bg-overlay")}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 type-label text-text-tertiary">
                  <span className="tabular">{match.scheduledAt === null ? "—" : formatTime(match.scheduledAt, timeZone)}</span>
                  <span className="truncate">{roundLabel}</span>
                  {current ? <span className={cx(match.status === "in_progress" ? "text-surf" : "text-text-secondary")}>· now</span> : null}
                </span>
                <StatusPill spec={MATCH_STATUS_PILL[match.status]} size="sm" />
              </div>
              <div className="mt-2 space-y-1">
                <div className={cx("flex items-center justify-between gap-3", winner && winner === teamA?.id ? "text-text-primary" : "text-text-secondary")}>
                  <span className="min-w-0 truncate font-medium">{teamA ? `${teamA.seed !== null ? `${teamA.seed} ` : ""}${teamA.name}` : "TBD"}</span>
                  <Sets view={view} side="a" />
                </div>
                <div className={cx("flex items-center justify-between gap-3", winner && winner === teamB?.id ? "text-text-primary" : "text-text-secondary")}>
                  <span className="min-w-0 truncate font-medium">{match.status === "bye" ? <span className="text-text-tertiary">Bye</span> : teamB ? `${teamB.seed !== null ? `${teamB.seed} ` : ""}${teamB.name}` : "TBD"}</span>
                  <Sets view={view} side="b" />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <Link href={`/m/${match.id}`} className="target inline-flex items-center gap-1 type-label text-text-secondary hover:text-text-primary">
                  Match
                  <Icons.chevronRight size={14} />
                </Link>
                {forfeitable && teamA && teamB ? <ForfeitControl matchId={match.id} teamA={{ id: teamA.id, name: teamA.name }} teamB={{ id: teamB.id, name: teamB.name }} /> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Court-by-court live board (spec §11.6): every match on every court in
 * schedule order, what each court is playing now, and a quick forfeit for a
 * match that can still be resolved. Disputes are the dispute queue's job; the
 * count here links there.
 */
export default async function LiveBoardPage({ params }: PageProps<"/organizer/events/[id]/board">) {
  const { id } = await params;
  await requireOrganizerViewer();
  const summary = getTournamentSummaryById(id);
  if (!summary) notFound();
  const { tournament: t } = summary;
  const board = getCourtBoard(t.id);
  const live = t.status === "live";

  return (
    <Container className="space-y-6 py-6 md:py-8">
      {live ? <LiveRefresh intervalMs={LIVE_REFRESH_MS} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/organizer/events/${t.id}`} className="target inline-flex items-center gap-1 rounded-sm type-label text-text-secondary hover:text-text-primary">
            <Icons.chevronLeft size={14} />
            {t.name}
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-display-l">Live board</h1>
            <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
          </div>
          <div className="mt-2">
            <StatusCounts byStatus={board.byStatus} />
          </div>
        </div>
        {(board.byStatus.disputed ?? 0) > 0 ? (
          <Link href="/organizer/disputes" className="target inline-flex items-center gap-2 rounded-sm border border-fault/40 bg-fault/10 px-3 type-label text-fault">
            <Icons.triangleAlert size={16} />
            {`${board.byStatus.disputed} disputed`}
            <Icons.chevronRight size={14} />
          </Link>
        ) : null}
      </div>

      {board.courts.length === 0 ? (
        <EmptyState level={2} icon="grid" title="No matches yet" body="The board fills when the draw is generated." />
      ) : (
        <div aria-live="polite" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {board.courts.map((group) => (
            <CourtColumn key={group.courtLabel} group={group} bracketRounds={board.bracketRounds} timeZone={t.venueTimezone} live={live} />
          ))}
        </div>
      )}
      {!live && board.courts.length > 0 ? <p className="type-label text-text-tertiary">Forfeits can only be recorded while the event is live.</p> : null}
    </Container>
  );
}
