import type { Metadata } from "next";
import { ConsoleNav, type ConsoleNavItem } from "@/components/organizer/ConsoleNav";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { countDisputedMatches } from "@/db/queries/console";
import { loadAsync } from "@/lib/load";
import { requireOrganizerViewer } from "./_lib";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { default: "Console", template: "%s · Console · Sideout" } };

/**
 * Organizer console shell (spec §11.6): role-gated here for every page beneath
 * it, with its own dense navigation. The dispute queue and the close flow are
 * the consensus phase's pages; they render beneath this layout and gate
 * themselves. The Lucra audit page (`/admin/lucra`, spec §11.6) joins this nav
 * in phase 4.
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
  ];
  return (
    <>
      <div className="border-b border-border-subtle bg-bg-base">
        <div className="mx-auto flex max-w-content items-center gap-4 px-gutter pt-3">
          <span className="type-label text-text-tertiary">Console</span>
          <ConsoleNav items={items} />
        </div>
      </div>
      {children}
    </>
  );
}
