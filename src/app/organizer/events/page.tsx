import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/shell/Container";
import { DIVISION_LABEL, FORMAT_LABEL } from "@/components/tournament/labels";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { Icons } from "@/components/ui/icons";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { listTournamentSummaries, type TournamentSummary } from "@/db/queries/tournaments";
import { TOURNAMENT_STATUSES } from "@/db/schema";
import { requestNow } from "@/lib/clock";
import { formatCents, formatDate } from "@/lib/format";
import { sweepDueDonations } from "@/server/donations/stub-provider";
import { requireOrganizerViewer } from "../_lib";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Events" };

/** Console order: what needs attention first — live, then the pipeline, then history. */
const STATUS_ORDER = new Map(["live", "awaiting_settlement", "registration_closed", "registration_open", "draft", "settled", "cancelled"].map((s, i) => [s, i]));

const columns: DataTableColumn<TournamentSummary>[] = [
  {
    key: "event",
    header: "Event",
    render: (s) => (
      <Link href={`/organizer/events/${s.tournament.id}`} className="group target -my-2.5 flex min-w-0 flex-col justify-center rounded-sm py-2.5 after:absolute after:inset-0 md:after:hidden">
        <span className="truncate font-medium text-text-primary group-hover:text-volt">{s.tournament.name}</span>
        <span className="truncate type-label text-text-tertiary">
          {DIVISION_LABEL[s.tournament.division]} · {FORMAT_LABEL[s.tournament.format]} · {s.tournament.venueCity}
        </span>
      </Link>
    ),
  },
  { key: "status", header: "Status", render: (s) => <StatusPill spec={TOURNAMENT_STATUS_PILL[s.tournament.status]} size="sm" /> },
  { key: "date", header: "Starts", hideBelowMd: true, render: (s) => <span className="tabular text-text-secondary">{formatDate(s.tournament.startsAt, s.tournament.venueTimezone)}</span> },
  { key: "teams", header: "Teams", numeric: true, render: (s) => `${s.activeTeams}/${s.tournament.maxTeams}` },
  { key: "live", header: "On court", numeric: true, hideBelowMd: true, render: (s) => (s.liveMatchCount > 0 ? <span className="text-surf">{s.liveMatchCount}</span> : <span className="text-text-tertiary">0</span>) },
  { key: "raised", header: "Raised", numeric: true, hideBelowMd: true, render: (s) => <span className="text-ember">{formatCents(s.raisedCents, s.tournament.currency)}</span> },
  {
    key: "actions",
    header: <span className="sr-only">Open</span>,
    align: "end",
    hideBelowMd: true,
    render: (s) => (
      <span className="flex justify-end gap-1">
        {s.tournament.status === "live" ? (
          <Link href={`/organizer/events/${s.tournament.id}/board`} className="target inline-flex items-center gap-1 rounded-sm px-2 type-label text-text-secondary hover:text-text-primary">
            Board
          </Link>
        ) : null}
        <Link href={`/organizer/events/${s.tournament.id}`} className="target inline-flex items-center gap-1 rounded-sm px-2 type-label text-text-secondary hover:text-text-primary" aria-label={`Open ${s.tournament.name}`}>
          Builder
          <Icons.chevronRight size={14} />
        </Link>
      </span>
    ),
  },
];

export default async function OrganizerEventsPage() {
  await requireOrganizerViewer();
  sweepDueDonations(requestNow());
  const all = listTournamentSummaries([...TOURNAMENT_STATUSES]).sort(
    (a, b) => (STATUS_ORDER.get(a.tournament.status) ?? 9) - (STATUS_ORDER.get(b.tournament.status) ?? 9) || b.tournament.startsAt - a.tournament.startsAt,
  );
  const counts = new Map<string, number>();
  for (const s of all) counts.set(s.tournament.status, (counts.get(s.tournament.status) ?? 0) + 1);
  return (
    <Container className="space-y-6 py-6 md:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="type-display-l">Events</h1>
          <p className="mt-1 text-text-secondary">
            <span className="tabular">{all.length}</span> events ·{" "}
            {[...counts.entries()].map(([status, n], i) => (
              <span key={status}>
                {i > 0 ? " · " : ""}
                <span className="tabular">{n}</span> {TOURNAMENT_STATUS_PILL[status as keyof typeof TOURNAMENT_STATUS_PILL].label.toLowerCase()}
              </span>
            ))}
          </p>
        </div>
        <Button variant="primary" href="/organizer/events/new" iconStart={<Icons.plus size={18} />}>
          New event
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={all}
        getRowKey={(s) => s.tournament.id}
        rowClassName={() => "relative"}
        caption="Every event with its status, capacity, live matches and amount raised"
        emptyLabel="No events yet. Create the first one."
      />
    </Container>
  );
}
