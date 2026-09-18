import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LucraActionButton } from "@/components/lucra/LucraActions";
import { ReconciliationView } from "@/components/organizer/ReconciliationView";
import { RecheckParticipants } from "@/components/organizer/RecheckParticipants";
import { Container } from "@/components/shell/Container";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { getTournamentSummaryById } from "@/db/queries/tournaments";
import { formatDate, formatTime } from "@/lib/format";
import { requestNow } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
import { isLucraError, LUCRA_ERROR_MESSAGE } from "@/lucra";
import { readLucraAlert, reconcileParticipants, type ParticipantReconciliation } from "@/server/lucra";
import { requireOrganizerViewer } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/organizer/events/[id]/lucra">): Promise<Metadata> {
  const { id } = await params;
  const name = getTournamentSummaryById(id)?.tournament.name;
  return { title: name ? `${name} · Lucra` : "Lucra" };
}

/**
 * `/organizer/events/[id]/lucra` (spec §7.5, §11.6): the participant list read
 * back from Lucra and reconciled against the registered teams, the event's
 * targeting state and any Lucra alert, and the organizer's actions. This is
 * how entry is proven — never by the SDK's join answering, never by
 * auto-join. The gate runs before any row is read.
 */
export default async function TournamentLucraPage({ params }: PageProps<"/organizer/events/[id]/lucra">) {
  const { id } = await params;
  const organizer = await requireOrganizerViewer();
  const summary = getTournamentSummaryById(id);
  if (!summary) notFound();
  const { tournament: t } = summary;
  const readAt = requestNow();
  let reconciliation: ParticipantReconciliation | null = null;
  let failure: { code: string; message: string } | null = null;
  try {
    reconciliation = await reconcileParticipants(t.id, { kind: "organizer", userId: organizer.id });
  } catch (err) {
    if (!isLucraError(err)) throw err;
    log.warn("organizer lucra page: reconciliation did not run", { tournamentId: t.id, code: err.code, message: errorMessage(err) });
    failure = { code: err.code, message: LUCRA_ERROR_MESSAGE[err.code] };
  }
  // The reconciliation may have just verified (or dropped) the matchup: show the row as it stands now.
  const current = getTournamentSummaryById(id)?.tournament ?? summary.tournament;
  const alert = readLucraAlert(current);

  return (
    <Container className="space-y-6 py-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/organizer/events/${t.id}`} className="target inline-flex items-center gap-1 rounded-sm type-label text-text-secondary hover:text-text-primary">
            <Icons.chevronLeft size={14} />
            {t.name}
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-display-l">Lucra entry</h1>
            <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
          </div>
          <p className="mt-2 max-w-prose text-text-secondary">
            Who Lucra lists in this event&apos;s tournament, against who registered here. Players enter through Lucra&apos;s own flow from the registration screen; this read-back is the only proof they did.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RecheckParticipants tournamentId={t.id} />
          <LucraActionButton action={{ kind: "verify", tournamentId: t.id }} />
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 surface-raised rounded-md p-4 md:grid-cols-3">
        <div>
          <dt className="type-label text-text-tertiary">matchupMetadata.externalId</dt>
          <dd className="break-all font-mono text-[13px] text-text-secondary">{t.lucraExternalId}</dd>
        </div>
        <div>
          <dt className="type-label text-text-tertiary">Verified matchup</dt>
          <dd className="break-all font-mono text-[13px] text-text-secondary">
            {current.lucraMatchupId ?? "not verified"}
            {current.lucraMatchupVerifiedAt ? ` · ${formatDate(current.lucraMatchupVerifiedAt, t.venueTimezone)} ${formatTime(current.lucraMatchupVerifiedAt, t.venueTimezone)}` : ""}
          </dd>
        </div>
        <div>
          <dt className="type-label text-text-tertiary">Every write, verbatim</dt>
          <dd>
            <Link href={`/admin/lucra?tournament=${t.id}`} className="inline-flex items-center gap-1 font-mono text-[13px] text-text-secondary hover:text-text-primary">
              /admin/lucra
              <Icons.arrowRight size={12} />
            </Link>
          </dd>
        </div>
      </dl>

      {alert ? (
        <Notice tone={alert.blocking ? "attention" : "info"} title={alert.code}>
          {alert.message}
        </Notice>
      ) : null}

      {failure ? (
        <Notice tone="attention" title="Lucra did not answer">
          {failure.message} <span className="font-mono text-[13px] text-text-tertiary">({failure.code})</span>
        </Notice>
      ) : null}

      {reconciliation ? <ReconciliationView reconciliation={reconciliation} readAtLabel={`${formatDate(readAt, t.venueTimezone)} ${formatTime(readAt, t.venueTimezone)}`} /> : null}
    </Container>
  );
}
