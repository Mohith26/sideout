import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { TournamentHeader } from "@/components/tournament/TournamentHeader";
import { getTournamentSummaryBySlug } from "@/db/queries/tournaments";
import { load } from "@/lib/load";
import { requestNow } from "@/lib/clock";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: LayoutProps<"/t/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const loaded = load(() => getTournamentSummaryBySlug(slug));
  if (!loaded.ok || !loaded.data) return { title: "Event" };
  const { tournament, charity } = loaded.data;
  return {
    title: tournament.name,
    description: `${tournament.name} benefiting ${charity.name} — ${tournament.venueName}, ${tournament.venueCity}.`,
  };
}

/** Sticky header shared by the four tabs (spec §11.2). */
export default async function TournamentLayout({ params, children }: LayoutProps<"/t/[slug]">) {
  const { slug } = await params;
  const nowMs = requestNow();
  const loaded = load(() => getTournamentSummaryBySlug(slug));
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  if (!loaded.data) notFound();
  const { tournament, charity, liveMatchCount } = loaded.data;
  return (
    <>
      <TournamentHeader tournament={tournament} charity={charity} nowMs={nowMs} liveMatchCount={liveMatchCount} />
      {children}
    </>
  );
}
