import { Container } from "@/components/shell/Container";
import { MatchCardSkeleton, TournamentCardSkeleton } from "@/components/ui/Skeleton";

export default function HomeLoading() {
  return (
    <>
      <div className="border-b border-border-subtle bg-bg-inset">
        <Container className="py-4">
          <div className="h-4 w-48 animate-pulse rounded-sm bg-bg-overlay" />
          <div className="mt-3 flex gap-3 overflow-hidden">
            <MatchCardSkeleton />
            <MatchCardSkeleton />
            <MatchCardSkeleton />
          </div>
        </Container>
      </div>
      <Container className="space-y-10 py-6 md:py-8">
        <TournamentCardSkeleton featured />
        <div className="grid gap-4 md:grid-cols-2">
          <TournamentCardSkeleton />
          <TournamentCardSkeleton />
        </div>
      </Container>
    </>
  );
}
