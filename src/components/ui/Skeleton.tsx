import { cx } from "@/lib/cx";

/**
 * Loading placeholders that match the shape of what loads (spec §14). The base
 * block is composed into shapes below; screens use the shapes, not the block.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("animate-pulse rounded-sm bg-bg-overlay", className)} />;
}

export function TournamentCardSkeleton({ featured = false }: { featured?: boolean }) {
  return (
    <div className={cx("surface-raised rounded-md p-4", featured && "p-5")}>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Skeleton className={cx("mt-4 h-8", featured ? "w-3/4" : "w-2/3")} />
      <Skeleton className="mt-2 h-4 w-1/2" />
      <div className="mt-4 flex gap-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="mt-5">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-16" />
        </div>
        <Skeleton className="mt-2 h-2 w-full rounded-full" />
      </div>
    </div>
  );
}

export function MatchCardSkeleton() {
  return (
    <div className="surface-raised w-64 shrink-0 rounded-md p-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="mt-3 space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-10" />
        </div>
        <div className="flex justify-between">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-10" />
        </div>
      </div>
    </div>
  );
}

export function ImpactMeterSkeleton() {
  return (
    <div>
      <div className="flex items-end justify-between">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="mt-3 h-2.5 w-full rounded-full" />
      <div className="mt-2 flex justify-between">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-12" />
      </div>
    </div>
  );
}

export function DataTableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="surface-raised overflow-hidden rounded-md">
      <div className="flex gap-4 border-b border-border-subtle px-4 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
