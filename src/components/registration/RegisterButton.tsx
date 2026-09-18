"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api-client";

/**
 * Step 1's action: `POST /api/tournaments/:slug/register`, which moves the team
 * to `registered` and records the donation intent with the stub provider. The
 * page re-renders from rows afterwards, so the pending → received change is
 * whatever the provider says, never assumed here.
 */
export function RegisterButton({ slug, teamId, label }: { slug: string; teamId: string; label: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {error ? (
        <Notice tone="error" title="Registration did not go through">
          {error}
        </Notice>
      ) : null}
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await api<{ donation: { status: string } | null }>(`/api/tournaments/${slug}/register`, { body: { teamId } });
          setBusy(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          toast({ tone: "success", title: "You are registered", body: result.data.donation ? "Your donation is being processed." : "No entry donation for this event." });
          router.refresh();
        }}
      >
        {busy ? "Registering…" : label}
      </Button>
    </div>
  );
}
