import { Container } from "@/components/shell/Container";
import { SectionHeadingSkeleton, StandingsSkeleton } from "@/components/ui/Skeleton";

/** The Standings tab: one table per pool. */
export default function StandingsLoading() {
  return (
    <Container className="py-6 md:py-8">
      <SectionHeadingSkeleton aside />
      <StandingsSkeleton pools={2} />
    </Container>
  );
}
