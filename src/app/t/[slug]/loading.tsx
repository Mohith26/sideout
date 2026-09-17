import { Container } from "@/components/shell/AppShell";
import { DataTableSkeleton, ImpactMeterSkeleton, Skeleton } from "@/components/ui/Skeleton";

export default function TournamentLoading() {
  return (
    <Container className="space-y-8 py-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="surface-raised rounded-md p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-5 w-24" />
          </div>
        ))}
      </div>
      <DataTableSkeleton rows={6} columns={4} />
      <div className="surface-raised rounded-md p-5">
        <ImpactMeterSkeleton />
      </div>
    </Container>
  );
}
