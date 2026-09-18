import { Container } from "@/components/shell/Container";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { User } from "@/db/schema";

/**
 * The dispute queue's and close flow's own answer to a viewer who is not an
 * organizer: a plain explanation, no console data. Under `/organizer` the
 * layout 404s such a viewer first (`src/app/organizer/_lib.ts`), so this is
 * the page's own gate ahead of its data reads, not what a player sees.
 */
export function OrganizerAccessRequired({ user }: { user: User | null }) {
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
