import { Container } from "@/components/shell/Container";
import { PageHeadingSkeleton, SectionHeadingSkeleton, Skeleton } from "@/components/ui/Skeleton";

/** The Lucra audit page: header, the health facts, then one collapsed row per attempt. */
export default function LucraAdminLoading() {
  return (
    <Container className="space-y-8 py-6 md:py-8">
      <div>
        <PageHeadingSkeleton eyebrow />
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-4 w-28" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <div className="surface-raised divide-y divide-border-subtle rounded-md">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
              <Skeleton className="h-4 w-48 max-w-[50%]" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </Container>
  );
}
