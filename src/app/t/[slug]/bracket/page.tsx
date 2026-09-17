import { Container } from "@/components/shell/AppShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { getTournamentOverview } from "@/db/queries/tournaments";
import { requireTournament } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Honest placeholder. The SVG bracket, pan/zoom and advancement animation are
 * the draw engine's job (phase 2 logic, phase 5 motion). Nothing is faked here;
 * the counts below are read from the rows that already exist.
 */
export default async function BracketPage({ params }: PageProps<"/t/[slug]">) {
  const { slug } = await params;
  const { tournament } = requireTournament(slug);
  const overview = getTournamentOverview(tournament.id);
  const bracketMatches = overview.rounds.filter((r) => r.key.startsWith("bracket-")).reduce((n, r) => n + r.total, 0);
  return (
    <Container className="py-6 md:py-8">
      <EmptyState
        icon="bracket"
        title="The bracket arrives with the draw engine"
        body={
          bracketMatches > 0
            ? `${bracketMatches} bracket matches are recorded for this event across ${overview.rounds.filter((r) => r.key.startsWith("bracket-")).length} rounds. The interactive bracket view is the next phase of the build; until then the schedule on Overview shows each round's status.`
            : "No draw has been generated for this event yet. Once registration closes, the draw engine builds pools and the bracket from the registered teams."
        }
      />
    </Container>
  );
}
