import { Container } from "@/components/shell/Container";
import { DataTableSkeleton, ImpactMeterSkeleton, SectionHeadingSkeleton, Skeleton, StatGridSkeleton } from "@/components/ui/Skeleton";

/** The Impact tab: beneficiary story with its meter, four figures, the donor wall. */
export default function TournamentImpactLoading() {
  return (
    <Container className="space-y-10 py-6 md:py-8">
      <div className="surface-raised rounded-md p-5 md:p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-2 h-4 w-full" />
        <Skeleton className="mt-1 h-4 w-2/3" />
        <div className="mt-5">
          <ImpactMeterSkeleton />
        </div>
        <StatGridSkeleton count={4} className="mt-5" />
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <DataTableSkeleton rows={5} columns={3} />
      </div>
    </Container>
  );
}
