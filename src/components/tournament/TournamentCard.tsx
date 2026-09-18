import Link from "next/link";
import type { TournamentSummary } from "@/db/queries/tournaments";
import { Icons } from "@/components/ui/icons";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { ImpactMeter } from "@/components/tournament/ImpactMeter";
import { DIVISION_LABEL, FORMAT_LABEL } from "@/components/tournament/labels";
import { formatCents, formatDate, formatDateRange, formatRelative } from "@/lib/format";
import { cx } from "@/lib/cx";

export interface TournamentCardProps {
  summary: TournamentSummary;
  variant?: "featured" | "compact";
  nowMs: number;
  className?: string;
}

/** One event. Featured on Home for the live or next event; compact in lists. */
export function TournamentCard({ summary, variant = "compact", nowMs, className }: TournamentCardProps) {
  const { tournament: t, charity, activeTeams, raisedCents, donorCount, liveMatchCount } = summary;
  const href = `/t/${t.slug}`;
  const featured = variant === "featured";
  const pill = TOURNAMENT_STATUS_PILL[t.status];
  const when =
    t.status === "live"
      ? formatDateRange(t.startsAt, t.endsAt, t.venueTimezone)
      : t.status === "settled"
        ? formatDate(t.startsAt, t.venueTimezone)
        : `${formatDate(t.startsAt, t.venueTimezone)} · ${formatRelative(t.startsAt, nowMs)}`;

  return (
    <article className={cx("surface-raised relative rounded-md has-[a[data-target=card]:focus-visible]:outline-2 has-[a[data-target=card]:focus-visible]:outline-offset-2 has-[a[data-target=card]:focus-visible]:outline-volt", featured ? "p-5 md:p-6" : "p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusPill spec={pill} />
        <span className="type-label text-text-tertiary">
          {DIVISION_LABEL[t.division]} · {FORMAT_LABEL[t.format]}
        </span>
      </div>
      <h3 className={cx("mt-3", featured ? "type-display-l" : "type-heading")}>
        <Link href={href} data-target="card" className="after:absolute after:inset-0 after:rounded-md hover:text-volt focus-visible:outline-none">
          {t.name}
        </Link>
      </h3>
      {t.subtitle ? <p className="mt-1 text-text-secondary">{t.subtitle}</p> : null}

      <dl className={cx("mt-4 grid gap-x-6 gap-y-2 text-text-secondary", featured ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2")}>
        <div className="flex items-center gap-2">
          <Icons.calendar size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">When</dt>
          <dd className="tabular">{when}</dd>
        </div>
        <div className="flex items-center gap-2">
          <Icons.mapPin size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">Where</dt>
          <dd className="truncate">
            {t.venueCity}, {t.venueState}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Icons.users size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">Teams</dt>
          <dd className="tabular">
            {activeTeams} of {t.maxTeams} teams
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Icons.heartHandshake size={16} className="shrink-0 text-text-tertiary" />
          <dt className="sr-only">Beneficiary</dt>
          <dd className="truncate">{charity.name}</dd>
        </div>
      </dl>

      {featured ? (
        <ImpactMeter className="mt-6" raisedCents={raisedCents} goalCents={t.fundraisingGoalCents} currency={t.currency} donorCount={donorCount} />
      ) : (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
          <span className="text-text-secondary">
            {t.status === "settled" ? "Raised" : "Raised so far"}{" "}
            <span className="tabular font-medium text-ember">{formatCents(raisedCents, t.currency)}</span>
            <span className="text-text-tertiary"> of {formatCents(t.fundraisingGoalCents, t.currency)}</span>
          </span>
          {t.status === "live" && liveMatchCount > 0 ? (
            <span className="tabular type-label text-surf">
              {liveMatchCount} on court
            </span>
          ) : null}
        </div>
      )}
    </article>
  );
}
