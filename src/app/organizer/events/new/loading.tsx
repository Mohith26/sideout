import { Container } from "@/components/shell/Container";
import { FormSkeleton, PageHeadingSkeleton } from "@/components/ui/Skeleton";

/** The new-event builder: back link, title, the form. */
export default function NewEventLoading() {
  return (
    <Container className="space-y-10 py-6 md:py-8">
      <PageHeadingSkeleton eyebrow subline={false} />
      <div className="max-w-2xl">
        <FormSkeleton fields={6} />
      </div>
    </Container>
  );
}
