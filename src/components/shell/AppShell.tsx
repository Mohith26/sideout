import type { ReactNode } from "react";
import { OfflineStatus } from "@/components/offline/OfflineStatus";
import { ServiceWorkerRegistration } from "@/components/offline/ServiceWorkerRegistration";
import { navItemsFor } from "@/components/shell/nav";
import { NavRail } from "@/components/shell/NavRail";
import { TabBar } from "@/components/shell/TabBar";
import { Wordmark } from "@/components/shell/Wordmark";
import { ToastProvider } from "@/components/ui/Toast";
import { DatabaseNotReadyError } from "@/db/connection";
import { DemoPill } from "@/components/shell/DemoPill";
import { viewerSession, type ViewerSession } from "@/server/auth/viewer";

/**
 * Bottom tab bar on mobile, left rail from 1280px, one content column with
 * 16px gutters that grow to 32px at desktop (spec §12.3). The organizer
 * console tab appears only for an organizer session; the page itself is
 * gated again on the server. The shell also owns the offline surface: the
 * service worker registration (production builds), the connectivity status
 * line above the content, and the outbox replay. A session opened through
 * the public demo's account picker carries the "Demo" pill on every screen.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const session = await currentSession();
  const items = navItemsFor(session?.user.role ?? null);
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
        <OfflineStatus />
        <main id="main" className="pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px)+24px)] xl:pb-12">
          {children}
        </main>
      </div>
      <TabBar items={items} />
      {session?.via === "demo" ? <DemoPill displayName={session.user.displayName} /> : null}
      <ServiceWorkerRegistration version={process.env.BUILD_SHA ?? "unknown"} />
    </ToastProvider>
  );
}

/** The shell must render even before `npm run seed`; without a database there is no session either. */
async function currentSession(): Promise<ViewerSession | null> {
  try {
    return await viewerSession();
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) return null;
    throw err;
  }
}
