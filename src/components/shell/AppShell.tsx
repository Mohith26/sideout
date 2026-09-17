import type { ReactNode } from "react";
import { NavRail } from "@/components/shell/NavRail";
import { TabBar } from "@/components/shell/TabBar";
import { Wordmark } from "@/components/shell/Wordmark";
import { ToastProvider } from "@/components/ui/Toast";

/**
 * Bottom tab bar on mobile, left rail from 1280px, one content column with
 * 16px gutters that grow to 32px at desktop (spec §12.3).
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-sm focus:bg-volt focus:px-3 focus:py-2 focus:text-on-volt"
      >
        Skip to content
      </a>
      <NavRail />
      <div className="xl:pl-navrail">
        <header className="flex h-14 items-center border-b border-border-subtle px-gutter xl:hidden">
          <Wordmark />
        </header>
        <main id="main" className="pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px)+24px)] xl:pb-12">
          {children}
        </main>
      </div>
      <TabBar />
    </ToastProvider>
  );
}

/** Standard content column. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["mx-auto w-full max-w-content px-gutter", className].filter(Boolean).join(" ")}>{children}</div>;
}
