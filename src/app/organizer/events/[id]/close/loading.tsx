import { Container } from "@/components/shell/Container";
import { DataTableSkeleton, PageHeadingSkeleton, SectionHeadingSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** The close flow: header, the blockers or the frozen preview's standings and payouts, the confirm row. */
export default function CloseLoading() {
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <PageHeadingSkeleton eyebrow />
      <div className="surface-raised rounded-md p-4 md:p-5">
        <SectionHeadingSkeleton />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="mt-2 h-4 w-1/2" />
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <DataTableSkeleton rows={4} columns={4} />
      </div>
      <Skeleton className="h-12 w-full sm:w-56" />
    </Container>
  );
}
