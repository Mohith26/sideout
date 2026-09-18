import { Container } from "@/components/shell/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function MatchLoading() {
  return (
    <Container className="space-y-8 py-6 md:py-8">
      <Skeleton className="h-3 w-48" />
      <div className="space-y-3">
        <Skeleton className="h-7 w-28 rounded-full" />
        <div className="surface-raised space-y-4 rounded-md p-4 md:p-5">
          <div className="flex justify-between">
            <Skeleton className="h-7 w-1/2" />
            <Skeleton className="h-9 w-20" />
          </div>
          <div className="flex justify-between">
            <Skeleton className="h-7 w-2/5" />
            <Skeleton className="h-9 w-20" />
          </div>
          <Skeleton className="h-3 w-3/4" />
        </div>
        <Skeleton className="h-4 w-2/3" />
      </div>
    </Container>
  );
}
