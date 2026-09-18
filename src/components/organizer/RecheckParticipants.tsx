"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";

/**
 * "Re-check": read Lucra's participant list again through the same route the
 * page renders from (`GET /api/admin/tournaments/:id/lucra/participants`),
 * then re-render from the rows. Nothing optimistic.
 */
export function RecheckParticipants({ tournamentId }: { tournamentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        disabled={busy}
        aria-busy={busy}
        iconStart={busy ? <Icons.hourglass size={16} /> : <Icons.shuffle size={16} />}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            const res = await fetch(`/api/admin/tournaments/${tournamentId}/lucra/participants`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
            const body = (await res.json()) as { ok: boolean; error?: { message: string } };
            if (!body.ok) setNote(body.error?.message ?? "The re-check failed.");
          } catch {
            setNote("Could not reach Sideout.");
          } finally {
            setBusy(false);
            router.refresh();
          }
        }}
      >
        {busy ? "Checking with Lucra…" : "Re-check"}
      </Button>
      {note ? (
        <span className="type-label text-fault" role="status">
          {note}
        </span>
      ) : null}
    </span>
  );
}
