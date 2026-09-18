"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LucraFailureNotice } from "@/components/lucra/LucraFailureNotice";
import { useLucra } from "@/components/lucra/LucraGate";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { StatusPill, type PillSpec } from "@/components/ui/StatusPill";
import type { ApiEnvelope } from "@/lib/api";
import type { LucraEntryStatus } from "@/server/lucra";

/**
 * Registration step 2 (spec §11.4): the team enters the tournament through
 * Lucra, after and apart from the charitable donation. The card runs
 * Lucra's sign-in if needed, then the SDK's documented entry
 * (`api.joinTournament` on the event's verified matchup), and then reads the
 * entry back from Lucra's participant list — `GET /api/tournaments/:slug/
 * lucra/entry` — rather than trusting the join's own answer, because the
 * SDK's auto-join is silently skipped when any gate fails and enrolment on
 * Lucra's side is asynchronous (§7.5). The organizer's reconciliation is
 * the same read; this card shows the roster the way the organizer sees it.
 *
 * Volt is used once, on the one action.
 */
export interface LucraEntryStepProps {
  slug: string;
  tournamentName: string;
  initial: LucraEntryStatus;
  supportHref: string;
  /** Test hook: how the entry status is re-read after a join. */
  reload?: (slug: string) => Promise<ApiEnvelope<LucraEntryStatus>>;
}

/** After a join, Lucra's list may lag; read back on this schedule until both players show. */
const READ_BACK_DELAYS_MS = [0, 2500, 8000];

