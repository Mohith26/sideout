import { Bracket } from "@/components/bracket/Bracket";
import { nodesFromMatches } from "@/components/bracket/model";
import { PoolSheets } from "@/components/bracket/PoolSheets";
import { Container } from "@/components/shell/Container";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveRefresh } from "@/components/ui/LiveRefresh";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getTournamentDetail } from "@/db/queries/tournaments";
import { drawConfigSchema } from "@/domain/draw";
import { requireTournament, viewerTeamId } from "../_lib";

export const dynamic = "force-dynamic";

/** Seconds between refreshes of a live event's bracket; the standings API caches for the same 10s. */
const LIVE_REFRESH_MS = 10_000;

function advancementNote(drawConfigJson: string | null, poolCount: number): string | null {
  if (!drawConfigJson) return null;
  const parsed = drawConfigSchema.safeParse(JSON.parse(drawConfigJson));
  if (!parsed.success) return null;
  const { perPool, bestRemaining } = parsed.data.advance;
  const parts = [`the top ${perPool} from each of the ${poolCount} pools`];
  if (bestRemaining > 0) parts.push(`the ${bestRemaining} best remaining`);
  return `Once pool play finishes, ${parts.join(" plus ")} advance and the bracket is seeded from the standings.`;
}

/**
 * Bracket tab (spec §11.2): pool sheets while the event is in pool play, the
 * SVG bracket once its first round has teams; a live event refreshes itself.
 */
export default async function BracketPage({ params }: PageProps<"/t/[slug]">) {
  const { slug } = await params;
  const summary = await requireTournament(slug);
  const { tournament: t } = summary;
  const detail = getTournamentDetail(summary);
  const highlight = await viewerTeamId(t.id);
  const nodes = nodesFromMatches(detail.bracket.matches);
  const bracketSeeded = nodes.some((n) => n.teamA !== null || n.teamB !== null);
  const live = t.status === "live";
  const poolsDone = detail.pools.length > 0 && detail.pools.every((p) => p.played === p.total);

  if (detail.pools.length === 0 && nodes.length === 0) {
    return (
      <Container className="py-6 md:py-8">
        <EmptyState
          icon="bracket"
          title="No draw yet"
          body={`Pools and the bracket are generated once registration closes. ${summary.activeTeams} of ${t.maxTeams} teams are in so far.`}
        />
      </Container>
    );
  }

  return (
    <Container className="space-y-10 py-6 md:py-8">
      {live ? <LiveRefresh intervalMs={LIVE_REFRESH_MS} /> : null}

      {bracketSeeded ? (
        <section aria-labelledby="bracket-heading">
          <SectionHeading id="bracket-heading" aside={<span className="tabular">{detail.bracket.rounds} rounds</span>}>
            Bracket
          </SectionHeading>
          <Bracket nodes={nodes} timeZone={t.venueTimezone} label={`${t.name} bracket`} />
        </section>
      ) : nodes.length > 0 ? (
        <section aria-labelledby="bracket-heading">
          <SectionHeading id="bracket-heading">Bracket</SectionHeading>
          <EmptyState
            icon="bracket"
            title={poolsDone ? "Bracket seeding is next" : "Bracket unlocks after pool play"}
            body={advancementNote(t.drawConfigJson, detail.pools.length) ?? `${nodes.length} bracket matches are drawn and will be filled from the pool standings.`}
          />
        </section>
      ) : null}

      {detail.pools.length > 0 ? (
        <section aria-labelledby="pools-heading">
          <SectionHeading id="pools-heading" aside={<span className="tabular">{detail.pools.length} pools</span>}>
            {bracketSeeded ? "Pool play results" : "Pool play"}
          </SectionHeading>
          <PoolSheets pools={detail.pools} timeZone={t.venueTimezone} highlightTeamId={highlight} />
          <p className="mt-3 type-label text-text-tertiary">Cells show each meeting from the row team&apos;s side. Open a cell for the match.</p>
        </section>
      ) : null}
    </Container>
  );
}
