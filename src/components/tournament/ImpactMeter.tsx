import { formatCents, formatPercent } from "@/lib/format";
import { cx } from "@/lib/cx";

/**
 * Raised versus goal. `--ember` is the charity color and appears nowhere else.
 * The bar caps at 100% visually; the label does not, so a met goal reads as
 * what it is.
 */
export interface ImpactMeterProps {
  raisedCents: number;
  goalCents: number;
  currency: string;
  donorCount?: number;
  variant?: "compact" | "full";
  className?: string;
}

export function ImpactMeter({ raisedCents, goalCents, currency, donorCount, variant = "full", className }: ImpactMeterProps) {
  const fraction = goalCents > 0 ? raisedCents / goalCents : 0;
  const width = Math.min(1, fraction);
  const met = fraction >= 1;
  return (
    <div className={className}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          {variant === "full" ? <div className="type-label text-text-tertiary">Raised for the beneficiary</div> : null}
          <div className={cx("tabular text-ember", variant === "full" ? "type-display-l" : "type-heading")}>
            {formatCents(raisedCents, currency)}
          </div>
        </div>
        <div className="text-end text-text-secondary">
          <div className="tabular">
            <span className="text-text-primary">{formatPercent(fraction)}</span> of {formatCents(goalCents, currency)}
          </div>
          {variant === "full" && donorCount !== undefined ? (
            <div className="type-label mt-0.5 text-text-tertiary">
              <span className="tabular">{donorCount}</span> {donorCount === 1 ? "gift" : "gifts"}
            </div>
          ) : null}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Fundraising progress"
        aria-valuemin={0}
        aria-valuemax={goalCents}
        aria-valuenow={Math.min(raisedCents, goalCents)}
        aria-valuetext={`${formatCents(raisedCents, currency)} of ${formatCents(goalCents, currency)}`}
        className={cx("mt-3 w-full overflow-hidden rounded-full bg-bg-inset", variant === "full" ? "h-2.5" : "h-2")}
      >
        <div className="h-full rounded-full bg-ember" style={{ width: `${width * 100}%` }} />
      </div>
      {variant === "full" ? (
        <div className="mt-2 flex items-center justify-between type-label text-text-tertiary">
          <span>{met ? "Goal met" : "Toward goal"}</span>
          <span className="tabular">{met ? `+${formatCents(raisedCents - goalCents, currency)} over` : `${formatCents(goalCents - raisedCents, currency)} to go`}</span>
        </div>
      ) : null}
    </div>
  );
}
