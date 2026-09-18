import { Container } from "@/components/shell/Container";
import { PageHeadingSkeleton, SectionHeadingSkeleton, TournamentCardSkeleton } from "@/components/ui/Skeleton";

/** The events list: a title, then cards two across. */
export default function EventsLoading() {
  return (
    <Container className="space-y-10 py-6 md:py-8">
      <PageHeadingSkeleton subline={false} />
      <div>
        <SectionHeadingSkeleton />
        <div className="grid gap-4 md:grid-cols-2">
          <TournamentCardSkeleton />
          <TournamentCardSkeleton />
        </div>
      </div>
    </Container>
  );
}
