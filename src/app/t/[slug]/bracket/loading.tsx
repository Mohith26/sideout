import { Container } from "@/components/shell/Container";
import { BracketSkeleton, DataTableSkeleton, SectionHeadingSkeleton } from "@/components/ui/Skeleton";

/** The Bracket tab: the canvas, then the pool sheets. */
export default function BracketLoading() {
  return (
    <Container className="space-y-10 py-6 md:py-8">
      <div>
        <SectionHeadingSkeleton aside />
        <BracketSkeleton />
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <div className="grid gap-6 xl:grid-cols-2">
          <DataTableSkeleton rows={4} columns={5} />
          <DataTableSkeleton rows={4} columns={5} />
        </div>
      </div>
    </Container>
  );
}
