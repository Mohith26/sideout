import { Container } from "@/components/shell/Container";
import { CardListSkeleton, DataTableSkeleton, PageHeadingSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** The console's events list: cards below md, the table from md. */
export default function ConsoleEventsLoading() {
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeadingSkeleton subline={false} />
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="md:hidden">
        <CardListSkeleton count={3} lines={1} />
      </div>
      <div className="hidden md:block">
        <DataTableSkeleton rows={3} columns={6} />
      </div>
    </Container>
  );
}
