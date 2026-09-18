import type { Metadata } from "next";
import { DisputeCard } from "@/components/consensus/DisputeCard";
import { Container } from "@/components/shell/AppShell";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { OrganizerAccessRequired } from "@/components/shell/OrganizerAccessRequired";
import { EmptyState } from "@/components/ui/EmptyState";
import { listDisputes } from "@/db/queries/consensus";
import { getTournamentSummaryById } from "@/db/queries/tournaments";
import { load, loadAsync } from "@/lib/load";
import { organizerViewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Disputes" };

/**
 * The dispute queue (spec §11.6): the organizer console's primary alert
 * surface. Every match whose two scorelines differ, oldest first, each with
 * a resolve form. The organizer's scoreline is authoritative and attributed.
 * The gate runs first: nobody else's render reads a single dispute.
 */
export default async function DisputesPage() {
  const gate = await loadAsync(() => organizerViewer());
  if (!gate.ok) return <DatabaseNotReady message={gate.message} />;
  if (!gate.data.organizer) return <OrganizerAccessRequired user={gate.data.user} />;
  const loaded = load(() => {
    const disputes = listDisputes();
    const timezones = new Map<string, string>();
    for (const d of disputes) {
      if (!timezones.has(d.tournament.id)) timezones.set(d.tournament.id, getTournamentSummaryById(d.tournament.id)?.tournament.venueTimezone ?? "UTC");
    }
    return { disputes, timezones };
  });
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const { disputes, timezones } = loaded.data;
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <header>
        <p className="type-label text-text-tertiary">Organizer console</p>
        <h1 className="mt-1 type-display-l">Disputes</h1>
        <p className="mt-2 max-w-prose text-text-secondary">
          A match lands here when the two teams submit different scorelines. Neither reading counts until you settle it; what you enter is recorded as your decision and moves the winner on.
        </p>
      </header>
      {disputes.length === 0 ? (
        <EmptyState icon="circleCheck" title="No open disputes" body="Every submitted result agrees. Matches show up here the moment two scorelines differ." />
      ) : (
        <div className="space-y-4">
          <p className="tabular type-label text-fault">
            {disputes.length} {disputes.length === 1 ? "match" : "matches"} to settle
          </p>
          {disputes.map((d) => (
            <DisputeCard key={d.match.id} dispute={d} timeZone={timezones.get(d.tournament.id) ?? "UTC"} />
          ))}
        </div>
      )}
    </Container>
  );
}