async function defaultReload(slug: string): Promise<ApiEnvelope<LucraEntryStatus>> {
  try {
    const res = await fetch(`/api/tournaments/${slug}/lucra/entry`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
    return (await res.json()) as ApiEnvelope<LucraEntryStatus>;
  } catch {
    return { ok: false, error: { code: "unavailable", message: "Could not reach Sideout." } };
  }
}

const ENTERED: PillSpec = { label: "Entered", tone: "success", icon: Icons.circleCheck };
const LINKED: PillSpec = { label: "Signed in, not entered", tone: "neutral", icon: Icons.circleDashed };
const UNLINKED: PillSpec = { label: "Not signed in to Lucra", tone: "muted", icon: Icons.circleDashed };
const UNKNOWN: PillSpec = { label: "Lucra didn't answer", tone: "muted", icon: Icons.hourglass };

function pillFor(p: LucraEntryStatus["players"][number]): PillSpec {
  if (!p.linked) return UNLINKED;
  if (p.entered === null) return UNKNOWN;
  return p.entered ? ENTERED : LINKED;
}

export function LucraEntryStep({ slug, tournamentName, initial, supportHref, reload = defaultReload }: LucraEntryStepProps) {
  const lucra = useLucra();
  const [entry, setEntry] = useState<LucraEntryStatus>(initial);
  const [phase, setPhase] = useState<"idle" | "joining" | "confirming" | "joined">("idle");
  const [readBackNote, setReadBackNote] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const me = entry.players.find((p) => p.you) ?? null;
  const partner = entry.players.find((p) => !p.you) ?? null;
  const signedIn = lucra.status.kind === "ready" && lucra.user !== null;

  /** Read the roster back from Lucra, on the lagging schedule, until it lists the caller. */
  const confirm = useCallback(async () => {
    setPhase("confirming");
    for (const [i, delay] of READ_BACK_DELAYS_MS.entries()) {
      if (delay) await new Promise((r) => (timers.current.push(setTimeout(r, delay)), undefined));
      const res = await reload(slug);
      if (res.ok) {
        setEntry(res.data);
        const mine = res.data.players.find((p) => p.you);
        if (mine?.entered) {
          setReadBackNote(null);
          setPhase("joined");
          return;
        }
      }
      if (i === READ_BACK_DELAYS_MS.length - 1) {
        setReadBackNote(res.ok ? "Lucra accepted the entry but its participant list does not show you yet. It usually catches up within a minute; this page re-checks when you reload." : res.error.message);
      }
    }
    setPhase("joined");
  }, [reload, slug]);

  const enter = useCallback(async () => {
    if (entry.matchup.id === null) return;
    setPhase("joining");
    setReadBackNote(null);
    const out = await lucra.joinTournament(entry.matchup.id);
    if (!out.ok) {
      setPhase("idle");
      return;
    }
    await confirm();
  }, [confirm, entry.matchup.id, lucra]);

  const busy = lucra.busy || phase === "joining" || phase === "confirming";

  return (
    <div className="space-y-3" data-testid="lucra-entry-step" data-phase={phase} data-complete={entry.complete ? "true" : "false"}>
      <p className="text-text-secondary">
        Entering the competition is a separate step run by Lucra, who host the tournament, its rewards and its settlement. It is not a wager and your donation above is never staked; free-to-play entry costs nothing.
      </p>

      <ul className="divide-y divide-border-subtle rounded-md surface-inset" aria-label="Roster entry state">
        {entry.players.map((p) => (
          <li key={p.userId} className="flex items-center justify-between gap-3 px-4 py-3" data-testid="entry-player" data-entered={p.entered === null ? "unknown" : String(p.entered)}>
            <span className="min-w-0 truncate text-text-primary">
              {p.displayName}
              {p.you ? <span className="text-text-tertiary"> · you</span> : null}
            </span>
            <StatusPill spec={pillFor(p)} size="sm" />
          </li>
        ))}
      </ul>

      {entry.matchup.id === null ? (
        <Notice tone="attention" title="Lucra hasn't confirmed this event's tournament yet">
          {entry.matchup.reason === "matchup_query_failed"
            ? "Lucra did not answer when Sideout asked for the tournament. Try again in a moment."
            : `Sideout found ${entry.matchup.reason === "matchup_ambiguous" ? "more than one" : "no"} Lucra tournament for ${tournamentName}, so nobody can enter until the organizer sorts it out. They have been alerted; your registration and donation stand.`}
        </Notice>
      ) : entry.complete ? (
        <Notice tone="success" title="Both players are in">
          Lucra lists you both as entered. Results are written to Lucra as they are agreed, and rewards are settled when the organizer closes the event.
        </Notice>
      ) : me?.entered ? (
        <Notice tone="info" title={partner ? `Waiting on ${partner.displayName}` : "You are in"}>
          {partner ? `You are entered. ${partner.displayName} enters from their own phone, through Lucra, the same way.` : "Lucra lists you as entered."}
        </Notice>
      ) : null}

      {readBackNote ? (
        <Notice tone="info" title="Checking with Lucra">
          {readBackNote}
        </Notice>
      ) : null}

      {lucra.failure ? <LucraFailureNotice failure={lucra.failure} supportHref={supportHref} onRetry={() => void enter()} /> : null}

      {entry.matchup.id !== null && me && !me.entered && lucra.status.kind === "ready" && lucra.failure?.kind !== "not_allowed" ? (
        <Button variant="primary" size="lg" className="w-full" disabled={busy} aria-busy={busy} onClick={() => void enter()} data-testid="lucra-enter">
          {phase === "joining" ? "Entering with Lucra…" : phase === "confirming" ? "Confirming with Lucra…" : signedIn ? "Enter the tournament with Lucra" : "Sign in with Lucra and enter"}
        </Button>
      ) : null}
      {lucra.status.kind === "loading" ? <p className="type-label text-text-tertiary">Connecting to Lucra…</p> : null}
      {lucra.status.kind === "unconfigured" ? <p className="type-label text-text-tertiary">Lucra is not configured on this deployment</p> : null}
      {lucra.status.kind === "failed" ? <LucraFailureNotice failure={lucra.status.failure} supportHref={supportHref} onRetry={lucra.retry} /> : null}
      {entry.matchup.id !== null && signedIn && (me?.entered || entry.complete) ? (
        <Button variant="secondary" disabled={lucra.busy} onClick={() => void lucra.launch("rewards", entry.matchup.id ? { matchupId: entry.matchup.id } : {})} iconStart={<Icons.trophy size={16} />}>
          View the tournament in Lucra
        </Button>
      ) : null}
    </div>
  );
}
