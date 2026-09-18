import type { Metadata } from "next";
import { Container } from "@/components/shell/AppShell";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveMatchStrip } from "@/components/tournament/LiveMatchStrip";
import { TournamentCard } from "@/components/tournament/TournamentCard";
import { getBracketRoundCount, listLiveMatches, listTournamentSummaries, type TournamentSummary } from "@/db/queries/tournaments";
import { load } from "@/lib/load";
import { requestNow } from "@/lib/clock";
import { sweepDueDonations } from "@/server/donations/stub-provider";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live play",
};

const UPCOMING = new Set(["registration_open", "registration_closed"]);
const PAST = new Set(["settled", "awaiting_settlement", "cancelled"]);

/**
 * Home opens into the state of play (spec §11.1): the live strip when an event
 * is in progress, then the featured event, upcoming events, and past events
 * with what each raised. No hero, no marketing.
 */
export default function HomePage() {
  const nowMs = requestNow();
  const loaded = load(() => {
    // Stub donation provider: pending intents past their delay become succeeded on read.
    sweepDueDonations(nowMs);
    const summaries = listTournamentSummaries();
    const live = summaries.filter((s) => s.tournament.status === "live");
    const strips = live.map((s) => ({
      summary: s,
      matches: listLiveMatches(s.tournament.id),
      bracketRounds: getBracketRoundCount(s.tournament.id),
    }));
    return { summaries, strips };
  });
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;

  const { summaries, strips } = loaded.data;
  const upcoming = summaries.filter((s) => UPCOMING.has(s.tournament.status)).sort((a, b) => a.tournament.startsAt - b.tournament.startsAt);
  const past = summaries.filter((s) => PAST.has(s.tournament.status)).sort((a, b) => b.tournament.startsAt - a.tournament.startsAt);
  const featured: TournamentSummary | undefined = strips[0]?.summary ?? upcoming[0];
  const otherUpcoming = upcoming.filter((s) => s !== featured);

  return (
    <>
      {strips.map((strip) => (
        <LiveMatchStrip
          key={strip.summary.tournament.id}
          tournamentName={strip.summary.tournament.name}
          slug={strip.summary.tournament.slug}
          matches={strip.matches}
          bracketRounds={strip.bracketRounds}
        />
      ))}

      <Container className="space-y-10 py-6 md:py-8">
        {featured ? (
          <section aria-labelledby="featured-heading">
            <h2 id="featured-heading" className="type-label mb-3 text-text-tertiary">
              {featured.tournament.status === "live" ? "Happening now" : "Next up"}
            </h2>
            <TournamentCard summary={featured} variant="featured" nowMs={nowMs} />
          </section>
        ) : (
          <EmptyState icon="calendar" title="No events scheduled" body="When an organizer opens registration, it shows up here first." />
        )}

        {otherUpcoming.length > 0 ? (
          <section aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading" className="type-label mb-3 text-text-tertiary">
              Upcoming
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {otherUpcoming.map((s) => (
                <TournamentCard key={s.tournament.id} summary={s} nowMs={nowMs} />
              ))}
            </div>
          </section>
        ) : null}

        {past.length > 0 ? (
          <section aria-labelledby="past-heading">
            <h2 id="past-heading" className="type-label mb-3 text-text-tertiary">
              Past events
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {past.map((s) => (
                <TournamentCard key={s.tournament.id} summary={s} nowMs={nowMs} />
              ))}
            </div>
          </section>
        ) : null}
      </Container>
    </>
  );
}
