import { Container } from "@/components/shell/AppShell";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { MATCH_STATUS_PILL, StatusPill } from "@/components/ui/StatusPill";
import { ImpactMeter } from "@/components/tournament/ImpactMeter";
import { MatchCard } from "@/components/tournament/MatchCard";
import { SponsorRow } from "@/components/tournament/SponsorRow";
import { TeamName } from "@/components/tournament/TeamName";
import { DIVISION_LABEL, FORMAT_LABEL } from "@/components/tournament/TournamentCard";
import { getTournamentOverview, listLiveMatches, type RoundView } from "@/db/queries/tournaments";
import { MATCH_STATUSES, type MatchStatus } from "@/db/schema";
import { formatCents, formatTime } from "@/lib/format";
import { requireTournament } from "./_lib";

export const dynamic = "force-dynamic";

const STATUS_ORDER: readonly MatchStatus[] = MATCH_STATUSES;

function RoundStatus({ round }: { round: RoundView }) {
  const parts = STATUS_ORDER.filter((s) => (round.byStatus[s] ?? 0) > 0);
  return (
    <span className="flex flex-wrap gap-1.5">
      {parts.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StatusPill spec={MATCH_STATUS_PILL[s]} size="sm" />
          <span className="tabular type-label text-text-tertiary">{round.byStatus[s]}</span>
        </span>
      ))}
    </span>
  );
}

/** Overview tab: format, division, courts, schedule, sponsors, impact meter (spec §11.2). */
export default async function OverviewPage({ params }: PageProps<"/t/[slug]">) {
  const { slug } = await params;
  const summary = requireTournament(slug);
  const { tournament: t, activeTeams, raisedCents, donorCount } = summary;
  const overview = getTournamentOverview(t.id);
  const live = t.status === "live" ? listLiveMatches(t.id) : [];
  const bracketRounds = overview.rounds.filter((r) => r.key.startsWith("bracket-")).length;

  const scheduleColumns: DataTableColumn<RoundView>[] = [
    { key: "round", header: "Round", render: (r) => <span className="font-medium text-text-primary">{r.label}</span> },
    {
      key: "time",
      header: "Starts",
      render: (r) => <span className="tabular text-text-secondary">{r.startsAt === null ? "—" : formatTime(r.startsAt, t.venueTimezone)}</span>,
    },
    { key: "courts", header: "Courts", hideBelowMd: true, render: (r) => <span className="text-text-secondary">{r.courts.join(", ") || "—"}</span> },
    { key: "matches", header: "Matches", numeric: true, render: (r) => r.total },
    { key: "status", header: "Status", render: (r) => <RoundStatus round={r} /> },
  ];

  const facts: Array<{ label: string; value: string }> = [
    { label: "Format", value: FORMAT_LABEL[t.format] },
    { label: "Division", value: DIVISION_LABEL[t.division] },
    { label: "Courts", value: overview.courts.length ? `${overview.courts.length}` : "Set at the draw" },
    { label: "Teams", value: `${activeTeams} of ${t.maxTeams}` },
    { label: "Entry donation", value: formatCents(t.entryDonationCents, t.currency) },
    { label: "Prizes", value: t.prizeKind === "free_to_play_rewards" ? "Sponsor-funded rewards" : "Real money (flagged off)" },
  ];

  return (
    <Container className="space-y-10 py-6 md:py-8">
      <section aria-label="Event facts">
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {facts.map((f) => (
            <div key={f.label} className="surface-raised rounded-md p-4">
              <dt className="type-label text-text-tertiary">{f.label}</dt>
              <dd className="tabular mt-1 font-medium text-text-primary">{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {live.length > 0 ? (
        <section aria-labelledby="on-sand-heading">
          <h2 id="on-sand-heading" className="type-label mb-3 text-text-tertiary">
            On the sand now
          </h2>
          <ul className="-mx-gutter flex snap-x gap-3 overflow-x-auto px-gutter pb-1 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 xl:grid-cols-3">
            {live.map((m) => (
              <li key={m.match.id} className="snap-start md:min-w-0">
                <MatchCard view={m} bracketRounds={bracketRounds} className="md:w-full" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="schedule-heading">
        <h2 id="schedule-heading" className="type-label mb-3 text-text-tertiary">
          Schedule
        </h2>
        {overview.rounds.length === 0 ? (
          <EmptyState
            icon="clock"
            title="Schedule arrives with the draw"
            body={`Pools and courts are assigned once registration closes. ${activeTeams} of ${t.maxTeams} teams are in so far.`}
          />
        ) : (
          <DataTable columns={scheduleColumns} rows={overview.rounds} getRowKey={(r) => r.key} caption="Rounds, start times, courts and match status" />
        )}
      </section>

      {overview.pools.length > 0 ? (
        <section aria-labelledby="pools-heading">
          <h2 id="pools-heading" className="type-label mb-3 text-text-tertiary">
            Pools
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {overview.pools.map((pool) => (
              <div key={pool.id} className="surface-raised rounded-md p-4">
                <div className="flex items-baseline justify-between">
                  <h3 className="type-subheading">{pool.label}</h3>
                  <span className="type-label text-text-tertiary">{pool.courtLabel}</span>
                </div>
                <ol className="mt-3 space-y-1.5 text-text-secondary">
                  {pool.teams.map((team) => (
                    <li key={team.id} className="flex items-center justify-between gap-3">
                      <TeamName team={team} seed className="text-text-primary" />
                      <span className="type-label truncate text-text-tertiary">{team.members.map((m) => m.displayName.split(" ")[0]).join(" & ")}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="sponsors-heading">
        <h2 id="sponsors-heading" className="type-label mb-3 text-text-tertiary">
          Sponsors
        </h2>
        {overview.sponsors.length ? (
          <SponsorRow sponsors={overview.sponsors} />
        ) : (
          <EmptyState icon="handCoins" title="No sponsors yet" body="Sponsor prize contributions fund rewards; they never touch donations." />
        )}
      </section>

      <section aria-labelledby="impact-heading" className="surface-raised rounded-md p-5 md:p-6">
        <h2 id="impact-heading" className="type-label text-text-tertiary">
          Impact · {summary.charity.name}
        </h2>
        <ImpactMeter className="mt-3" raisedCents={raisedCents} goalCents={t.fundraisingGoalCents} currency={t.currency} donorCount={donorCount} />
      </section>
    </Container>
  );
}
