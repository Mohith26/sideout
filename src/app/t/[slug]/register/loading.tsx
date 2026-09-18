import { Container } from "@/components/shell/Container";
import { CardListSkeleton } from "@/components/ui/Skeleton";

/** Registration: the two step cards, donation then Lucra entry. */
export default function RegisterLoading() {
  return (
    <Container className="py-6 md:py-8">
      <div className="mx-auto max-w-2xl">
        <CardListSkeleton count={2} lines={3} />
      </div>
    </Container>
  );
}
