import type { Sponsor, SponsorTier } from "@/db/schema";
import { formatCents } from "@/lib/format";
import { cx } from "@/lib/cx";

const TIER_LABEL: Record<SponsorTier, string> = {
  presenting: "Presenting",
  court: "Court",
  prize: "Prize",
};

export interface SponsorRowProps {
  sponsors: readonly Sponsor[];
  /** Show each sponsor's prize-pool contribution (the prize ledger, not donations). */
  showContribution?: boolean;
  className?: string;
}

/** Sponsors as text wordmarks with their tier; logos are optional and never stock art. */
export function SponsorRow({ sponsors, showContribution = false, className }: SponsorRowProps) {
  if (sponsors.length === 0) return null;
  return (
    <ul className={cx("flex flex-wrap gap-2", className)}>
      {sponsors.map((s) => (
        <li key={s.id} className="surface-raised flex min-h-11 items-center gap-3 rounded-sm px-3 py-2">
          <span className="font-medium text-text-primary">{s.name}</span>
          <span className="type-label text-text-tertiary">{TIER_LABEL[s.tier]}</span>
          {showContribution && s.prizeContributionCents > 0 ? (
            <span className="tabular type-label text-text-secondary">{formatCents(s.prizeContributionCents, s.currency)}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export { TIER_LABEL as SPONSOR_TIER_LABEL };
