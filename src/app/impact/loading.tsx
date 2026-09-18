import { Container } from "@/components/shell/Container";
import { DataTableSkeleton, ImpactMeterSkeleton, PageHeadingSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** The impact page: title, the beneficiary card with its meter, the per-event table. */
export default function ImpactLoading() {
  return (
    <Container className="space-y-10 py-6 md:py-8">
      <PageHeadingSkeleton />
      <div className="surface-raised rounded-md p-5 md:p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-2 h-4 w-3/4" />
        <div className="mt-5">
          <ImpactMeterSkeleton />
        </div>
      </div>
      <DataTableSkeleton rows={3} columns={4} />
    </Container>
  );
}
