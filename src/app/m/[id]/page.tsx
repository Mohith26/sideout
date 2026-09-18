import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConsensusBadge } from "@/components/consensus/ConsensusBadge";
import { ScoreSubmitSheet } from "@/components/consensus/ScoreSubmitSheet";
import { ScorelineCompare, ScorelineTable } from "@/components/consensus/ScorelineCompare";
import { LiveDot } from "@/components/motion/LiveDot";
import { ScoreDisplay } from "@/components/motion/ScoreDisplay";
import { Container } from "@/components/shell/Container";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { LiveRefresh } from "@/components/ui/LiveRefresh";
import { MATCH_STATUS_PILL, StatusPill } from "@/components/ui/StatusPill";
import { getMatchConsensusContext, type ConsensusView, type SubmissionView } from "@/db/queries/consensus";
import { bracketRoundLabel, getBracketRoundCount, getMatchDetail, isPublished, type MatchDetail } from "@/db/queries/tournaments";
import { toPerspective } from "@/domain/consensus";
import type { Side } from "@/domain/scoreline";
import { cx } from "@/lib/cx";
import { formatDate, formatTime } from "@/lib/format";
import { loadAsync } from "@/lib/load";
import { viewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";

/** Seconds between refreshes while the match can still change; the standings API caches for the same 10s. */
const LIVE_REFRESH_MS = 10_000;

/**
 * Match detail (spec §11.3): the two teams, court and round, where the
 * consensus stands, the agreed sets once final, and — for a signed-in member
 * of either team while the match is open, a scheduled match with both teams
 * included — the score submission sheet; the first submission takes it on
 * the sand.
 *
 * What each viewer sees of the submissions is deliberate: a team sees its own
 * scoreline while waiting, never the opponent's, so the second submission is
 * independent; both teams and the organizer see the two readings side by side
 * once they differ, and keep seeing them as history after an organizer forfeit
 * settles the match; everyone sees the agreed sets once the match is final.
 * The match status, not the consensus row, says whether a dispute is open.
 */

interface Loaded {
  detail: MatchDetail;
  bracketRounds: number;
  consensus: ConsensusView | null;
  viewerSide: Side | null;
  viewerRole: "player" | "organizer" | null;
}

async function loadMatch(id: string): Promise<Loaded | null> {
  const detail = getMatchDetail(id);
  if (!detail) return null;
  const user = await viewer();
  if (!isPublished(detail.tournament.status) && user?.role !== "organizer") return null;
  const { consensus, viewerSide } = getMatchConsensusContext(detail, user?.id ?? null);
  return { detail, bracketRounds: getBracketRoundCount(detail.tournament.id), consensus, viewerSide, viewerRole: user?.role ?? null };
}

export async function generateMetadata({ params }: PageProps<"/m/[id]">): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadAsync(() => loadMatch(id));
  if (!loaded.ok || !loaded.data) return { title: "Match" };
  const { detail } = loaded.data;
  return { title: `${detail.teamA?.name ?? "TBD"} vs ${detail.teamB?.name ?? "TBD"} · ${detail.tournament.name}` };
}

function roundLabel(detail: MatchDetail, bracketRounds: number): string {
  if (detail.match.poolId !== null) return `${detail.poolLabel ?? "Pool"} · round ${detail.match.round}`;
  return bracketRoundLabel(detail.match.round, bracketRounds);
}

