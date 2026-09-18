import { Container } from "@/components/shell/Container";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export default function NotFound() {
  return (
    <Container className="py-8">
      <EmptyState
        level={1}
        icon="circleDashed"
        title="No page here"
        body="The link may be old, or the event may not exist yet."
        action={
          <Button variant="primary" href="/">
            Back to live play
          </Button>
        }
      />
    </Container>
  );
}
