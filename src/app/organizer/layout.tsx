import type { Metadata } from "next";
import { SkyBand, WaveDivider } from "@/components/art";
import { ConsoleNav, type ConsoleNavItem } from "@/components/organizer/ConsoleNav";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { countDisputedMatches } from "@/db/queries/console";
import { loadAsync } from "@/lib/load";
import { requireOrganizerViewer } from "./_lib";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { default: "Console", template: "%s · Console · Sideout" } };

/**
 * Organizer console shell (spec §11.6): role-gated here for every page beneath
 * it, with its own dense navigation. The beach stays in the header band (the
 * sky strip over the console label); the pages beneath are calm and dense. The dispute queue and the close flow are
 * the consensus phase's pages; they render beneath this layout and gate
 * themselves. "Lucra" is the audit page (`/admin/lucra`), which lists every
 * event's targeting state, alerts and writes; each event's participant
 * reconciliation is `/organizer/events/[id]/lucra`, linked from the builder.
 */
export default async function OrganizerLayout({ children }: LayoutProps<"/organizer">) {
  const loaded = await loadAsync(async () => {
    await requireOrganizerViewer();
    return countDisputedMatches();
  });
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const items: ConsoleNavItem[] = [
    { href: "/organizer/events", label: "Events", icon: "calendar" },
    { href: "/organizer/disputes", label: "Disputes", icon: "triangleAlert", badge: loaded.data },
    { href: "/admin/lucra", label: "Lucra", icon: "shieldCheck" },
  ];
  return (
    <>
      {/* The band shows where the app header does not (the rail breakpoint); on a phone the header's sky is directly above. */}
      <div className="relative hidden xl:block">
        <SkyBand variant="console" />
        <div className="relative mx-auto flex h-10 max-w-content items-center px-gutter">
          <span className="type-label font-semibold text-text-primary">Console</span>
        </div>
        <WaveDivider fill="raised" height={10} className="relative" />
      </div>
      <div className="border-b border-border-subtle bg-bg-raised">
        <div className="mx-auto flex max-w-content items-center gap-4 px-gutter">
          <ConsoleNav items={items} />
        </div>
      </div>
      {children}
    </>
  );
}
