import { Icons } from "@/components/ui/icons";

/**
 * The shell's marker for a session opened through the demo-accounts picker
 * (`via: "demo"` in the cookie): every screen of such a session says so, in
 * the corner, until sign-out. Rendered by `AppShell` only for those sessions.
 */
export function DemoPill({ displayName }: { displayName: string }) {
  return (
    <div
      data-testid="demo-pill"
      className="pointer-events-none fixed top-3 right-3 z-40 inline-flex h-7 max-w-[60vw] items-center gap-1.5 rounded-full border border-fault/40 bg-bg-base/95 px-2.5 type-label text-fault xl:top-4 xl:right-4"
    >
      <Icons.flag size={12} />
      <span className="truncate">
        Demo · <span className="text-text-secondary">{displayName}</span>
      </span>
    </div>
  );
}
