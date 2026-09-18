import { Container } from "@/components/shell/AppShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { getTournamentOverview } from "@/db/queries/tournaments";
import { requireTournament } from "../_lib";

export const dynamic = "force-dynamic";

/** Honest placeholder; standings with tiebreaks are phase 2 domain logic. */
export default async function StandingsPage({ params }: PageProps<"/t/[slug]">) {
  const { slug } = await params;
  const { tournament } = await requireTournament(slug);
  const overview = getTournamentOverview(tournament.id);
  const poolMatches = overview.rounds.filter((r) => r.key.startsWith("pool-")).reduce((n, r) => n + r.total, 0);
  return (
    <Container className="py-6 md:py-8">
      <EmptyState
        icon="table"
        title="Standings arrive with the draw engine"
        body={
          overview.pools.length > 0
            ? `${overview.pools.length} pools and ${poolMatches} pool matches are recorded. Per-pool tables with point-differential tiebreaks are the next phase of the build; the pool compositions are listed on Overview.`
            : "No pools exist for this event yet. Standings appear once the draw is generated and pool play begins."
        }
      />
    </Container>
  );
}
