import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/shell/Container";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icons } from "@/components/ui/icons";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { ImpactMeter } from "@/components/tournament/ImpactMeter";
import { getGlobalImpact, type GlobalImpact } from "@/db/queries/impact";
import { requestNow } from "@/lib/clock";
import { formatCents, formatDate, formatPercent } from "@/lib/format";
import { load } from "@/lib/load";
import { sweepDueDonations } from "@/server/donations/stub-provider";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Impact" };

type EventRow = GlobalImpact["perEvent"][number];

const columns: DataTableColumn<EventRow>[] = [
  {
    key: "event",
    header: "Event",
    render: (r) => (
      <Link href={`/t/${r.tournament.slug}`} className="font-medium text-text-primary hover:text-volt">
        {r.tournament.name}
      </Link>
    ),
  },
  { key: "status", header: "Status", render: (r) => <StatusPill spec={TOURNAMENT_STATUS_PILL[r.tournament.status]} size="sm" />, hideBelowMd: true },
  { key: "date", header: "Date", render: (r) => <span className="tabular text-text-secondary">{formatDate(r.tournament.startsAt, r.tournament.venueTimezone)}</span>, hideBelowMd: true },
  { key: "gifts", header: "Gifts", numeric: true, render: (r) => r.donorCount },
  { key: "raised", header: "Raised", numeric: true, render: (r) => <span className="text-ember">{formatCents(r.raisedCents, r.tournament.currency)}</span> },
  {
    key: "goal",
    header: "Of goal",
    numeric: true,
    render: (r) => <span className="text-text-secondary">{formatPercent(r.tournament.fundraisingGoalCents ? r.raisedCents / r.tournament.fundraisingGoalCents : 0)}</span>,
  },
];

export default function ImpactPage() {
  const loaded = load(() => {
    sweepDueDonations(requestNow());
    return getGlobalImpact();
  });
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const impact = loaded.data;

  return (
    <Container className="space-y-10 py-6 md:py-8">
      <div>
        <h1 className="type-display-l">Impact</h1>
        <p className="mt-2 max-w-prose text-text-secondary">
          Every entry fee is a charitable donation and every event has a beneficiary. Totals here are sums of completed gifts across all events; prize
          money is sponsor-funded and kept on a separate ledger.
        </p>
      </div>

      {impact.charity ? (
        <section aria-labelledby="beneficiary-heading" className="surface-raised rounded-md p-5 md:p-6">
          <h2 id="beneficiary-heading" className="type-label text-text-tertiary">
            Beneficiary
          </h2>
          <p className="type-heading mt-1">{impact.charity.name}</p>
          <p className="mt-2 max-w-prose text-text-secondary">{impact.charity.missionShort}</p>
          {impact.charity.websiteUrl ? (
            <a
              href={impact.charity.websiteUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="target mt-3 inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt"
            >
              Visit their site
              <Icons.externalLink size={14} />
            </a>
          ) : null}
          <ImpactMeter
            className="mt-6"
            raisedCents={impact.totalRaisedCents}
            goalCents={impact.totalGoalCents}
            currency={impact.currency}
            donorCount={impact.donorCount}
          />
        </section>
      ) : (
        <EmptyState icon="heartHandshake" title="No beneficiary yet" />
      )}

      <section aria-labelledby="per-event-heading">
        <h2 id="per-event-heading" className="type-label mb-3 text-text-tertiary">
          By event
        </h2>
        <DataTable columns={columns} rows={impact.perEvent} getRowKey={(r) => r.tournament.id} caption="Amount raised per event" />
      </section>
    </Container>
  );
}
