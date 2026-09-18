"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { useToast } from "@/components/ui/Toast";
import type { PendingInviteView } from "@/db/queries/teams";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/format";

/** One pending partner invite with its accept action (`POST /api/teams/:id/join`). Only one card on a screen is the volt primary. */
export function InviteCard({ invite, timeZone, primary = false }: { invite: PendingInviteView; timeZone: string; primary?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = invite.tournament.status === "registration_open";
  return (
    <article className="surface-raised flex flex-col gap-3 rounded-md p-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <p className="font-medium text-text-primary">
          {invite.invitedBy.displayName} invited you to play as &ldquo;{invite.team.name}&rdquo;
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-text-secondary">
          <Link href={`/t/${invite.tournament.slug}`} className="hover:text-text-primary">
            {invite.tournament.name}
          </Link>
          <span className="tabular text-text-tertiary">· {formatDate(invite.tournament.startsAt, timeZone)}</span>
          <StatusPill spec={TOURNAMENT_STATUS_PILL[invite.tournament.status]} size="sm" />
        </p>
        {error ? (
          <Notice tone="error" className="mt-3">
            {error}
          </Notice>
        ) : null}
      </div>
      <Button
        variant={primary ? "primary" : "secondary"}
        disabled={busy || !open}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await api<unknown>(`/api/teams/${invite.team.id}/join`, { method: "POST", body: {} });
          setBusy(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          toast({ tone: "success", title: `You are on ${invite.team.name}`, body: "Register the team to enter the event." });
          router.refresh();
        }}
      >
        {open ? "Accept invite" : "Registration closed"}
      </Button>
    </article>
  );
}
