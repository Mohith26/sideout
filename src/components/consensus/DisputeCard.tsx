"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/components/consensus/client";
import { ScorelineCompare, ScorelineTable } from "@/components/consensus/ScorelineCompare";
import { enteredRows, judgeRows, ScorelineEditor, toSetScores, visibleRows, type EditorSet } from "@/components/consensus/ScorelineEditor";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { MATCH_STATUS_PILL, StatusPill } from "@/components/ui/StatusPill";
import type { DisputeView } from "@/db/queries/consensus";
import type { SetScore } from "@/domain/scoreline";
import type { ApiEnvelope } from "@/lib/api";
import { formatTime } from "@/lib/format";

/**
 * One disputed match in the organizer queue (spec §11.6, §12.5): both
 * scorelines side by side with the differing set marked, and a resolve form
 * built on the same steppers players use. The organizer's scoreline is
 * authoritative and attributed to them; after it lands the card shows who
 * settled it and how.
 */
export interface ResolveResponse {
  consensus: { state: string; agreedSets: SetScore[] | null; resolvedBy: { userId: string; displayName: string } | null };
  match: { match: { status: string; winnerTeamId: string | null } };
}

export interface DisputeCardProps {
  dispute: DisputeView;
  timeZone: string;
  /** Test hook: the request to make instead of `POST /api/admin/matches/:id/resolve`. */
  resolve?: (matchId: string, sets: SetScore[]) => Promise<ApiEnvelope<ResolveResponse>>;
}

export function DisputeCard({ dispute, timeZone, resolve }: DisputeCardProps) {
  const router = useRouter();
  const { match, consensus, teamA, teamB } = dispute;
  const teamAName = teamA?.name ?? "Team A";
  const teamBName = teamB?.name ?? "Team B";
  const subA = consensus.live.find((s) => s.teamId === match.teamAId);
  const subB = consensus.live.find((s) => s.teamId === match.teamBId);
  const [rows, setRows] = useState<EditorSet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<ResolveResponse | null>(null);

  const visible = visibleRows(rows, match.bestOf);
  const verdict = judgeRows(visible, match.bestOf);
  const send = resolve ?? ((id: string, sets: SetScore[]) => postJson<ResolveResponse>(`/api/admin/matches/${id}/resolve`, { sets }));
  const prefill = (sets: readonly SetScore[]) => setRows(sets.map((s) => ({ setNumber: s.setNumber, left: s.teamAPoints, right: s.teamBPoints })));

  const onResolve = async () => {
    if (!verdict.legal) return;
    setBusy(true);
    setError(null);
    const res = await send(match.id, toSetScores(enteredRows(visible)));
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    // Stay on the card so the attribution is visible; the queue re-reads when the organizer dismisses it.
    setSettled(res.data);
  };

  const note = (sub: typeof subA) => (sub ? `${sub.submittedBy.displayName} · ${formatTime(sub.createdAt, timeZone)}` : "Not submitted");

  return (
    <article aria-labelledby={`dispute-${match.id}`} className="surface-raised rounded-md p-4 md:p-5" data-testid="dispute-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="type-label text-text-tertiary">
            {dispute.tournament.name} · {dispute.roundLabel}
            {match.courtLabel ? ` · ${match.courtLabel}` : ""}
          </p>
          <h2 id={`dispute-${match.id}`} className="mt-1 type-subheading">
            {teamAName} <span className="text-text-tertiary">vs</span> {teamBName}
          </h2>
        </div>
        <StatusPill spec={settled ? MATCH_STATUS_PILL.final : MATCH_STATUS_PILL.disputed} />
      </header>

      {settled ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-start gap-3 rounded-md border border-surf/40 bg-surf/10 p-4">
            <Icons.circleCheck size={20} className="mt-0.5 shrink-0 text-surf" />
            <p className="text-text-primary">
              Settled by <span className="font-medium">{settled.consensus.resolvedBy?.displayName ?? "the organizer"}</span>. The match is final and the result is recorded under their name in the audit log.
            </p>
          </div>
          {settled.consensus.agreedSets ? (
            <ScorelineTable teamA={teamAName} teamB={teamBName} sets={settled.consensus.agreedSets} winner={settled.match.match.winnerTeamId === match.teamAId ? "a" : settled.match.match.winnerTeamId === match.teamBId ? "b" : null} />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => router.refresh()}>
              Dismiss from the queue
            </Button>
            <Button variant="ghost" href={`/m/${match.id}`}>
              Open match
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 text-text-secondary">{consensus.disputedReason ?? "The two scorelines differ."}</p>
          <ScorelineCompare
            className="mt-4"
            teamA={teamAName}
            teamB={teamBName}
            left={{ label: teamAName, sets: subA?.sets ?? [], note: note(subA) }}
            right={{ label: teamBName, sets: subB?.sets ?? [], note: note(subB) }}
            differingSets={consensus.differences.map((d) => d.setNumber)}
          />

          <section aria-labelledby={`resolve-${match.id}`} className="mt-5 border-t border-border-subtle pt-5">
            <h3 id={`resolve-${match.id}`} className="type-label text-text-tertiary">
              Resolve with the authoritative scoreline
            </h3>
            <p className="mt-1 text-text-secondary">Start from either reading or type the result you established on the court. What you submit is final and recorded as your decision.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => prefill(subA?.sets ?? [])} disabled={!subA || busy}>
                Start from {teamAName}
              </Button>
              <Button variant="secondary" onClick={() => prefill(subB?.sets ?? [])} disabled={!subB || busy}>
                Start from {teamBName}
              </Button>
            </div>
            <ScorelineEditor className="mt-4" bestOf={match.bestOf} leftLabel={teamAName} rightLabel={teamBName} value={rows} onChange={setRows} disabled={busy} />
            {error ? (
              <p role="alert" className="mt-4 flex items-start gap-2 rounded-sm border border-fault/40 bg-fault/10 px-3 py-2 text-fault">
                <Icons.circleAlert size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
            <div className="mt-4">
              <Button variant="primary" size="lg" onClick={onResolve} disabled={!verdict.legal || busy} aria-busy={busy} className="w-full sm:w-auto">
                {busy ? "Resolving…" : "Resolve as organizer"}
              </Button>
            </div>
          </section>
        </>
      )}
    </article>
  );
}
