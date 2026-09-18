import type { Charity, Tournament } from "@/db/schema";
import { Flag, Palm, Umbrella, WaveDivider } from "@/components/art";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { Countdown } from "@/components/tournament/Countdown";
import { LiveDot } from "@/components/motion/LiveDot";
import { TabNav } from "@/components/tournament/TabNav";
import { formatDate, formatDateRange } from "@/lib/format";

export interface TournamentHeaderProps {
  tournament: Tournament;
  charity: Charity;
  nowMs: number;
  liveMatchCount: number;
}

/**
 * Sticky event header: name, beneficiary, status, and a countdown or live
 * indicator. Framed by the beach — an umbrella in the corner on a phone, palms
 * on the right from 768px, in a strip the text never runs into — with a
 * wave-edged bottom.
 */
export function TournamentHeader({ tournament: t, charity, nowMs, liveMatchCount }: TournamentHeaderProps) {
  const base = `/t/${t.slug}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/bracket`, label: "Bracket" },
    { href: `${base}/standings`, label: "Standings" },
    { href: `${base}/impact`, label: "Impact" },
  ];
  const upcoming = t.status === "draft" || t.status === "registration_open" || t.status === "registration_closed";
  return (
    <div className="sticky top-0 z-30 bg-bg-raised">
      <div className="relative mx-auto max-w-content px-gutter pt-4">
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-gutter hidden items-end md:flex">
          <Palm height={124} lean={-1} className="-mr-6" />
          <Palm height={96} lean={1} />
        </div>
        <Umbrella height={60} className="pointer-events-none absolute top-1 right-gutter md:hidden" />
        <div className="pr-14 md:pr-52">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
            {t.status === "live" ? (
              <span className="tabular inline-flex items-center gap-2 type-label text-surf">
                <Flag size={18} />
                <LiveDot />
                {liveMatchCount} {liveMatchCount === 1 ? "match" : "matches"} on court
              </span>
            ) : upcoming ? (
              <Countdown targetMs={t.startsAt} initialNowMs={nowMs} />
            ) : (
              <span className="tabular type-label text-text-tertiary">{formatDate(t.startsAt, t.venueTimezone)}</span>
            )}
          </div>
          <h1 className="type-display-l mt-2">{t.name}</h1>
          <p className="mt-1 text-text-secondary">
            Benefiting <span className="text-text-primary">{charity.name}</span>
            <span className="text-text-tertiary"> · {t.venueName}</span>
            <span className="tabular text-text-tertiary"> · {formatDateRange(t.startsAt, t.endsAt, t.venueTimezone)}</span>
          </p>
        </div>
        <div className="relative mt-3">
          <TabNav items={tabs} ariaLabel={`${t.name} sections`} />
        </div>
      </div>
      <WaveDivider fill="base" height={12} line drift={false} className="relative" />
    </div>
  );
}
