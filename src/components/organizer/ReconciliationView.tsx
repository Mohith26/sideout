import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icons } from "@/components/ui/icons";
import { Stat } from "@/components/ui/Stat";
import { StatusPill, type PillSpec } from "@/components/ui/StatusPill";
import { cx } from "@/lib/cx";
import type { ParticipantReconciliation } from "@/server/lucra";

/**
 * The organizer's participant reconciliation (spec §7.5): Lucra's participant
 * list read back and set against the registered teams. Four buckets, each
 * a table: matched (registered and listed), missing (registered and linked
 * but not in Lucra — the silent auto-join was skipped, or the player has not
 * entered yet), unlinked (registered, never signed in to Lucra) and extra
 * (in Lucra's list, on no registered team). Dense, table-driven, on the
 * console's design system; nothing here is inferred from a join's answer.
 */
export interface ReconciliationViewProps {
  reconciliation: ParticipantReconciliation;
  /** When the read ran, already formatted for the venue's zone. */
  readAtLabel: string;
}

type Matched = ParticipantReconciliation["matched"][number];
type Missing = ParticipantReconciliation["missing"][number];
type Unlinked = ParticipantReconciliation["unlinked"][number];
type Extra = ParticipantReconciliation["extra"][number];

const MATCHED: PillSpec = { label: "In Lucra", tone: "success", icon: Icons.circleCheck };
const MISSING: PillSpec = { label: "Not in Lucra", tone: "attention", icon: Icons.circleAlert };
const UNLINKED: PillSpec = { label: "No Lucra account", tone: "muted", icon: Icons.circleDashed };
const EXTRA: PillSpec = { label: "Not on a team", tone: "attention", icon: Icons.triangleAlert };

const mono = "break-all font-mono text-[13px] text-text-secondary";

const matchedColumns: DataTableColumn<Matched>[] = [
  { key: "player", header: "Player", render: (r) => <span className="text-text-primary">{r.displayName}</span> },
  { key: "team", header: "Team", render: (r) => <span className="text-text-secondary">{r.teamName}</span> },
  { key: "external", header: "externalId", hideBelowMd: true, render: (r) => <span className={mono}>{r.externalId}</span> },
  { key: "lucra", header: "Lucra user", hideBelowMd: true, render: (r) => <span className={mono}>{r.lucraUserId}</span> },
  { key: "state", header: "State", render: () => <StatusPill spec={MATCHED} size="sm" /> },
];

const missingColumns: DataTableColumn<Missing>[] = [
  { key: "player", header: "Player", render: (r) => <span className="text-text-primary">{r.displayName}</span> },
  { key: "team", header: "Team", render: (r) => <span className="text-text-secondary">{r.teamName}</span> },
  { key: "external", header: "externalId", hideBelowMd: true, render: (r) => <span className={mono}>{r.externalId}</span> },
  { key: "state", header: "State", render: () => <StatusPill spec={MISSING} size="sm" /> },
];

const unlinkedColumns: DataTableColumn<Unlinked>[] = [
  { key: "player", header: "Player", render: (r) => <span className="text-text-primary">{r.displayName}</span> },
  { key: "team", header: "Team", render: (r) => <span className="text-text-secondary">{r.teamName}</span> },
  { key: "state", header: "State", render: () => <StatusPill spec={UNLINKED} size="sm" /> },
];

const extraColumns: DataTableColumn<Extra>[] = [
  { key: "user", header: "Lucra user", render: (r) => <span className="text-text-primary">{r.userName ?? <span className="text-text-tertiary">no username</span>}</span> },
  { key: "lucra", header: "Lucra id", hideBelowMd: true, render: (r) => <span className={mono}>{r.lucraUserId}</span> },
  { key: "external", header: "externalId", hideBelowMd: true, render: (r) => <span className={mono}>{r.externalId ?? "—"}</span> },
  { key: "state", header: "State", render: () => <StatusPill spec={EXTRA} size="sm" /> },
];

function Bucket<T>({ id, title, hint, rows, columns, getKey, empty, tone }: { id: string; title: string; hint: string; rows: T[]; columns: DataTableColumn<T>[]; getKey: (row: T) => string; empty: string; tone?: "attention" }) {
  return (
    <section aria-labelledby={`${id}-heading`} data-testid={`reconciliation-${id}`} data-count={rows.length}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={`${id}-heading`} className={cx("type-label", tone === "attention" && rows.length > 0 ? "text-fault" : "text-text-tertiary")}>
          {title} <span className="tabular">{rows.length}</span>
        </h2>
        <p className="type-label text-text-tertiary">{hint}</p>
      </div>
      {rows.length === 0 ? <p className="surface-inset rounded-md px-4 py-3 text-text-secondary">{empty}</p> : <DataTable columns={columns} rows={rows} getRowKey={getKey} caption={title} />}
    </section>
  );
}

export function ReconciliationView({ reconciliation: r, readAtLabel }: ReconciliationViewProps) {
  const divergent = r.missing.length + r.unlinked.length + r.extra.length;
  return (
    <div className="space-y-6" data-testid="reconciliation" data-divergent={divergent}>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Lucra participants" value={String(r.lucraParticipants)} hint={`matchup ${r.matchupId.slice(0, 8)} · ${r.lucraStatus}`} />
        <Stat label="Matched" value={String(r.matched.length)} hint={`read ${readAtLabel}`} />
        <Stat label="Missing · unlinked" value={`${r.missing.length} · ${r.unlinked.length}`} hint="registered, not entered" />
        <Stat label="Extra" value={String(r.extra.length)} hint="in Lucra, on no team" />
      </dl>
      {divergent === 0 ? (
        <EmptyState icon="circleCheck" title="Lucra agrees with the roster" body="Every registered player is listed by Lucra and nobody else is. Re-check after registration changes; nothing here is assumed from a join." />
      ) : null}
      <Bucket id="missing" title="Missing" hint="Lucra's list does not include them" rows={r.missing} columns={missingColumns} getKey={(x) => x.userId} empty="Every linked player is in Lucra's list." tone="attention" />
      <Bucket id="unlinked" title="Unlinked" hint="never signed in to Lucra" rows={r.unlinked} columns={unlinkedColumns} getKey={(x) => x.userId} empty="Every registered player has a Lucra link." tone="attention" />
      <Bucket id="extra" title="Extra" hint="in Lucra, not on a registered team" rows={r.extra} columns={extraColumns} getKey={(x) => x.lucraUserId} empty="Lucra lists nobody who is not registered here." tone="attention" />
      <Bucket id="matched" title="Matched" hint="registered and listed by Lucra" rows={r.matched} columns={matchedColumns} getKey={(x) => x.userId} empty="Nobody yet." />
    </div>
  );
}
