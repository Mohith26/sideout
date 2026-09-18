import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { TournamentHeader } from "@/components/tournament/TournamentHeader";
import { getDb } from "@/db/client";
import { loadAsync } from "@/lib/load";
import { requestNow } from "@/lib/clock";
import { settleDueDonations } from "@/server/donations/stub-provider";
import { findVisibleTournament } from "./_lib";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: LayoutProps<"/t/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const loaded = await loadAsync(() => findVisibleTournament(slug));
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
  const loaded = await loadAsync(() => {
    // Stub donation provider: pending intents past their delay become succeeded on read.
    settleDueDonations(getDb(), nowMs);
    return findVisibleTournament(slug);
  });
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
