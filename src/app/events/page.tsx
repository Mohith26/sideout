import type { Metadata } from "next";
import { Container } from "@/components/shell/Container";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { EmptyState } from "@/components/ui/EmptyState";
import { TournamentCard } from "@/components/tournament/TournamentCard";
import { listTournamentSummaries, type TournamentSummary } from "@/db/queries/tournaments";
import type { TournamentStatus } from "@/db/schema";
import { load } from "@/lib/load";
import { requestNow } from "@/lib/clock";
import { sweepDueDonations } from "@/server/donations/stub-provider";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Events" };

const GROUPS: ReadonlyArray<{ key: string; label: string; statuses: readonly TournamentStatus[]; order: "asc" | "desc" }> = [
  { key: "live", label: "Live", statuses: ["live"], order: "asc" },
  { key: "upcoming", label: "Upcoming", statuses: ["registration_open", "registration_closed"], order: "asc" },
  { key: "past", label: "Past", statuses: ["awaiting_settlement", "settled", "cancelled"], order: "desc" },
];

export default function EventsPage() {
  const nowMs = requestNow();
  const loaded = load(() => {
    sweepDueDonations(nowMs);
    return listTournamentSummaries();
  });
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const all = loaded.data;

  const groups = GROUPS.map((g) => ({
    ...g,
    items: all
      .filter((s) => g.statuses.includes(s.tournament.status))
      .sort((a, b) => (g.order === "asc" ? a.tournament.startsAt - b.tournament.startsAt : b.tournament.startsAt - a.tournament.startsAt)),
  })).filter((g) => g.items.length > 0);

  return (
    <Container className="space-y-10 py-6 md:py-8">
      <h1 className="type-display-l">Events</h1>
      {groups.length === 0 ? (
        <EmptyState level={2} icon="calendar" title="No events yet" body="Events appear here once an organizer creates one." />
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-labelledby={`events-${g.key}`}>
            <h2 id={`events-${g.key}`} className="type-label mb-3 text-text-tertiary">
              {g.label} · <span className="tabular">{g.items.length}</span>
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {g.items.map((s: TournamentSummary) => (
                <TournamentCard key={s.tournament.id} summary={s} nowMs={nowMs} />
              ))}
            </div>
          </section>
        ))
      )}
    </Container>
  );
}
