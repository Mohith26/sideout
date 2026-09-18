import { Container } from "@/components/shell/Container";
import { CardListSkeleton, DataTableSkeleton, PageHeadingSkeleton, SectionHeadingSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** The profile's shape: identity card, the two Lucra rows, teams, rewards table. */
export default function ProfileLoading() {
  return (
    <Container className="space-y-10 py-6 md:py-8">
      <div className="surface-raised flex flex-wrap items-start justify-between gap-4 rounded-md p-5 md:p-6">
        <PageHeadingSkeleton />
        <Skeleton className="h-11 w-28" />
      </div>
      <div>
        <SectionHeadingSkeleton />
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      </div>
      <div>
        <SectionHeadingSkeleton />
        <CardListSkeleton count={1} />
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <DataTableSkeleton rows={2} columns={4} />
      </div>
    </Container>
  );
}
