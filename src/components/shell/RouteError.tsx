"use client";

import { useEffect } from "react";
import { Container } from "@/components/shell/Container";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { log } from "@/lib/log";

/**
 * The one error state every `error.tsx` renders: what happened in plain
 * words, the digest to quote, and a retry that re-renders the segment. A
 * nested boundary keeps its layout (the event header, the console nav) so
 * the reader knows where they are.
 */
export function RouteError({ error, reset, where }: { error: Error & { digest?: string }; reset: () => void; where?: string }) {
  useEffect(() => {
    log.error("route error", { digest: error.digest ?? null, where: where ?? null }, error);
  }, [error, where]);
  return (
    <Container className="py-8">
      <EmptyState
        level={1}
        icon="circleAlert"
        title={where ? `Something went wrong loading ${where}` : "Something went wrong loading this page"}
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
