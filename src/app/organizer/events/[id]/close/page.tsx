import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CloseFlow } from "@/components/consensus/CloseFlow";
import { Container } from "@/components/shell/AppShell";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { Icons } from "@/components/ui/icons";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { getTournamentSummaryById } from "@/db/queries/tournaments";
import { load } from "@/lib/load";
import { closedByName as findCloser, previewClose, readStoredClosePreview } from "@/server/close";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/organizer/events/[id]/close">): Promise<Metadata> {
  const { id } = await params;
  const loaded = load(() => getTournamentSummaryById(id));
  return { title: loaded.ok && loaded.data ? `Close · ${loaded.data.tournament.name}` : "Close event" };
}

/**
 * The close-tournament flow (spec §11.6): step one is the frozen preview of
 * final standings and projected payouts, or the list of every match still
 * blocking; step two is the explicit confirm that posts the preview hash.
 * Once closed, the page shows what was frozen.
 */
export default async function CloseTournamentPage({ params }: PageProps<"/organizer/events/[id]/close">) {
  const { id } = await params;
  const loaded = load(() => {
    const summary = getTournamentSummaryById(id);
    if (!summary) return null;
    const stored = readStoredClosePreview(summary.tournament);
    return { summary, preview: previewClose(id), stored, closedByName: stored ? findCloser(stored) : null };
  });
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  if (!loaded.data) notFound();
  const { summary, preview, stored, closedByName } = loaded.data;
  const t = summary.tournament;
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <header>
        <p className="type-label text-text-tertiary">Organizer console</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="type-display-l">Close {t.name}</h1>
          <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
        </div>
        <p className="mt-2 max-w-prose text-text-secondary">
          Closing freezes the final standings and the projected rewards exactly as previewed and moves the event to awaiting settlement. Nothing settles without this reviewable, frozen preview.
        </p>
        <Link href={`/t/${t.slug}`} className="mt-2 inline-flex items-center gap-1 type-label text-text-secondary hover:text-text-primary">
          Open the public event page
          <Icons.chevronRight size={14} />
        </Link>
      </header>
      <CloseFlow tournament={{ id: t.id, name: t.name, slug: t.slug, status: t.status, venueTimezone: t.venueTimezone }} preview={preview} stored={stored} closedByName={closedByName} />
    </Container>
  );
}
