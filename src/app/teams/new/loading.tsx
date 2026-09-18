import { Container } from "@/components/shell/Container";
import { FormSkeleton, PageHeadingSkeleton } from "@/components/ui/Skeleton";

/** New team: the event eyebrow, the title, name and partner phone fields. */
export default function NewTeamLoading() {
  return (
    <Container className="py-6 md:py-8">
      <div className="mx-auto max-w-lg space-y-6">
        <PageHeadingSkeleton eyebrow />
        <FormSkeleton fields={2} />
      </div>
    </Container>
  );
}
