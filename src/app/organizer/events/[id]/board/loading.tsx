import { Container } from "@/components/shell/Container";
import { CourtBoardSkeleton, PageHeadingSkeleton } from "@/components/ui/Skeleton";

/** The live board: header, then a column per court. */
export default function BoardLoading() {
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <PageHeadingSkeleton eyebrow pill />
      <CourtBoardSkeleton courts={3} />
    </Container>
  );
}
