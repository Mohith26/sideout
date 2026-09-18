import { Container } from "@/components/shell/Container";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { User } from "@/db/schema";

/** What anyone who is not an organizer sees in place of a console page: a plain explanation, no console data. */
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
