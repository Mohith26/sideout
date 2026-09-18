import { Container } from "@/components/shell/Container";
import { CardListSkeleton, PageHeadingSkeleton } from "@/components/ui/Skeleton";

/** The dispute queue: eyebrow, title, one card per open dispute. */
export default function DisputesLoading() {
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <PageHeadingSkeleton eyebrow />
      <CardListSkeleton count={1} lines={3} />
    </Container>
  );
}
