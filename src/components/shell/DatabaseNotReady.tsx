import { Container } from "@/components/shell/AppShell";
import { EmptyState } from "@/components/ui/EmptyState";

/** Shown when the SQLite file is missing or unmigrated, instead of a stack trace. */
export function DatabaseNotReady({ message }: { message: string }) {
  return (
    <Container className="py-8">
      <EmptyState
        icon="circleAlert"
        title="The database is not ready"
        body={
          <>
            <p>{message}</p>
            <p className="mt-2">
              From the repository root run <code className="rounded-xs bg-bg-inset px-1.5 py-0.5 text-text-primary">npm run seed</code>, then reload.
            </p>
          </>
        }
      />
    </Container>
  );
}
