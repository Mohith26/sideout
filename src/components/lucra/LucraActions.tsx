"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/consensus/client";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";

/**
 * The organizer's actions on `/admin/lucra`: retry a write, verify a
 * tournament's matchup targeting, settle a closed tournament again. Each is
 * one POST to its route; the page re-renders from the rows afterwards, so
 * what is shown is always what the database says, never optimistic.
 */
export type LucraAction = { kind: "retry"; matchId: string } | { kind: "verify"; tournamentId: string } | { kind: "settle"; tournamentId: string } | { kind: "reconcile"; tournamentId: string };

const LABEL: Record<LucraAction["kind"], string> = { retry: "Retry write", verify: "Verify targeting", settle: "Settle again", reconcile: "Reconcile participants" };

function urlFor(action: LucraAction): string {
  switch (action.kind) {
    case "retry":
      return `/api/admin/matches/${action.matchId}/lucra/retry`;
    case "verify":
      return `/api/admin/tournaments/${action.tournamentId}/lucra/verify`;
    case "settle":
      return `/api/admin/tournaments/${action.tournamentId}/lucra/settle`;
    case "reconcile":
      return `/api/admin/tournaments/${action.tournamentId}/lucra/participants`;
  }
}

export function LucraActionButton({ action, variant = "secondary" }: { action: LucraAction; variant?: "primary" | "secondary" | "ghost" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "fault"; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setNote(null);
    const res =
      action.kind === "reconcile"
        ? await fetch(urlFor(action), { credentials: "same-origin", headers: { accept: "application/json" } }).then(async (r) => (await r.json()) as { ok: boolean; data?: { matched: unknown[]; missing: unknown[]; unlinked: unknown[]; extra: unknown[] }; error?: { message: string } })
        : await postJson<Record<string, unknown>>(urlFor(action), {});
    setBusy(false);
    if (!res.ok) {
      setNote({ tone: "fault", text: res.error?.message ?? "The request failed." });
      return;
    }
    if (action.kind === "reconcile" && res.data && "matched" in res.data) {
      const d = res.data as { matched: unknown[]; missing: unknown[]; unlinked: unknown[]; extra: unknown[] };
      setNote({ tone: d.missing.length + d.unlinked.length + d.extra.length === 0 ? "ok" : "fault", text: `${d.matched.length} matched · ${d.missing.length} missing · ${d.unlinked.length} unlinked · ${d.extra.length} extra` });
    } else {
      const data = res.data as Record<string, unknown> | undefined;
      const outcome = typeof data?.outcome === "string" ? data.outcome : typeof data?.state === "string" ? data.state : typeof data?.count === "number" ? `${data.count} matchup${data.count === 1 ? "" : "s"}` : "done";
      setNote({ tone: outcome === "accepted" || outcome === "settled" || outcome === "1 matchup" ? "ok" : "fault", text: outcome });
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button variant={variant} onClick={run} disabled={busy} iconStart={busy ? <Icons.hourglass size={16} /> : undefined}>
        {busy ? "Working…" : LABEL[action.kind]}
      </Button>
      {note ? (
        <span className={note.tone === "ok" ? "type-label text-surf" : "type-label text-fault"} role="status">
          {note.text}
        </span>
      ) : null}
    </span>
  );
}
