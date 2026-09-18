"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { detailCode, postJson } from "@/components/consensus/client";
import { ScorelineCompare, ScorelineTable } from "@/components/consensus/ScorelineCompare";
import { enteredRows, judgeRows, ScorelineEditor, toSetScores, visibleRows, type EditorSet } from "@/components/consensus/ScorelineEditor";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import type { BestOf } from "@/db/schema";
import type { SubmittedSet } from "@/domain/consensus";
import type { SetScore, Side } from "@/domain/scoreline";
import type { ApiEnvelope } from "@/lib/api";
import { cx } from "@/lib/cx";

/**
 * The score submission bottom sheet (spec §11.3): thumb-reachable, one set
 * per row, large steppers, the legality of the scoreline judged live, and the
 * submit button disabled until it is legal. The submitter always types their
 * own points first; the server resolves which team they play for.
 *
 * After submit, the sheet shows where the consensus went:
 *
 * - first submitter    → "Waiting on {opponent}" and why both teams must agree
 * - second, agreeing   → one decisive surf check, then "Final"
 * - second, differing  → both scorelines side by side, the differing set marked,
 *                        and a neutral note that the organizer settles it
 *
 * The sheet rises on translateY with --ease-out-expo behind a blurred,
 * fading backdrop and slides back down on close (spec §12.4, transition 5);
 * the agreeing check is one decisive beat in --surf (transition 4). Both
 * collapse to a fade under reduced motion (motion.css).
 */

/** The wire shape of `POST /api/matches/:id/scores` this sheet reads. */
export interface SubmitResponse {
  outcome: "awaiting_second" | "agreed" | "disputed";
  replaced: boolean;
  perspective: Side;
  consensus: {
    state: string;
    disputedReason: string | null;
    live: Array<{ teamId: string | null; teamName: string | null; sets: SetScore[]; submittedBy: { displayName: string } }>;
    differences: Array<{ setNumber: number }>;
  };
  match: { match: { winnerTeamId: string | null; teamAId: string | null; teamBId: string | null } };
}

export interface ScoreSubmitSheetProps {
  matchId: string;
  bestOf: BestOf;
  /** The viewer's team and the opponent. */
  us: { id: string; name: string };
  them: { id: string; name: string };
  /** Which side `us` is in match orientation. */
  perspective: Side;
  /** Our standing submission as typed (own points first), if we have one. */
  existing: readonly SubmittedSet[] | null;
  /** Whether the opponent has a standing submission. */
  opponentSubmitted: boolean;
  /** Test hook: the request to make instead of `POST /api/matches/:id/scores`. */
  submit?: (matchId: string, sets: SubmittedSet[]) => Promise<ApiEnvelope<SubmitResponse>>;
}

type Phase =
  | { kind: "closed" }
  | { kind: "editing"; error: string | null; busy: boolean }
  | { kind: "waiting"; sets: SetScore[] }
  | { kind: "agreed"; sets: SetScore[]; weWon: boolean }
  | { kind: "disputed"; ours: SetScore[]; theirs: SetScore[]; differing: number[] };

function toEditor(sets: readonly SubmittedSet[]): EditorSet[] {
  return sets.map((s) => ({ setNumber: s.setNumber, left: s.usPoints, right: s.themPoints }));
}

function orient(sets: readonly SetScore[], perspective: Side): SetScore[] {
  // Editor rows are "us first"; the match is "team A first".
  return sets.map((s) => (perspective === "a" ? s : { setNumber: s.setNumber, teamAPoints: s.teamBPoints, teamBPoints: s.teamAPoints }));
}