function Scoreboard({ detail }: { detail: MatchDetail }) {
  const { match, sets, teamA, teamB } = detail;
  const live = match.status === "in_progress";
  const showSets = sets.length > 0 && match.status !== "disputed";
  const winner = match.winnerTeamId ? (match.winnerTeamId === match.teamAId ? "a" : "b") : null;
  const line = (side: "a" | "b") => {
    const team = side === "a" ? teamA : teamB;
    const won = winner === side;
    return (
      <div className={cx("flex items-center justify-between gap-4", won ? "text-text-primary" : "text-text-secondary")}>
        <span className="flex min-w-0 items-center gap-3">
          {team?.seed !== null && team?.seed !== undefined ? <span className="tabular type-label text-text-tertiary">{team.seed}</span> : null}
          <span className="min-w-0 type-heading break-words">{team ? team.name : match.status === "bye" && side === "b" ? "Bye" : "TBD"}</span>
          {won ? <Icons.check size={18} className="shrink-0 text-surf" aria-label="Winner" /> : null}
        </span>
        {showSets ? (
          <span className={cx("flex shrink-0 gap-3 type-display-l", live ? "text-surf" : won ? "text-text-primary" : "text-text-tertiary")} aria-live={live ? "polite" : "off"}>
            {sets.map((s) => (
              <ScoreDisplay key={s.setNumber} value={side === "a" ? s.teamAPoints : s.teamBPoints} className="w-[2ch] text-end" />
            ))}
          </span>
        ) : null}
      </div>
    );
  };
  return (
    <div className="surface-raised space-y-3 rounded-md p-4 md:p-5">
      {line("a")}
      {line("b")}
      {live ? (
        <p className="flex items-center gap-2 type-label text-surf">
          <LiveDot />
          Set {sets.length || 1} in play
        </p>
      ) : null}
      {teamA || teamB ? (
        <p className="type-label text-text-tertiary">
          {[teamA, teamB]
            .filter((t): t is NonNullable<typeof t> => t !== null)
            .map((t) => `${t.name}: ${t.members.map((m) => m.displayName).join(" & ")}`)
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function SubmissionHistory({ consensus, detail }: { consensus: ConsensusView; detail: MatchDetail }) {
  const tz = detail.tournament.venueTimezone;
  const rows: SubmissionView[] = [...consensus.history].sort((x, y) => x.createdAt - y.createdAt);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading" className="type-label mb-3 text-text-tertiary">
        Score history
      </h2>
      <ol className="surface-raised divide-y divide-border-subtle rounded-md">
        {rows.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
            <span className="min-w-0 text-text-primary">
              {s.teamId === null ? <span className="font-medium">Organizer</span> : <span className="font-medium">{s.teamName}</span>}
              <span className="text-text-tertiary"> · {s.submittedBy.displayName}</span>
              {s.supersededById ? <span className="ml-2 rounded-xs bg-bg-inset px-1.5 py-0.5 type-label text-text-tertiary">Replaced</span> : null}
            </span>
            <span className="tabular type-label text-text-tertiary">
              {formatDate(s.createdAt, tz)} · {formatTime(s.createdAt, tz)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default async function MatchPage({ params }: PageProps<"/m/[id]">) {
  const { id } = await params;
  const loaded = await loadAsync(() => loadMatch(id));
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  if (!loaded.data) notFound();
  const { detail, bracketRounds, consensus, viewerSide, viewerRole } = loaded.data;
  const { match, teamA, teamB, tournament } = detail;
  const tz = tournament.venueTimezone;
  const state = consensus?.state ?? null;

  const us = viewerSide === "a" ? teamA : viewerSide === "b" ? teamB : null;
  const them = viewerSide === "a" ? teamB : viewerSide === "b" ? teamA : null;
  const liveTeam = consensus?.live.filter((s) => s.teamId !== null) ?? [];
  const ours = us ? (liveTeam.find((s) => s.teamId === us.id) ?? null) : null;
  const theirs = them ? (liveTeam.find((s) => s.teamId === them.id) ?? null) : null;
  const submittedBy = liveTeam[0]?.teamName ?? null;
  const waitingOn = submittedBy ? (liveTeam[0]?.teamId === match.teamAId ? teamB?.name : teamA?.name) : null;

  const open = (match.status === "scheduled" || match.status === "in_progress" || match.status === "awaiting_scores") && (state === null || state === "awaiting_first" || state === "awaiting_second");
  const canSubmit = open && tournament.status === "live" && us !== null && them !== null && viewerSide !== null;
  const disputed = match.status === "disputed";
  const settledByForfeit = match.status === "forfeited" && state === "disputed";
  const showCompare = (disputed || settledByForfeit) && (viewerSide !== null || viewerRole === "organizer") && liveTeam.length === 2;
  const winnerSide = match.winnerTeamId ? (match.winnerTeamId === match.teamAId ? "a" : "b") : null;
  // While the match can still change, re-render on a cadence so a submission from the other phone shows up and the score rolls.
  const refreshes = tournament.status === "live" && (match.status === "scheduled" || match.status === "in_progress" || match.status === "awaiting_scores" || match.status === "disputed");

  return (
    <Container className="space-y-8 py-6 md:py-8">
      {refreshes ? <LiveRefresh intervalMs={LIVE_REFRESH_MS} /> : null}
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 type-label text-text-tertiary">
        <Link href={`/t/${tournament.slug}`} className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary">
          {tournament.name}
        </Link>
        <Icons.chevronRight size={12} />
        <span>{roundLabel(detail, bracketRounds)}</span>
        {match.courtLabel ? (
          <>
            <Icons.chevronRight size={12} />
            <span>{match.courtLabel}</span>
          </>
        ) : null}
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill spec={MATCH_STATUS_PILL[match.status]} />
          {match.scheduledAt ? (
            <span className="tabular type-label text-text-tertiary">
              {formatDate(match.scheduledAt, tz)} · {formatTime(match.scheduledAt, tz)}
            </span>
          ) : null}
          <span className="type-label text-text-tertiary">Best of {match.bestOf}</span>
        </div>
        <h1 className="sr-only">
          {teamA?.name ?? "TBD"} vs {teamB?.name ?? "TBD"}
        </h1>
        <Scoreboard detail={detail} />
        {match.status !== "scheduled" && match.status !== "bye" && match.status !== "forfeited" ? (
          <ConsensusBadge state={state} submittedBy={submittedBy} waitingOn={waitingOn} resolvedBy={consensus?.resolvedBy?.displayName ?? null} />
        ) : null}
      </header>

      {canSubmit && us && them && viewerSide ? (
        <section aria-labelledby="submit-heading" className="surface-overlay rounded-lg p-4 md:p-5" data-testid="submit-panel">
          <h2 id="submit-heading" className="type-subheading">
            {ours ? `Waiting on ${them.name}` : theirs ? `${them.name} has submitted` : "Report the result"}
          </h2>
          <p className="mt-1 text-text-secondary">
            {ours
              ? `Your scoreline is in. Nothing is final until ${them.name} submits the same result from their phone; both teams must agree.`
              : theirs
                ? "Enter the result as you have it. If it matches, the match is final; if not, the organizer settles it with both teams."
                : "Enter every set with your points first. Your opponent does the same from their side, and the match is final once the two agree."}
          </p>
          {ours ? (
            <div className="mt-4 space-y-2">
              <p className="type-label text-text-tertiary">
                Your submission · {ours.submittedBy.displayName} · {formatTime(ours.createdAt, tz)}
              </p>
              <ScorelineTable teamA={teamA?.name ?? "Team A"} teamB={teamB?.name ?? "Team B"} sets={ours.sets} winner={null} />
            </div>
          ) : null}
          <div className="mt-4">
            <ScoreSubmitSheet
              matchId={match.id}
              bestOf={match.bestOf}
              us={{ id: us.id, name: us.name }}
              them={{ id: them.id, name: them.name }}
              perspective={viewerSide}
              existing={ours ? toPerspective(ours.sets, viewerSide) : null}
              opponentSubmitted={theirs !== null}
            />
          </div>
        </section>
      ) : null}

      {showCompare && consensus ? (
        <section aria-labelledby="compare-heading" className="space-y-4" data-testid="dispute-compare">
          <h2 id="compare-heading" className="type-subheading">
            Two readings of this match
          </h2>
          {disputed ? (
            <div className="flex items-start gap-3 rounded-md border border-fault/40 bg-fault/10 p-4">
              <Icons.triangleAlert size={20} className="mt-0.5 shrink-0 text-fault" />
              <p className="text-text-primary">The two scorelines don&apos;t match. The organizer will settle it with both teams; nothing is final until then.</p>
            </div>
          ) : (
            <div className="surface-inset flex items-start gap-3 rounded-md p-4" data-testid="settled-by-forfeit">
              <Icons.info size={20} className="mt-0.5 shrink-0 text-text-tertiary" />
              <p className="text-text-secondary">
                The two scorelines didn&apos;t match. The organizer{consensus.resolvedBy ? ` (${consensus.resolvedBy.displayName})` : ""} settled this match by forfeit; the readings below are kept as history and neither is the result.
              </p>
            </div>
          )}
          <ScorelineCompare
            teamA={teamA?.name ?? "Team A"}
            teamB={teamB?.name ?? "Team B"}
            left={{ label: liveTeam[0]?.teamId === us?.id ? "Your team" : (liveTeam[0]?.teamName ?? "Team"), sets: liveTeam[0]?.sets ?? [], note: `${liveTeam[0]?.submittedBy.displayName ?? ""} · ${formatTime(liveTeam[0]?.createdAt ?? 0, tz)}` }}
            right={{ label: liveTeam[1]?.teamId === us?.id ? "Your team" : (liveTeam[1]?.teamName ?? "Team"), sets: liveTeam[1]?.sets ?? [], note: `${liveTeam[1]?.submittedBy.displayName ?? ""} · ${formatTime(liveTeam[1]?.createdAt ?? 0, tz)}` }}
            differingSets={consensus.differences.map((d) => d.setNumber)}
          />
          {disputed && viewerRole === "organizer" ? (
            <Button variant="primary" href="/organizer/disputes" iconEnd={<Icons.chevronRight size={16} />}>
              Resolve in the dispute queue
            </Button>
          ) : null}
        </section>
      ) : null}

      {match.status === "final" && consensus?.agreedSets ? (
        <section aria-labelledby="result-heading" className="space-y-3">
          <h2 id="result-heading" className="type-label text-text-tertiary">
            Agreed result
          </h2>
          <ScorelineTable teamA={teamA?.name ?? "Team A"} teamB={teamB?.name ?? "Team B"} sets={consensus.agreedSets} winner={winnerSide} />
        </section>
      ) : null}

      {match.status === "final" && consensus ? <SubmissionHistory consensus={consensus} detail={detail} /> : null}

      {detail.next ? (
        <p className="type-label text-text-tertiary">
          Winner advances to{" "}
          <Link href={`/m/${detail.next.matchId}`} className="text-text-secondary hover:text-text-primary">
            {detail.next.bracketPosition !== null ? `bracket match ${detail.next.bracketPosition}` : "the next round"}
          </Link>
          .
        </p>
      ) : null}
    </Container>
  );
}
