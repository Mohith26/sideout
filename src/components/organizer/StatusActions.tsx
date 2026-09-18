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
 * to it; settlement (`→ settled`) runs at close through Lucra and, when Lucra
 * refuses, is retried from `/admin/lucra`; a rule-7.3.4 freeze is also
 * `awaiting_settlement`, without a close, and leaves through "Verify
 * targeting" there or by forfeiting and closing here; cancelling asks first.
 */
export interface LucraStatusAlert {
  code: string;
  message: string;
  blocking: boolean;
}

export interface StatusActionsProps {
  tournamentId: string;
  status: TournamentStatus;
  /** Targets the PATCH route accepts from here. */
  patchable: readonly PatchableTarget[];
  /** `live` needs a draw; explain instead of failing. */
  matchCount: number;
  /** Whether a close preview is frozen: `awaiting_settlement` without one is a rule-7.3.4 freeze, not a closed event. */
  closed?: boolean;
  /** The Lucra layer's alert on the tournament, if any (`readLucraAlert`). */
  lucraAlert?: LucraStatusAlert | null;
}

/** What an `awaiting_settlement` or `settled` event needs from the organizer, in plain words. */
export function settlementCopy(status: TournamentStatus, closed: boolean, alert: LucraStatusAlert | null): { text: string; needsLucraPage: boolean } | null {
  if (status === "awaiting_settlement" && !closed) {
    return {
      text: `Play is paused: Lucra did not return exactly one matchup for this event, so no score is written until it does${alert ? ` (${alert.message})` : ""}. Fix the matchups in Lucra and verify targeting to resume play, or forfeit the remaining matches and close from the close flow.`,
      needsLucraPage: true,
    };
  }
  if (status === "awaiting_settlement" && alert?.blocking) {
    return { text: `Closed. Lucra settlement was refused: ${alert.message} Fix the cause, then settle again.`, needsLucraPage: true };
  }
  if (status === "awaiting_settlement") {
    return { text: "Closed. Lucra settlement has not completed; settle again if it was interrupted.", needsLucraPage: true };
  }
  if (status === "settled") {
    return { text: alert ? `Settled through Lucra. ${alert.message}` : "Settled through Lucra.", needsLucraPage: alert !== null };
  }
  return null;
}

const ACTION: Record<PatchableTarget, { label: string; confirm: string | null; destructive: boolean }> = {
  registration_open: { label: "Open registration", confirm: null, destructive: false },
  registration_closed: { label: "Close registration", confirm: "Close registration? No more teams can enter; you can then generate the draw.", destructive: false },
  live: { label: "Go live", confirm: "Go live? Scores can be submitted from the sand and the draw can no longer be replaced once a match starts.", destructive: false },
  cancelled: { label: "Cancel event", confirm: "Cancel this event? This cannot be undone. Teams keep their record; donations are not refunded automatically.", destructive: true },
};

export function StatusActions({ tournamentId, status, patchable, matchCount, closed = false, lucraAlert = null }: StatusActionsProps) {
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
  const settlement = settlementCopy(status, closed, lucraAlert);

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
      {settlement ? (
        <p className="text-text-tertiary" data-testid="settlement-copy">
          {settlement.text}{" "}
          {settlement.needsLucraPage ? (
            <>
              <Link href="/admin/lucra" className="link-inline text-text-secondary hover:text-text-primary">
                Open the Lucra page
              </Link>
              {" · "}
            </>
          ) : null}
          <Link href={`/organizer/events/${tournamentId}/close`} className="link-inline text-text-secondary hover:text-text-primary">
            {closed ? "See the frozen close preview" : "Open the close flow"}
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
