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

/** A page title on the display scale, with an optional eyebrow (a back link or label) and a line beneath. */
export function PageHeadingSkeleton({ eyebrow = false, subline = true, pill = false }: { eyebrow?: boolean; subline?: boolean; pill?: boolean }) {
  return (
    <div>
      {eyebrow ? <Skeleton className="mb-2 h-3 w-16" /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-10 w-56 md:w-72" />
        {pill ? <Skeleton className="h-7 w-24 rounded-full" /> : null}
      </div>
      {subline ? <Skeleton className="mt-2 h-4 w-72 max-w-full" /> : null}
    </div>
  );
}

/** The label-style section heading, `SectionHeading`'s footprint. */
export function SectionHeadingSkeleton({ aside = false }: { aside?: boolean }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <Skeleton className="h-3 w-24" />
      {aside ? <Skeleton className="h-3 w-12" /> : null}
    </div>
  );
}

/** The `Stat` grid: a label and a figure per cell. */
export function StatGridSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cx("grid grid-cols-2 gap-3", count > 2 && "md:grid-cols-4", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="surface-raised rounded-md p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-6 w-24" />
          <Skeleton className="mt-2 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/** A form: labelled inputs at their real height, and a primary button. */
export function FormSkeleton({ fields = 3, button = true }: { fields?: number; button?: boolean }) {
  return (
    <div className="space-y-5">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-11 w-full" />
        </div>
      ))}
      {button ? <Skeleton className="h-12 w-full sm:w-48" /> : null}
    </div>
  );
}

/** A stack of raised cards with a heading line, a body line and a footer row (team, invite, dispute cards). */
export function CardListSkeleton({ count = 2, lines = 2 }: { count?: number; lines?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="surface-raised rounded-md p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-5 w-48 max-w-[60%]" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          {Array.from({ length: lines }, (_, l) => (
            <Skeleton key={l} className={cx("mt-2 h-4", l === 0 ? "w-3/4" : "w-1/2")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One pool's standings: the heading line and a four-row table. */
export function StandingsSkeleton({ pools = 2 }: { pools?: number }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      {Array.from({ length: pools }, (_, i) => (
        <div key={i} className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-3 w-28" />
          </div>
          <DataTableSkeleton rows={4} columns={5} />
        </div>
      ))}
    </div>
  );
}

/** The bracket canvas: the pinned current match above a fixed-height well. */
export function BracketSkeleton() {
  return (
    <div className="surface-raised overflow-hidden rounded-md">
      <div className="flex flex-wrap items-center gap-4 p-3 md:p-4">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-5 w-56 max-w-full" />
          <Skeleton className="mt-2 h-5 w-52 max-w-full" />
        </div>
        <Skeleton className="h-11 w-24" />
      </div>
      <div className="h-[280px] border-t border-border-subtle bg-bg-inset md:h-[420px]" />
    </div>
  );
}

/** A live board court column: a court heading and two match cards. */
export function CourtBoardSkeleton({ courts = 3 }: { courts?: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: courts }, (_, i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-5 w-20" />
          <MatchCardSkeleton />
          <MatchCardSkeleton />
        </div>
      ))}
    </div>
  );
}
