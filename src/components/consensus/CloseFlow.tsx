"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { detailCode, postJson } from "@/components/consensus/client";
import { FrozenPreview } from "@/components/consensus/FrozenPreview";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icons } from "@/components/ui/icons";
import { MATCH_STATUS_PILL, StatusPill } from "@/components/ui/StatusPill";
import type { CloseBlocker, ClosePreview, StoredClosePreview } from "@/server/close";
import type { ApiEnvelope } from "@/lib/api";
import { cx } from "@/lib/cx";

/**
 * The two-step close (spec §11.6): step one is the frozen preview (or the list
 * of what is blocking), step two an explicit confirm that posts the preview
 * hash. Nothing settles without a reviewable frozen preview; a stale hash or
 * a new blocker is refused by the server and shown here rather than closed
 * over.
 */
export interface CloseResponse {
  detail: { tournament: { status: string } };
  frozen: StoredClosePreview;
  settlement:
    | { state: "settled"; matchupId: string; unassignedUserIds: string[]; writes: number }
    | { state: "refused"; alert: { code: string; message: string }; writes: number }
    | { state: "failed"; message: string }
    /** A tournament closed earlier, rendered from its stored preview: the settlement outcome lives on the tournament row. */
    | { state: "unknown" };
}

export interface CloseFlowProps {
  tournament: { id: string; name: string; slug: string; status: string; venueTimezone: string };
  preview: ClosePreview;
  /** The preview frozen at close, once the tournament closed. */
  stored: StoredClosePreview | null;
  closedByName: string | null;
  /** Test hook: the request to make instead of `POST /api/admin/tournaments/:id/close`. */
  close?: (tournamentId: string, previewHash: string) => Promise<ApiEnvelope<CloseResponse>>;
}

type Step = { kind: "review" } | { kind: "confirm"; busy: boolean; error: string | null; blockers: CloseBlocker[] | null; stale: boolean } | { kind: "closed"; frozen: StoredClosePreview; settlement: CloseResponse["settlement"] };

