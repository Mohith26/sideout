import { Container } from "@/components/shell/Container";
import { DataTableSkeleton, PageHeadingSkeleton, SectionHeadingSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** Lucra entry reconciliation: header, the targeting facts, the four lists. */
export default function LucraEntryLoading() {
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeadingSkeleton eyebrow />
        <Skeleton className="h-11 w-36" />
      </div>
      <div className="surface-raised grid grid-cols-1 gap-x-6 gap-y-3 rounded-md p-4 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-4 w-32" />
          </div>
        ))}
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <DataTableSkeleton rows={4} columns={3} />
      </div>
    </Container>
  );
}
