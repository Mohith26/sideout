import { Container } from "@/components/shell/Container";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Stat } from "@/components/ui/Stat";
import { Icons } from "@/components/ui/icons";
import { ImpactMeter } from "@/components/tournament/ImpactMeter";
import { SPONSOR_TIER_LABEL } from "@/components/tournament/labels";
import { getTournamentImpact, type DonorWallEntry, type TournamentImpact } from "@/db/queries/impact";
import { SPONSOR_TIER_ORDER } from "@/db/queries/tournaments";
import type { RewardStatus } from "@/db/schema";
import { formatCents, formatDate, ordinal } from "@/lib/format";
import { cx } from "@/lib/cx";
import { requireTournament } from "../_lib";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<DonorWallEntry["kind"], string> = {
  team_entry: "Team entry",
  supporter: "Supporter",
  anonymous: "Supporter",
};

const REWARD_STATUS_LABEL: Record<RewardStatus, string> = {
  projected: "Projected",
  awarded: "Awarded",
  claimed: "Claimed",
};

/** Impact tab: beneficiary story, raised vs goal, donor wall, sponsor tiers (spec §11.2). */
export default async function ImpactTab({ params }: PageProps<"/t/[slug]">) {
  const { slug } = await params;
  const { tournament: t, charity } = await requireTournament(slug);
  const impact = getTournamentImpact(t);
  const { breakdown } = impact;

  const donorColumns: DataTableColumn<DonorWallEntry>[] = [
    { key: "who", header: "Gift from", render: (d) => <span className={cx("font-medium", d.kind === "anonymous" ? "text-text-secondary" : "text-text-primary")}>{d.label}</span> },
    { key: "kind", header: "Type", hideBelowMd: true, render: (d) => <span className="text-text-secondary">{KIND_LABEL[d.kind]}</span> },
    { key: "when", header: "Date", hideBelowMd: true, render: (d) => <span className="tabular text-text-secondary">{formatDate(d.createdAt, t.venueTimezone)}</span> },
    { key: "amount", header: "Amount", numeric: true, render: (d) => <span className="text-ember">{formatCents(d.amountCents, d.currency)}</span> },
  ];

  type RewardRow = TournamentImpact["rewards"][number];
  const rewardColumns: DataTableColumn<RewardRow>[] = [
    { key: "place", header: "Place", width: "w-16", render: (r) => <span className="tabular font-medium text-text-primary">{ordinal(r.placement)}</span> },
    { key: "team", header: "Team", render: (r) => <span className="text-text-primary">{r.teamName}</span> },
    { key: "reward", header: "Reward", render: (r) => <span className="text-text-secondary">{r.description}</span> },
    { key: "amount", header: "Value", numeric: true, render: (r) => (r.amountCents === null ? <span className="text-text-tertiary">Item</span> : formatCents(r.amountCents, r.currency ?? t.currency)) },
    { key: "status", header: "Status", hideBelowMd: true, render: (r) => <span className="text-text-secondary">{REWARD_STATUS_LABEL[r.status]}</span> },
  ];

  return (
    <Container className="space-y-10 py-6 md:py-8">
      <section aria-labelledby="story-heading" className="surface-raised rounded-md p-5 md:p-6">
        <h2 id="story-heading" className="type-label text-text-tertiary">
          Beneficiary
        </h2>
        <p className="type-heading mt-1">{charity.name}</p>
        <p className="mt-2 max-w-prose text-text-secondary">{charity.missionShort}</p>
        {charity.websiteUrl ? (
          <a href={charity.websiteUrl} target="_blank" rel="noreferrer noopener" className="target mt-3 inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt">
            Visit their site
            <Icons.externalLink size={14} />
          </a>
        ) : null}
      </section>

      <section aria-labelledby="raised-heading">
        <h2 id="raised-heading" className="sr-only">
          Raised versus goal
        </h2>
        <ImpactMeter raisedCents={breakdown.raisedCents} goalCents={breakdown.goalCents} currency={breakdown.currency} donorCount={breakdown.donorCount} />
        <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Team entries" value={formatCents(breakdown.entryCents, breakdown.currency)} hint={`${breakdown.entryCount} teams`} />
          <Stat label="Supporter gifts" value={formatCents(breakdown.supporterCents, breakdown.currency)} hint={`${breakdown.donorCount - breakdown.entryCount} gifts`} />
          <Stat label="Pending" value={formatCents(breakdown.pendingCents, breakdown.currency)} hint="Not yet counted" />
          <Stat label="Goal" value={formatCents(breakdown.goalCents, breakdown.currency)} hint={breakdown.fraction >= 1 ? "Met" : `${formatCents(breakdown.goalCents - breakdown.raisedCents, breakdown.currency)} to go`} />
        </dl>
      </section>

      <section aria-labelledby="donors-heading">
        <h2 id="donors-heading" className="type-label mb-3 text-text-tertiary">
          Donor wall · <span className="tabular">{impact.donorWall.length}</span>
        </h2>
        {impact.donorWall.length === 0 ? (
          <EmptyState icon="heartHandshake" title="No gifts yet" body="Team entries and supporter gifts appear here as they complete." />
        ) : (
          <DataTable columns={donorColumns} rows={impact.donorWall} getRowKey={(d) => d.id} caption="Completed gifts, newest first" />
        )}
      </section>

      <section aria-labelledby="sponsors-heading">
        <h2 id="sponsors-heading" className="type-label mb-3 text-text-tertiary">
          Sponsor tiers
        </h2>
        {impact.sponsors.length === 0 ? (
          <EmptyState icon="handCoins" title="No sponsors yet" />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {SPONSOR_TIER_ORDER.map((tier) => {
              const inTier = impact.sponsors.filter((s) => s.tier === tier);
              return (
                <div key={tier} className="surface-raised rounded-md p-4">
                  <h3 className="type-label text-text-tertiary">{SPONSOR_TIER_LABEL[tier]}</h3>
                  {inTier.length === 0 ? (
                    <p className="mt-2 text-text-tertiary">Open</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {inTier.map((s) => (
                        <li key={s.id} className="flex items-baseline justify-between gap-3">
                          <span className="font-medium text-text-primary">{s.name}</span>
                          <span className="tabular type-label text-text-secondary">{formatCents(s.prizeContributionCents, s.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 type-label text-text-tertiary">
          Sponsor contributions fund the prize pool (<span className="tabular">{formatCents(impact.sponsorPrizeCents, breakdown.currency)}</span>). They are a separate ledger from donations and are never counted toward the goal.
        </p>
      </section>

      {impact.rewards.length > 0 ? (
        <section aria-labelledby="rewards-heading">
          <h2 id="rewards-heading" className="type-label mb-3 text-text-tertiary">
            Rewards
          </h2>
          <DataTable columns={rewardColumns} rows={impact.rewards} getRowKey={(r) => r.id} caption="Sponsor-funded rewards by placement" />
        </section>
      ) : null}
    </Container>
  );
}