export function BlockingList({ blockers, slug }: { blockers: readonly CloseBlocker[]; slug: string }) {
  return (
    <section aria-labelledby="blocking-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="blocking-heading" className="type-label text-fault">
          {blockers.length} {blockers.length === 1 ? "match is" : "matches are"} blocking the close
        </h2>
        <Link href={`/t/${slug}`} className="type-label text-text-secondary hover:text-text-primary">
          Open event
        </Link>
      </div>
      <ul className="space-y-2" data-testid="blocking-list">
        {blockers.map((b) => (
          <li key={b.matchId} className="surface-raised flex flex-col gap-2 rounded-md p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="type-label text-text-tertiary">
                {b.roundLabel}
                {b.courtLabel ? ` · ${b.courtLabel}` : ""}
              </p>
              <p className="mt-1 font-medium text-text-primary">
                {b.teamA?.name ?? "TBD"} <span className="text-text-tertiary">vs</span> {b.teamB?.name ?? "TBD"}
              </p>
              <p className="mt-1 text-text-secondary">{b.reason}</p>
              <Link href={`/m/${b.matchId}`} className="mt-2 inline-flex items-center gap-1 type-label text-text-secondary hover:text-text-primary">
                Open match
                <Icons.chevronRight size={14} />
              </Link>
            </div>
            <StatusPill spec={MATCH_STATUS_PILL[b.status]} size="sm" className="shrink-0 self-start" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function settlementCopy(settlement: CloseResponse["settlement"], status: string): string {
  switch (settlement.state) {
    case "settled":
      return settlement.unassignedUserIds.length > 0
        ? `Lucra settled the tournament (matchup ${settlement.matchupId}) but could not assign ${settlement.unassignedUserIds.length} reward${settlement.unassignedUserIds.length === 1 ? "" : "s"}; see /admin/lucra.`
        : `Lucra settled the tournament (matchup ${settlement.matchupId})${settlement.writes > 0 ? `, writing ${settlement.writes} outstanding score${settlement.writes === 1 ? "" : "s"} first` : ""}.`;
    case "refused":
      return `Lucra settlement was refused: ${settlement.alert.message} The event stays in awaiting settlement; fix the cause and settle again from /admin/lucra.`;
    case "failed":
      return `Settlement could not run (${settlement.message}). The event stays in awaiting settlement; settle again from /admin/lucra.`;
    case "unknown":
      return status === "settled" ? "Lucra settlement completed." : "Lucra settlement has not completed; the outcome and any alert are on /admin/lucra.";
  }
}

export function CloseFlow({ tournament, preview, stored, closedByName, close }: CloseFlowProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(() => (stored ? { kind: "closed", frozen: stored, settlement: { state: "unknown" } } : { kind: "review" }));
  const send = close ?? ((id: string, previewHash: string) => postJson<CloseResponse>(`/api/admin/tournaments/${id}/close`, { previewHash }));

  if (step.kind === "closed") {
    return (
      <div className="space-y-6">
        <div className="flex items-start gap-3 rounded-md border border-surf/40 bg-surf/10 p-4" data-testid="close-result">
          <Icons.circleCheck size={20} className="mt-0.5 shrink-0 text-surf" />
          <div>
            <p className="text-text-primary">
              <span className="font-medium">{tournament.name}</span> is closed{step.settlement.state === "settled" || tournament.status === "settled" ? " and settled through Lucra" : " and awaiting settlement"}. The standings and rewards below are frozen exactly as confirmed.
            </p>
            <p className="mt-1 text-text-secondary">{settlementCopy(step.settlement, tournament.status)}</p>
          </div>
        </div>
        <FrozenPreview
          standings={step.frozen.standings}
          rewards={step.frozen.rewards}
          previewHash={step.frozen.previewHash}
          frozenAt={{ closedAt: step.frozen.closedAt, closedBy: closedByName ?? step.frozen.closedByUserId, timeZone: tournament.venueTimezone }}
        />
      </div>
    );
  }

  if (tournament.status !== "live" && !(tournament.status === "awaiting_settlement" && !stored)) {
    return <EmptyState icon="info" title={`This event is ${tournament.status.replace(/_/g, " ")}`} body="Only a live event can be closed. Nothing here has changed." />;
  }

  if (preview.blockers.length > 0) {
    return (
      <div className="space-y-6">
        <BlockingList blockers={preview.blockers} slug={tournament.slug} />
        <p className="text-text-secondary">
          <span className="tabular">{preview.matchesFinal}</span> of <span className="tabular">{preview.matchesTotal}</span> matches are settled. The close becomes available once every match is final, forfeited or a bye and no dispute is open.
        </p>
      </div>
    );
  }

  if (step.kind === "review") {
    return (
      <div className="space-y-6">
        <FrozenPreview standings={preview.standings} rewards={preview.rewards} previewHash={preview.previewHash} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-text-secondary">Step 1 of 2 · Review what will be frozen. Nothing changes until you confirm on the next step.</p>
          <Button variant="primary" size="lg" onClick={() => setStep({ kind: "confirm", busy: false, error: null, blockers: null, stale: false })} iconEnd={<Icons.chevronRight size={18} />}>
            Continue to confirm
          </Button>
        </div>
      </div>
    );
  }

  const confirm = async () => {
    setStep({ ...step, busy: true, error: null });
    const res = await send(tournament.id, preview.previewHash);
    if (!res.ok) {
      const code = detailCode(res);
      const detail = res.error.detail as { blockers?: CloseBlocker[] } | undefined;
      setStep({ kind: "confirm", busy: false, error: res.error.message, blockers: code === "close_blocked" ? (detail?.blockers ?? []) : null, stale: code === "preview_stale" });
      return;
    }
    setStep({ kind: "closed", frozen: res.data.frozen, settlement: res.data.settlement });
    router.refresh();
  };

  return (
    <div className="space-y-6" data-testid="close-confirm">
      <div className="surface-overlay rounded-lg p-5">
        <p className="type-label text-text-tertiary">Step 2 of 2</p>
        <h2 className="mt-1 type-heading">Close {tournament.name}?</h2>
        <ul className="mt-3 space-y-2 text-text-secondary">
          <li className="flex gap-2">
            <Icons.check size={16} className="mt-1 shrink-0 text-text-tertiary" />
            <span>
              Freezes the standings for <span className="tabular text-text-primary">{preview.standings.length}</span> teams and{" "}
              <span className="tabular text-text-primary">{preview.rewards.length}</span> projected {preview.rewards.length === 1 ? "reward" : "rewards"} exactly as previewed.
            </span>
          </li>
          <li className="flex gap-2">
            <Icons.check size={16} className="mt-1 shrink-0 text-text-tertiary" />
            <span>Moves the event to awaiting settlement. No result can change after this.</span>
          </li>
          <li className="flex gap-2">
            <Icons.check size={16} className="mt-1 shrink-0 text-text-tertiary" />
            <span>Tournaments never settle on their own; this organizer action is the trigger for settlement.</span>
          </li>
        </ul>
        <p className="mt-3 type-label text-text-tertiary">
          Preview hash <code className="font-mono normal-case tracking-normal text-text-secondary">{preview.previewHash.slice(0, 16)}…</code>
        </p>
        {step.error ? (
          <div role="alert" className={cx("mt-4 rounded-sm border px-3 py-2", step.stale || step.blockers ? "border-fault/40 bg-fault/10 text-fault" : "border-fault/40 bg-fault/10 text-fault")}>
            <p className="flex items-start gap-2">
              <Icons.circleAlert size={16} className="mt-0.5 shrink-0" />
              <span>{step.error}</span>
            </p>
            {step.stale ? (
              <div className="mt-2">
                <Button variant="secondary" onClick={() => router.refresh()}>
                  Reload the preview
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {step.blockers && step.blockers.length > 0 ? (
          <div className="mt-4">
            <BlockingList blockers={step.blockers} slug={tournament.slug} />
          </div>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => setStep({ kind: "review" })} disabled={step.busy}>
            Back to the preview
          </Button>
          <Button variant="primary" size="lg" onClick={confirm} disabled={step.busy || step.stale || Boolean(step.blockers?.length)} aria-busy={step.busy}>
            {step.busy ? "Closing…" : "Close tournament"}
          </Button>
        </div>
      </div>
    </div>
  );
}
