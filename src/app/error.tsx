"use client";

import { useEffect } from "react";
import { Container } from "@/components/shell/Container";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { log } from "@/lib/log";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    log.error("route error", { digest: error.digest ?? null }, error);
  }, [error]);
  return (
    <Container className="py-8">
      <EmptyState
        icon="circleAlert"
        title="Something went wrong loading this page"
        body={
          <>
            <p>The request failed on the server. Nothing you did caused it.</p>
            {error.digest ? (
              <p className="mt-1 type-label text-text-tertiary">
                Reference <span className="tabular">{error.digest}</span>
              </p>
            ) : null}
          </>
        }
        action={
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
        }
      />
    </Container>
  );
}
