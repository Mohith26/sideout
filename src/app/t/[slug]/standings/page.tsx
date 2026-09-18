import { StandingsFootnote, StandingsTable } from "@/components/bracket/StandingsTable";
import { FlipRows } from "@/components/motion/FlipRows";
import { Container } from "@/components/shell/Container";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveRefresh } from "@/components/ui/LiveRefresh";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getPoolStandings } from "@/db/queries/standings";
import { getTournamentOverview } from "@/db/queries/tournaments";
import { requireTournament, viewerTeamId } from "../_lib";

export const dynamic = "force-dynamic";

/** Matches the standings endpoint's `max-age=10`. */
const LIVE_REFRESH_MS = 10_000;

/**
 * Standings tab (spec §11.2): one table per pool from the same computation
 * `GET /api/tournaments/:slug/standings` serves, updated politely while live.
 * Rows carry stable team ids, and `FlipRows` slides any row that moved
 * between refreshes instead of letting it jump (spec §12.4, transition 2).
 */
export default async function StandingsPage({ params }: PageProps<"/t/[slug]">) {
  const { slug } = await params;
  const { tournament: t, activeTeams } = await requireTournament(slug);
  const standings = getPoolStandings(t.id);
  const overview = getTournamentOverview(t.id);
  const highlight = await viewerTeamId(t.id);
  const live = t.status === "live";

  if (standings.length === 0) {
    return (
      <Container className="py-6 md:py-8">
        <EmptyState
          level={2}
          scene="net"
          title="No pools yet"
          body={
            t.format === "single_elim"
              ? "This event is a straight bracket, so there are no pool standings; results live on the Bracket tab."
              : `Standings appear once the draw is generated and pool play begins. ${activeTeams} of ${t.maxTeams} teams are in so far.`
          }
        />
      </Container>
    );
  }

  const played = standings.reduce((n, p) => n + p.played, 0);
  const total = standings.reduce((n, p) => n + p.total, 0);

  return (
    <Container className="py-6 md:py-8">
      {live ? <LiveRefresh intervalMs={LIVE_REFRESH_MS} /> : null}
      <SectionHeading id="standings-heading" aside={<span className="tabular">{`${played} of ${total} pool matches played`}</span>}>
        Standings
      </SectionHeading>
      <FlipRows aria-live="polite" aria-atomic={false} className="grid gap-6 xl:grid-cols-2">
        {standings.map((pool) => {
          const teams = overview.pools.find((p) => p.id === pool.poolId)?.teams ?? [];
          return (
            <StandingsTable
              key={pool.poolId}
              label={pool.label}
              courtLabel={pool.courtLabel}
              rows={pool.rows}
              teams={teams}
              played={pool.played}
              total={pool.total}
              highlightTeamId={highlight}
            />
          );
        })}
      </FlipRows>
      <StandingsFootnote className="mt-6" />
    </Container>
  );
}
