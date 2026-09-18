import type { Metadata } from "next";
import Link from "next/link";
import { LucraActionButton } from "@/components/lucra/LucraActions";
import { Container } from "@/components/shell/AppShell";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { OrganizerAccessRequired } from "@/components/shell/OrganizerAccessRequired";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icons } from "@/components/ui/icons";
import { CONSENSUS_STATE_PILL, StatusPill, TOURNAMENT_STATUS_PILL, type PillSpec } from "@/components/ui/StatusPill";
import { listLucraSubmissions, listTournamentLucraStatus, type LucraSubmissionView } from "@/db/queries/lucra";
import { LUCRA_SUBMISSION_OUTCOMES, type LucraSubmissionOutcome } from "@/db/schema";
import { env } from "@/env";
import { formatDate, formatTime } from "@/lib/format";
import { load, loadAsync } from "@/lib/load";
import { LUCRA_API_VERSION, LUCRA_PATHS, LUCRA_SDK_VERSION } from "@/lucra";
import { organizerViewer } from "@/server/auth/viewer";
import { readLucraAlert } from "@/server/lucra";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Lucra writes" };

/**
 * `/admin/lucra` (spec §11.6): every `lucra_score_submissions` row with the
 * exact request and response, plus each tournament's targeting state and
 * alerts. This is the page an engineer opens when asked what was actually
 * sent, so it is dense and literal: JSON as stored, nothing summarized away.
 * The organizer gate runs before any row is read.
 */

const OUTCOME_PILL: Record<LucraSubmissionOutcome, PillSpec> = {
  pending: { label: "Pending", tone: "neutral", icon: Icons.hourglass },
  accepted: { label: "Accepted", tone: "success", icon: Icons.check },
  partial: { label: "Partial", tone: "attention", icon: Icons.circleAlert },
  rejected: { label: "Rejected", tone: "attention", icon: Icons.x },
  transport_error: { label: "Transport error", tone: "attention", icon: Icons.triangleAlert },
};

function pretty(json: string | null): string {
  if (json === null) return "—";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function JsonBlock({ label, json }: { label: string; json: string | null }) {
  return (
    <div className="min-w-0">
      <p className="type-label text-text-tertiary">{label}</p>
      <pre className="mt-1 max-h-96 overflow-auto rounded-sm border border-border-subtle bg-bg-base p-3 font-mono text-[13px] leading-snug text-text-secondary whitespace-pre">{pretty(json)}</pre>
    </div>
  );
}

function SubmissionRow({ view }: { view: LucraSubmissionView }) {
  const { row, match, tournament } = view;
  const affected = JSON.parse(row.affectedMatchupIdsJson) as string[];
  const failed = JSON.parse(row.failedMatchupIdsJson) as string[];
  return (
    <details className="surface-raised rounded-md" data-testid="lucra-submission">
      <summary className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_auto_auto_auto] md:gap-4">
        <div className="min-w-0">
          <p className="truncate text-text-primary">
            {match.teamA ?? "TBD"} <span className="text-text-tertiary">v</span> {match.teamB ?? "TBD"}
          </p>
          <p className="truncate type-label text-text-tertiary">
            {tournament.name} · {match.roundLabel}
            {match.courtLabel ? ` · ${match.courtLabel}` : ""}
          </p>
        </div>
        <div className="hidden min-w-0 md:block">
          <p className="truncate tabular text-text-secondary">
            {formatDate(row.createdAt, tournament.venueTimezone)} {formatTime(row.createdAt, tournament.venueTimezone)}
          </p>
          <p className="truncate type-label text-text-tertiary">
            attempt {row.attempt} of {view.attemptsForKey} · HTTP {row.httpStatus ?? "—"} · {affected.length} affected · {failed.length} failed
          </p>
        </div>
        <span className="hidden md:inline-flex">{view.consensusState ? <StatusPill spec={CONSENSUS_STATE_PILL[view.consensusState]} size="sm" /> : null}</span>
        <StatusPill spec={OUTCOME_PILL[row.outcome]} size="sm" />
        <span className="hidden md:inline-flex">{view.retryable ? <LucraActionButton action={{ kind: "retry", matchId: match.id }} /> : null}</span>
      </summary>
      <div className="space-y-4 border-t border-border-subtle px-4 py-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
          <div>
            <dt className="type-label text-text-tertiary">Row</dt>
            <dd className="break-all font-mono text-[13px] text-text-secondary">{row.id}</dd>
          </div>
          <div>
            <dt className="type-label text-text-tertiary">Idempotency key</dt>
            <dd className="break-all font-mono text-[13px] text-text-secondary">{row.idempotencyKey}</dd>
          </div>
          <div>
            <dt className="type-label text-text-tertiary">Match</dt>
            <dd className="break-all font-mono text-[13px] text-text-secondary">
              <Link href={`/m/${match.id}`} className="underline-offset-2 hover:underline">
                {match.id}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="type-label text-text-tertiary">Affected · failed</dt>
            <dd className="break-all font-mono text-[13px] text-text-secondary">
              {affected.join(", ") || "—"} · {failed.join(", ") || "—"}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-3 md:hidden">
          {view.consensusState ? <StatusPill spec={CONSENSUS_STATE_PILL[view.consensusState]} size="sm" /> : null}
          <span className="type-label text-text-tertiary">
            attempt {row.attempt} of {view.attemptsForKey} · HTTP {row.httpStatus ?? "—"}
          </span>
          {view.retryable ? <LucraActionButton action={{ kind: "retry", matchId: match.id }} /> : null}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <JsonBlock label="request_json — exactly what was sent (key redacted)" json={row.requestJson} />
          <JsonBlock label="response_json — exactly what came back" json={row.responseJson} />
        </div>
      </div>
    </details>
  );
}