export function ScoreSubmitSheet({ matchId, bestOf, us, them, perspective, existing, opponentSubmitted, submit }: ScoreSubmitSheetProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [rows, setRows] = useState<EditorSet[]>(() => (existing ? toEditor(existing) : []));
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [closing, setClosing] = useState(false);
  const open = phase.kind !== "closed";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Focus the panel rather than the close button, so the first thing a screen reader announces is the sheet itself.
      panelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const visible = visibleRows(rows, bestOf);
  const verdict = judgeRows(visible, bestOf);
  const send = submit ?? ((id: string, sets: SubmittedSet[]) => postJson<SubmitResponse>(`/api/matches/${id}/scores`, { sets }));

  const finishClose = useCallback(() => {
    setClosing(false);
    setPhase({ kind: "closed" });
    // The server-rendered page reflects the consensus after any submission.
    router.refresh();
  }, [router]);

  /** Closing plays the exit (translateY down and a fade) and finishes once it has run; without animation support it finishes at once. */
  const close = () => {
    if (!closing) setClosing(true);
  };
  useEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    const running = panel && typeof panel.getAnimations === "function" ? panel.getAnimations() : [];
    if (running.length === 0) {
      finishClose();
      return;
    }
    let cancelled = false;
    void Promise.allSettled(running.map((a) => a.finished)).then(() => {
      if (!cancelled) finishClose();
    });
    return () => {
      cancelled = true;
    };
  }, [closing, finishClose]);

  const onSubmit = async () => {
    if (!verdict.legal) return;
    setPhase({ kind: "editing", error: null, busy: true });
    const entered = enteredRows(visible);
    const sets: SubmittedSet[] = entered.map((r) => ({ setNumber: r.setNumber, usPoints: r.left, themPoints: r.right }));
    const res = await send(matchId, sets);
    if (!res.ok) {
      const code = detailCode(res);
      const message =
        code === "already_submitted_by_team" || code === "match_not_open" || code === "not_on_team" ? `${res.error.message} Close this sheet to see where the match stands.` : res.error.message;
      setPhase({ kind: "editing", error: message, busy: false });
      return;
    }
    const data = res.data;
    const ours = orient(toSetScores(entered), perspective);
    if (data.outcome === "awaiting_second") {
      setPhase({ kind: "waiting", sets: ours });
    } else if (data.outcome === "agreed") {
      setPhase({ kind: "agreed", sets: ours, weWon: data.match.match.winnerTeamId === us.id });
    } else {
      const theirs = data.consensus.live.find((s) => s.teamId === them.id)?.sets ?? [];
      setPhase({ kind: "disputed", ours, theirs, differing: data.consensus.differences.map((d) => d.setNumber) });
    }
  };

  const teamA = perspective === "a" ? us.name : them.name;
  const teamB = perspective === "a" ? them.name : us.name;
  const triggerLabel = existing ? "Change your scoreline" : opponentSubmitted ? "Confirm the result" : "Submit score";

  return (
    <>
      <Button variant={existing ? "secondary" : "primary"} size="lg" onClick={() => setPhase({ kind: "editing", error: null, busy: false })} className="w-full sm:w-auto" iconStart={<Icons.check size={18} />}>
        {triggerLabel}
      </Button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          if (!(phase.kind === "editing" && phase.busy)) close();
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current && !(phase.kind === "editing" && phase.busy)) close();
        }}
        className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[92dvh] w-full max-w-full bg-transparent p-0 text-text-primary open:flex sm:inset-x-auto sm:left-1/2 sm:w-[min(100vw-2*var(--gutter),32rem)] sm:-translate-x-1/2"
      >
        {open ? (
          <div ref={panelRef} tabIndex={-1} className={cx(closing ? "sheet-exit" : "sheet-enter", "surface-overlay flex max-h-[92dvh] w-full flex-col rounded-t-lg pb-safe outline-none")} data-testid="score-sheet" data-closing={closing ? "true" : undefined}>
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />
            <div className="flex items-start justify-between gap-3 px-5 pt-3">
              <div className="min-w-0">
                <h2 id={titleId} className="type-subheading">
                  {phase.kind === "editing" ? "Your result" : phase.kind === "waiting" ? `Waiting on ${them.name}` : phase.kind === "agreed" ? "Final" : "Scorelines differ"}
                </h2>
                <p className="mt-0.5 truncate type-label text-text-tertiary">
                  {us.name} vs {them.name} · best of {bestOf}
                </p>
              </div>
              <button type="button" onClick={close} aria-label="Close" disabled={phase.kind === "editing" && phase.busy} className="target -mr-2 flex items-center justify-center rounded-sm text-text-secondary hover:text-text-primary disabled:opacity-40">
                <Icons.x size={20} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
              {phase.kind === "editing" ? (
                <>
                  <p className="mb-4 text-text-secondary">
                    Enter every set with <span className="text-text-primary">your</span> points first. {them.name} enters the same match from their side; the result is final once the two agree.
                  </p>
                  <ScorelineEditor bestOf={bestOf} leftLabel="Your team" rightLabel={them.name} value={rows} onChange={setRows} disabled={phase.busy} />
                  {phase.error ? (
                    <p role="alert" className="mt-4 flex items-start gap-2 rounded-sm border border-fault/40 bg-fault/10 px-3 py-2 text-fault">
                      <Icons.circleAlert size={16} className="mt-0.5 shrink-0" />
                      <span>{phase.error}</span>
                    </p>
                  ) : null}
                </>
              ) : null}

              {phase.kind === "waiting" ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-3 rounded-md border border-border-subtle bg-bg-raised p-4">
                    <Icons.hourglass size={20} className="mt-0.5 shrink-0 text-text-secondary" />
                    <p className="text-text-secondary">
                      Your scoreline is in. Nothing is final until <span className="text-text-primary">{them.name}</span> submits the same result from their phone — both teams have to agree before a result counts.
                    </p>
                  </div>
                  <ScorelineTable teamA={teamA} teamB={teamB} sets={phase.sets} winner={null} />
                </div>
              ) : null}

              {phase.kind === "agreed" ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-4 rounded-md border border-surf/40 bg-surf/10 p-4">
                    <span data-testid="confirm-check" className="confirm-enter flex size-12 shrink-0 items-center justify-center rounded-full bg-surf text-on-volt">
                      <Icons.check size={26} strokeWidth={2} />
                    </span>
                    <p className="text-text-primary">
                      Both teams agree. The match is final{phase.weWon ? " — your team wins." : "."}
                    </p>
                  </div>
                  <ScorelineTable teamA={teamA} teamB={teamB} sets={phase.sets} winner={phase.weWon ? perspective : perspective === "a" ? "b" : "a"} />
                </div>
              ) : null}

              {phase.kind === "disputed" ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-3 rounded-md border border-fault/40 bg-fault/10 p-4">
                    <Icons.triangleAlert size={20} className="mt-0.5 shrink-0 text-fault" />
                    <p className="text-text-primary">
                      The two scorelines don&apos;t match. The organizer will settle it with both teams; nothing is final until then.
                    </p>
                  </div>
                  <ScorelineCompare teamA={teamA} teamB={teamB} left={{ label: "Your team", sets: phase.ours }} right={{ label: them.name, sets: phase.theirs }} differingSets={phase.differing} />
                </div>
              ) : null}
            </div>

            <div className={cx("shrink-0 border-t border-border-subtle px-5 py-4", phase.kind === "editing" ? "grid grid-cols-[auto_minmax(0,1fr)] gap-2" : "")}>
              {phase.kind === "editing" ? (
                <>
                  <Button variant="ghost" onClick={close} disabled={phase.busy}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="lg" onClick={onSubmit} disabled={!verdict.legal || phase.busy} aria-busy={phase.busy} className="w-full">
                    {phase.busy ? "Sending…" : existing ? "Replace scoreline" : "Submit scoreline"}
                  </Button>
                </>
              ) : (
                <Button variant="secondary" size="lg" onClick={close} className="w-full">
                  Done
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
