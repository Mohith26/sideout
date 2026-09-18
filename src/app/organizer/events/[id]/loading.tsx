import { Container } from "@/components/shell/Container";
import { FormSkeleton, PageHeadingSkeleton, SectionHeadingSkeleton, Skeleton, StatGridSkeleton } from "@/components/ui/Skeleton";

/** The event builder: header with its links, four figures, the status section, the form. */
export default function EventBuilderLoading() {
  return (
    <Container className="space-y-10 py-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeadingSkeleton eyebrow pill />
        <div className="flex gap-2">
          <Skeleton className="h-11 w-28" />
          <Skeleton className="h-11 w-28" />
        </div>
      </div>
      <StatGridSkeleton count={4} />
      <div className="surface-raised rounded-md p-4 md:p-5">
        <SectionHeadingSkeleton />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-11 w-40" />
          <Skeleton className="h-11 w-32" />
        </div>
      </div>
      <div className="max-w-2xl">
        <SectionHeadingSkeleton />
        <FormSkeleton fields={5} />
      </div>
    </Container>
  );
}