export default async function LucraAdminPage({ searchParams }: PageProps<"/admin/lucra">) {
  const gate = await loadAsync(() => organizerViewer());
  if (!gate.ok) return <DatabaseNotReady message={gate.message} />;
  if (!gate.data.organizer) return <OrganizerAccessRequired user={gate.data.user} />;
  const params = await searchParams;
  const tournamentId = typeof params.tournament === "string" ? params.tournament : undefined;
  const outcomeParam = typeof params.outcome === "string" ? params.outcome : undefined;
  const outcome = (LUCRA_SUBMISSION_OUTCOMES as readonly string[]).includes(outcomeParam ?? "") ? (outcomeParam as LucraSubmissionOutcome) : undefined;
  const loaded = load(() => ({ tournaments: listTournamentLucraStatus(), submissions: listLucraSubmissions({ tournamentId, outcome }) }));
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const { tournaments, submissions } = loaded.data;
  const totals = submissions.reduce(
    (acc, s) => {
      acc[s.row.outcome] += 1;
      return acc;
    },
    Object.fromEntries(LUCRA_SUBMISSION_OUTCOMES.map((o) => [o, 0])) as Record<LucraSubmissionOutcome, number>,
  );
  const filterHref = (next: { tournament?: string | undefined; outcome?: string | undefined }) => {
    const q = new URLSearchParams();
    const t = "tournament" in next ? next.tournament : tournamentId;
    const o = "outcome" in next ? next.outcome : outcome;
    if (t) q.set("tournament", t);
    if (o) q.set("outcome", o);
    const s = q.toString();
    return s ? `/admin/lucra?${s}` : "/admin/lucra";
  };

  return (
    <Container className="space-y-8 py-6 md:py-8">
      <header>
        <p className="type-label text-text-tertiary">Organizer console · engineering</p>
        <h1 className="mt-1 type-display-l">Lucra writes</h1>
        <p className="mt-2 max-w-prose text-text-secondary">
          Every attempt to write a score to Lucra, with the request and response exactly as stored. Tournaments never settle on their own: the organizer&apos;s close is the settlement trigger, and anything Lucra refused stays here until it is retried.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4" data-testid="lucra-health">
          <div>
            <dt className="type-label text-text-tertiary">Mode</dt>
            <dd className="font-mono text-[13px] text-text-secondary">{env.LUCRA_MODE}</dd>
          </div>
          <div>
            <dt className="type-label text-text-tertiary">Matcher interpretation</dt>
            <dd className="font-mono text-[13px] text-text-secondary">{env.LUCRA_MATCHER_INTERPRETATION}</dd>
          </div>
          <div>
            <dt className="type-label text-text-tertiary">Web SDK pin · REST</dt>
            <dd className="font-mono text-[13px] text-text-secondary">
              {LUCRA_SDK_VERSION} · {LUCRA_API_VERSION}
            </dd>
          </div>
          <div>
            <dt className="type-label text-text-tertiary">Write endpoint</dt>
            <dd className="font-mono text-[13px] text-text-secondary">{LUCRA_PATHS.poolTournamentUserScore}</dd>
          </div>
        </dl>
      </header>

      <section className="space-y-3" aria-labelledby="targeting">
        <h2 id="targeting" className="type-heading">
          Targeting, per tournament
        </h2>
        <div className="space-y-3">
          {tournaments.map(({ tournament: t, counts, agreedUnwritten, blocking }) => {
            const alert = readLucraAlert(t);
            return (
              <article key={t.id} className="surface-raised rounded-md p-4" data-testid="lucra-tournament">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-subheading text-text-primary">{t.name}</h3>
                  <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} size="sm" />
                  <Link href={filterHref({ tournament: t.id })} className="type-label text-text-secondary hover:text-text-primary">
                    {counts.accepted + counts.partial + counts.rejected + counts.transport_error + counts.pending} attempts
                  </Link>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-3">
                  <div>
                    <dt className="type-label text-text-tertiary">matchupMetadata.externalId</dt>
                    <dd className="break-all font-mono text-[13px] text-text-secondary">{t.lucraExternalId}</dd>
                  </div>
                  <div>
                    <dt className="type-label text-text-tertiary">Verified matchup</dt>
                    <dd className="break-all font-mono text-[13px] text-text-secondary">
                      {t.lucraMatchupId ?? "not verified"}
                      {t.lucraMatchupVerifiedAt ? ` · ${formatDate(t.lucraMatchupVerifiedAt, t.venueTimezone)} ${formatTime(t.lucraMatchupVerifiedAt, t.venueTimezone)}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="type-label text-text-tertiary">gameId · locationId</dt>
                    <dd className="break-all font-mono text-[13px] text-text-secondary">
                      {t.lucraGameId} · {t.lucraLocationId ?? "null (OPEN §17.5)"}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 tabular type-label text-text-tertiary">
                  accepted {counts.accepted} · partial {counts.partial} · rejected {counts.rejected} · transport {counts.transport_error} · pending {counts.pending} · agreed but unwritten {agreedUnwritten} · blocking {blocking}
                </p>
                {alert ? (
                  <div className={alert.blocking ? "mt-3 flex items-start gap-2 rounded-sm border border-fault/40 bg-fault/10 p-3" : "mt-3 flex items-start gap-2 rounded-sm border border-border-subtle p-3"} role={alert.blocking ? "alert" : "status"} data-testid="lucra-alert">
                    {alert.blocking ? <Icons.triangleAlert size={18} className="mt-0.5 shrink-0 text-fault" /> : <Icons.info size={18} className="mt-0.5 shrink-0 text-text-secondary" />}
                    <div className="min-w-0">
                      <p className="type-label text-text-primary">{alert.code}</p>
                      <p className="text-text-secondary">{alert.message}</p>
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <LucraActionButton action={{ kind: "verify", tournamentId: t.id }} />
                  <LucraActionButton action={{ kind: "reconcile", tournamentId: t.id }} />
                  {t.status === "awaiting_settlement" ? <LucraActionButton action={{ kind: "settle", tournamentId: t.id }} variant="primary" /> : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="writes">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="writes" className="type-heading">
            Attempts
          </h2>
          <nav aria-label="Filter by outcome" className="flex flex-wrap gap-1">
            <Link href={filterHref({ outcome: undefined })} className={outcome === undefined ? "rounded-full surface-raised px-3 py-1 type-label text-text-primary" : "rounded-full px-3 py-1 type-label text-text-secondary hover:text-text-primary"}>
              all {submissions.length}
            </Link>
            {LUCRA_SUBMISSION_OUTCOMES.map((o) => (
              <Link key={o} href={filterHref({ outcome: o })} className={outcome === o ? "rounded-full surface-raised px-3 py-1 type-label text-text-primary" : "rounded-full px-3 py-1 type-label text-text-secondary hover:text-text-primary"}>
                {o.replace("_", " ")} {outcome === undefined ? totals[o] : ""}
              </Link>
            ))}
            {tournamentId ? (
              <Link href={filterHref({ tournament: undefined })} className="rounded-full px-3 py-1 type-label text-text-secondary hover:text-text-primary">
                clear tournament
              </Link>
            ) : null}
          </nav>
        </div>
        {submissions.length === 0 ? (
          <EmptyState icon="circleDashed" title="No attempts match" body="Nothing has been written to Lucra under this filter. Attempts appear the moment a consensus reaches agreed." />
        ) : (
          <div className="space-y-2">
            {submissions.map((view) => (
              <SubmissionRow key={view.row.id} view={view} />
            ))}
          </div>
        )}
      </section>
    </Container>
  );
}
