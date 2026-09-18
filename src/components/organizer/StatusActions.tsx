"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { useToast } from "@/components/ui/Toast";
import type { TournamentStatus } from "@/db/schema";
import { api } from "@/lib/api-client";
import type { PatchableTarget } from "@/server/tournaments";

/**
 * Status transitions as the validator allows them (`allowedTournamentTargets`,
 * filtered to what `PATCH /api/admin/tournaments/:id` will take). Closing
 * (`live → awaiting_settlement`) is the close flow's job and is a plain link
 * to it; settlement (`→ settled`) is Lucra's outcome in phase 4 and has no
 * control here; cancelling asks first.
 */
export interface StatusActionsProps {
  tournamentId: string;
  status: TournamentStatus;
  /** Targets the PATCH route accepts from here. */
  patchable: readonly PatchableTarget[];
  /** `live` needs a draw; explain instead of failing. */
  matchCount: number;
}

const ACTION: Record<PatchableTarget, { label: string; confirm: string | null; destructive: boolean }> = {
  registration_open: { label: "Open registration", confirm: null, destructive: false },
  registration_closed: { label: "Close registration", confirm: "Close registration? No more teams can enter; you can then generate the draw.", destructive: false },
  live: { label: "Go live", confirm: "Go live? Scores can be submitted from the sand and the draw can no longer be replaced once a match starts.", destructive: false },
  cancelled: { label: "Cancel event", confirm: "Cancel this event? This cannot be undone. Teams keep their record; donations are not refunded automatically.", destructive: true },
};

export function StatusActions({ tournamentId, status, patchable, matchCount }: StatusActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<PatchableTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move(to: PatchableTarget) {
    setBusy(true);
    setError(null);
    const result = await api<{ tournament: { status: TournamentStatus } }>(`/api/admin/tournaments/${tournamentId}`, { method: "PATCH", body: { status: to } });
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast({ tone: "success", title: `Now ${TOURNAMENT_STATUS_PILL[result.data.tournament.status].label.toLowerCase()}` });
    router.refresh();
  }

  const targets = patchable.filter((t) => t !== status);
  const pendingAction = pending ? ACTION[pending] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="type-label text-text-tertiary">Now</span>
        <StatusPill spec={TOURNAMENT_STATUS_PILL[status]} />
      </div>
      {error ? (
        <Notice tone="error" title="The status did not change">
          {error}
        </Notice>
      ) : null}
      {targets.length === 0 && status !== "live" && status !== "awaiting_settlement" ? <p className="text-text-tertiary">No further transitions from here.</p> : null}
      <div className="flex flex-wrap gap-2">
        {targets.map((to) => {
          const action = ACTION[to];
          const blocked = to === "live" && matchCount === 0;
          return (
            <Button
              key={to}
              variant={action.destructive ? "danger" : "secondary"}
              disabled={busy || blocked}
              title={blocked ? "Generate the draw before going live." : undefined}
              onClick={() => (action.confirm ? setPending(to) : void move(to))}
              iconStart={to === "live" ? <Icons.radio size={16} /> : to === "cancelled" ? <Icons.ban size={16} /> : <Icons.arrowRight size={16} />}
            >
              {action.label}
            </Button>
          );
        })}
        {status === "live" ? (
          <Link href={`/organizer/events/${tournamentId}/close`} className="target surface-raised inline-flex items-center gap-2 rounded-sm px-4 font-medium text-text-primary hover:border-border-strong">
            <Icons.flag size={16} />
            Close tournament
            <span className="type-label text-text-tertiary">via close flow</span>
          </Link>
        ) : null}
      </div>
      {status === "awaiting_settlement" || status === "settled" ? (
        <p className="text-text-tertiary">
          {status === "awaiting_settlement" ? "Closed. Settlement is Lucra’s outcome and arrives with phase 4; there is nothing to do here. " : null}
          <Link href={`/organizer/events/${tournamentId}/close`} className="text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
            See the frozen close preview
          </Link>
        </p>
      ) : null}
      {status === "registration_closed" && matchCount === 0 ? <p className="type-label text-text-tertiary">Going live needs a draw; generate one below first.</p> : null}
      <ConfirmDialog
        open={pending !== null}
        title={pendingAction?.label ?? ""}
        body={pendingAction?.confirm ?? undefined}
        confirmLabel={pendingAction?.label ?? "Confirm"}
        destructive={pendingAction?.destructive ?? false}
        busy={busy}
        onConfirm={() => pending && void move(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
