import type { Metadata } from "next";
import { Container } from "@/components/shell/Container";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Offline" };

/**
 * The service worker's fallback for a page it has no copy of while the phone
 * has no connection. Plain and honest: what still works, what is waiting.
 */
export default function OfflinePage() {
  return (
    <Container className="py-8">
      <EmptyState
        icon="wifiOff"
        title="No connection, and this page is not saved on this phone"
        body={
          <>
            <p>Pages you have opened before still work: your event, your pool, and any match you have looked at. A scoreline you submit is saved here and sent as soon as you are back online.</p>
            <p className="mt-2 type-label text-text-tertiary">Try again once you have signal.</p>
          </>
        }
        action={
          <Button variant="primary" href="/">
            Back to live play
          </Button>
        }
      />
    </Container>
  );
}
