import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icons } from "@/components/ui/icons";
import type { FinalStandingRow, ProjectedReward } from "@/server/close";
import { formatCents } from "@/lib/format";
import { cx } from "@/lib/cx";

/**
 * What the organizer confirms before anything settles (spec §11.6): the
 * final standings and the projected rewards exactly as the close will freeze
 * them, and the hash that `POST …/close` must echo. Rewards are sponsor-funded
 * (`ember` never appears here: this is the prize ledger, not the charity one).
 */
export interface FrozenPreviewProps {
  standings: readonly FinalStandingRow[];
  rewards: readonly ProjectedReward[];
  previewHash: string;
  /** Set once the tournament closed: when and by whom. */
  frozenAt?: { closedAt: number; closedBy: string; timeZone: string } | null;
  className?: string;
}

const STANDING_COLUMNS: DataTableColumn<FinalStandingRow>[] = [
  { key: "placement", header: "#", numeric: true, width: "w-12", render: (r) => <span className="tabular font-medium text-text-primary">{r.placement}</span> },
  { key: "team", header: "Team", render: (r) => <span className="font-medium text-text-primary">{r.teamName}</span> },
  { key: "detail", header: "How", hideBelowMd: true, render: (r) => <span className="text-text-secondary">{r.detail}</span> },
  {
    key: "record",
    header: "W–L",
    numeric: true,
    render: (r) => (
      <span className="tabular text-text-secondary">
        {r.wins}–{r.losses}
      </span>
    ),
  },
];

const REWARD_COLUMNS: DataTableColumn<ProjectedReward>[] = [
  { key: "placement", header: "#", numeric: true, width: "w-12", render: (r) => <span className="tabular font-medium text-text-primary">{r.placement}</span> },
  { key: "team", header: "Team", render: (r) => <span className="font-medium text-text-primary">{r.teamName}</span> },
  { key: "description", header: "Reward", render: (r) => <span className="text-text-secondary">{r.description}</span> },
  {
    key: "amount",
    header: "Amount",
    numeric: true,
    render: (r) => <span className="tabular text-text-primary">{r.amountCents !== null && r.currency ? formatCents(r.amountCents, r.currency) : "—"}</span>,
  },
];

export function FrozenPreview({ standings, rewards, previewHash, frozenAt, className }: FrozenPreviewProps) {
  const totalCents = rewards.reduce((sum, r) => sum + (r.amountCents ?? 0), 0);
  const currency = rewards.find((r) => r.currency)?.currency ?? "USD";
  return (
    <div className={cx("space-y-8", className)}>
      <section aria-labelledby="frozen-standings-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="frozen-standings-heading" className="type-label text-text-tertiary">
            Final standings
          </h2>
          <span className="tabular type-label text-text-tertiary">{standings.length} teams</span>
        </div>
        <DataTable columns={STANDING_COLUMNS} rows={standings} getRowKey={(r) => r.teamId} caption="Final standings as they will be frozen" emptyLabel="No teams to place." />
      </section>

      <section aria-labelledby="frozen-rewards-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="frozen-rewards-heading" className="type-label text-text-tertiary">
            Projected rewards
          </h2>
          {totalCents > 0 ? <span className="tabular type-label text-text-tertiary">{formatCents(totalCents, currency)} in cash rewards</span> : null}
        </div>
        {rewards.length ? (
          <DataTable columns={REWARD_COLUMNS} rows={rewards} getRowKey={(r) => r.id} caption="Projected rewards as they will be frozen" />
        ) : (
          <EmptyState icon="gift" title="No rewards projected" body="Nothing is scheduled to be awarded for this event. Closing it records the standings only." />
        )}
      </section>

      <section aria-labelledby="frozen-hash-heading" className="surface-inset rounded-md p-4">
        <h2 id="frozen-hash-heading" className="flex items-center gap-2 type-label text-text-tertiary">
          <Icons.info size={14} />
          {frozenAt ? "Frozen preview" : "Preview hash"}
        </h2>
        <p className="mt-2 text-text-secondary">
          {frozenAt
            ? "This is exactly what was confirmed at close. The hash below is what the organizer signed off on."
            : "Closing sends this hash back. If a result or a reward changes in between, the close is refused and you review a fresh preview."}
        </p>
        <code data-testid="preview-hash" className="mt-2 block rounded-xs bg-bg-base px-2 py-1.5 font-mono text-mono-stat break-all text-text-primary">
          {previewHash}
        </code>
        {frozenAt ? (
          <p className="mt-2 tabular type-label text-text-tertiary">
            Closed {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: frozenAt.timeZone }).format(new Date(frozenAt.closedAt))} by {frozenAt.closedBy}
          </p>
        ) : null}
      </section>
    </div>
  );
}
