import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { nodesFromMatches } from "@/components/bracket/model";
import { DrawPanel } from "@/components/organizer/DrawPanel";
import { EventForm } from "@/components/organizer/EventForm";
import { eventFormOptions } from "@/components/organizer/options";
import { StatusActions } from "@/components/organizer/StatusActions";
import { Container } from "@/components/shell/Container";
import { Icons } from "@/components/ui/icons";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Stat } from "@/components/ui/Stat";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { countDonationRows } from "@/db/queries/console";
import { getTournamentDetail, getTournamentSummaryById } from "@/db/queries/tournaments";
import { drawConfigSchema, type DrawConfig } from "@/domain/draw";
import { allowedTournamentTargets, TERMINAL_MATCH_STATUSES } from "@/domain/transitions";
import { requestNow } from "@/lib/clock";
import { formatCents, formatDateRange } from "@/lib/format";
import { sweepDueDonations } from "@/server/donations/stub-provider";
import { isPatchableTarget } from "@/server/tournaments";
import { requireOrganizerViewer } from "../../_lib";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/organizer/events/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: getTournamentSummaryById(id)?.tournament.name ?? "Event" };
}

function parseDrawConfig(json: string | null): DrawConfig | null {
  if (!json) return null;
  const parsed = drawConfigSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

/**
 * Event builder, edit mode (spec §11.6): every editable field, sponsors, the
 * status controls with the validator's allowed targets, and the draw section
 * with its live preview. Reads are server-rendered; writes go through the
 * admin routes from the client components.
 */
export default async function EventBuilderPage({ params }: PageProps<"/organizer/events/[id]">) {
  const { id } = await params;
  await requireOrganizerViewer();
  sweepDueDonations(requestNow());
  const summary = getTournamentSummaryById(id);
  if (!summary) notFound();
  const detail = getTournamentDetail(summary);
  const { tournament: t, charity, activeTeams, raisedCents, donorCount } = summary;
  const options = eventFormOptions();

  const allMatches = [...detail.pools.flatMap((p) => p.matches), ...detail.bracket.matches];
  const started = allMatches.some((m) => m.match.status !== "scheduled" && m.match.status !== "bye");
  const poolMatches = detail.pools.flatMap((p) => p.matches);
  const unfinishedPoolMatches = poolMatches.filter((m) => !TERMINAL_MATCH_STATUSES.has(m.match.status)).length;
  const bracketNodes = nodesFromMatches(detail.bracket.matches);
  const bracketSeeded = bracketNodes.some((n) => n.teamA !== null || n.teamB !== null);
  const entered = detail.teams.filter((x) => x.status === "registered" || x.status === "checked_in").map((x) => ({ id: x.id, name: x.name, seed: x.seed }));
  const targets = allowedTournamentTargets(t.status, { kind: "organizer" });
  const readOnly = t.status === "settled" || t.status === "cancelled";
  const donationsExist = countDonationRows(t.id) > 0;

  return (
    <Container className="space-y-10 py-6 md:py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/organizer/events" className="target inline-flex items-center gap-1 rounded-sm type-label text-text-secondary hover:text-text-primary">
            <Icons.chevronLeft size={14} />
            Events
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-display-l">{t.name}</h1>
            <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
          </div>
          <p className="mt-1 text-text-secondary">
            {charity.name} · {t.venueName} · <span className="tabular">{formatDateRange(t.startsAt, t.endsAt, t.venueTimezone)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/t/${t.slug}`} className="target surface-raised inline-flex items-center gap-2 rounded-sm px-3 type-label text-text-secondary hover:text-text-primary">
            Public page
            <Icons.externalLink size={14} />
          </Link>
          {allMatches.length > 0 ? (
            <Link href={`/organizer/events/${t.id}/board`} className="target surface-raised inline-flex items-center gap-2 rounded-sm px-3 type-label text-text-secondary hover:text-text-primary">
              <Icons.grid size={14} />
              Live board
            </Link>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Teams" value={`${activeTeams} of ${t.maxTeams}`} hint={`${detail.teams.filter((x) => x.status === "forming").length} forming`} />
        <Stat label="Matches" value={String(allMatches.length)} hint={allMatches.length ? `${detail.pools.length} pools · ${detail.bracket.rounds} bracket rounds` : "No draw yet"} />
        <Stat label="Raised" value={formatCents(raisedCents, t.currency)} hint={`${donorCount} gifts · goal ${formatCents(t.fundraisingGoalCents, t.currency)}`} tone="ember" />
        <Stat label="Sponsors" value={String(detail.sponsors.length)} hint={`${formatCents(detail.sponsors.reduce((s, x) => s + x.prizeContributionCents, 0), t.currency)} prize pool`} />
      </dl>

      <section aria-labelledby="status-heading" className="surface-raised rounded-md p-4 md:p-5">
        <SectionHeading id="status-heading">Status</SectionHeading>
        <StatusActions
          tournamentId={t.id}
          status={t.status}
          patchable={targets.filter(isPatchableTarget)}
          matchCount={allMatches.length}
        />
      </section>

      <section aria-labelledby="draw-heading" className="surface-raised rounded-md p-4 md:p-5">
        <h2 id="draw-heading" className="sr-only">
          Draw
        </h2>
        <DrawPanel
          tournamentId={t.id}
          format={t.format}
          status={t.status}
          timeZone={t.venueTimezone}
          startsAt={t.startsAt}
          teams={entered}
          existing={{ matchCount: allMatches.length, started, bracketSeeded, poolsDone: poolMatches.length > 0 && unfinishedPoolMatches === 0, unfinishedPoolMatches, config: parseDrawConfig(t.drawConfigJson) }}
        />
        {allMatches.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
            <p className="text-text-secondary">
              <span className="tabular">{detail.pools.length}</span> pools ·{" "}
              <span className="tabular">{poolMatches.length}</span> pool matches · <span className="tabular">{detail.bracket.matches.length}</span> bracket matches ·{" "}
              {bracketSeeded ? "bracket seeded" : "bracket not seeded"}
            </p>
            <Link href={`/t/${t.slug}/bracket`} className="target inline-flex items-center gap-1 type-label text-text-secondary hover:text-text-primary">
              View as players see it
              <Icons.chevronRight size={14} />
            </Link>
          </div>
        ) : t.status !== "registration_closed" ? (
          <p className="text-text-tertiary">The draw is generated once registration is closed.</p>
        ) : null}
      </section>

      <section aria-labelledby="details-heading">
        <SectionHeading id="details-heading">Details</SectionHeading>
        <EventForm
          mode="edit"
          options={options}
          tournament={t}
          sponsors={detail.sponsors}
          locks={{ readOnly, beneficiary: donationsExist, currency: donationsExist, format: allMatches.length > 0, minTeams: activeTeams }}
        />
      </section>
    </Container>
  );
}
