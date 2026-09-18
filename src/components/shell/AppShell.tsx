import type { ReactNode } from "react";
import { navItemsFor } from "@/components/shell/nav";
import { NavRail } from "@/components/shell/NavRail";
import { TabBar } from "@/components/shell/TabBar";
import { Wordmark } from "@/components/shell/Wordmark";
import { ToastProvider } from "@/components/ui/Toast";
import { DatabaseNotReadyError } from "@/db/connection";
import { viewer } from "@/server/auth/viewer";

/**
 * Bottom tab bar on mobile, left rail from 1280px, one content column with
 * 16px gutters that grow to 32px at desktop (spec §12.3). The organizer
 * console tab appears only for an organizer session; the page itself is
 * gated again on the server.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const items = navItemsFor(await viewerRole());
  return (
    <ToastProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-sm focus:bg-volt focus:px-3 focus:py-2 focus:text-on-volt"
      >
        Skip to content
      </a>
      <NavRail items={items} />
      <div className="xl:pl-navrail">
        <header className="flex h-14 items-center border-b border-border-subtle px-gutter xl:hidden">
          <Wordmark />
        </header>
        <main id="main" className="pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px)+24px)] xl:pb-12">
          {children}
        </main>
      </div>
      <TabBar items={items} />
    </ToastProvider>
  );
}

/** The shell must render even before `npm run seed`; without a database there is no session either. */
async function viewerRole(): Promise<"player" | "organizer" | null> {
  try {
    return (await viewer())?.role ?? null;
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) return null;
    throw err;
  }
}
