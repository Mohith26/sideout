import { Container } from "@/components/shell/AppShell";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { loadAsync } from "@/lib/load";
import { viewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";

/**
 * Minimal role gate for the organizer console: the same session cookie the
 * API checks, read server-side; anyone who is not an organizer sees a plain
 * explanation instead of the console. The console shell and its navigation
 * are the sibling task's; this file exists so the dispute queue and the
 * close flow have a gate to sit under and is meant to be replaced.
 */
export default async function OrganizerLayout({ children }: LayoutProps<"/organizer">) {
  const loaded = await loadAsync(() => viewer());
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const user = loaded.data;
  if (user?.role !== "organizer") {
    return (
      <Container className="py-8">
        <EmptyState
          icon="ban"
          title="Organizer access required"
          body={user ? `You are signed in as ${user.displayName}, who is not an organizer for this deployment.` : "Sign in with an organizer account to open the console."}
          action={
            <Button variant="primary" href="/">
              Back to live play
            </Button>
          }
        />
      </Container>
    );
  }
  return <>{children}</>;
}
