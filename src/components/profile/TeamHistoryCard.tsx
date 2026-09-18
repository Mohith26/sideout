import Link from "next/link";
import { TeamAvatarPair } from "@/components/tournament/TeamAvatarPair";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { DONATION_STATUS_PILL, StatusPill, TEAM_STATUS_PILL, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import type { TeamHistory } from "@/db/queries/profile";
import type { TeamInvite } from "@/db/schema";
import { formatCents, formatDate, ordinal } from "@/lib/format";
import { maskPhone } from "@/lib/phone";
import { cx } from "@/lib/cx";

/**
 * One team in one event, as the profile shows it: where it stands now
 * (forming, registered, withdrawn), its entry donation, and once play starts
 * the record, pool finish, bracket run and every match, all read off rows.
 */
export function TeamHistoryCard({ history: h, pendingInvite, primaryAction }: { history: TeamHistory; pendingInvite: TeamInvite | null; primaryAction: boolean }) {
  const tz = h.tournament.venueTimezone;
  const open = h.tournament.status === "registration_open";
  const complete = h.members.length === 2;
  const registerHref = `/t/${h.tournament.slug}/register`;
  const played = h.played > 0 || h.bracketRoundReached !== null;

  return (
    <article className="surface-raised flex min-w-0 flex-col gap-4 rounded-md p-4 md:p-5" aria-label={`${h.team.name} at ${h.tournament.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/t/${h.tournament.slug}`} className="target inline-flex min-w-0 items-center font-medium text-text-primary hover:text-volt">
          <span className="truncate">{h.tournament.name}</span>
        </Link>
        <span className="flex items-center gap-2">
          <span className="tabular type-label text-text-tertiary">{formatDate(h.tournament.startsAt, tz)}</span>
          <StatusPill spec={TOURNAMENT_STATUS_PILL[h.tournament.status]} size="sm" />
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeamAvatarPair members={h.members} teamName={h.team.name} />
        <StatusPill spec={TEAM_STATUS_PILL[h.team.status]} size="sm" />
      </div>

      {h.team.status === "forming" ? (
        complete ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-text-secondary">Both players are in. {open ? "Register the team to enter the event." : "Registration is closed, so the team cannot enter."}</p>
            {open ? (
              <Button variant={primaryAction ? "primary" : "secondary"} href={registerHref}>
                Register
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="flex items-start gap-2 text-text-secondary">
            <Icons.hourglass size={16} className="mt-1 shrink-0 text-text-tertiary" />
            <span>
              {pendingInvite ? (
                <>
                  Invite sent to <span className="tabular text-text-primary">{maskPhone(pendingInvite.phoneE164)}</span>. They accept it by signing in with that number.
                </>
              ) : (
                "Waiting for a partner."
              )}
            </span>
          </p>
        )
      ) : null}

      {h.donation ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
          <span className="text-text-secondary">
            Entry donation <span className="tabular font-medium text-ember">{formatCents(h.donation.amountCents, h.donation.currency)}</span>
          </span>
          <span className="flex items-center gap-2">
            <StatusPill spec={DONATION_STATUS_PILL[h.donation.status]} size="sm" />
            {h.tournament.status === "registration_open" ? (
              <Link href={registerHref} className="target inline-flex items-center rounded-sm px-2 type-label text-text-secondary hover:text-text-primary">
                Details
              </Link>
            ) : null}
          </span>
        </div>
      ) : null}

      {played ? (
        <>
          <dl className="grid grid-cols-3 gap-2 border-t border-border-subtle pt-3">
            <div>
              <dt className="type-label text-text-tertiary">Record</dt>
              <dd className="tabular font-medium text-text-primary">{`${h.wins}–${h.losses}`}</dd>
            </div>
            <div>
              <dt className="type-label text-text-tertiary">Pool</dt>
              <dd className="tabular font-medium text-text-primary">{h.poolLabel ? `${h.poolRank !== null ? `${ordinal(h.poolRank)} in ` : ""}${h.poolLabel}` : "—"}</dd>
            </div>
            <div>
              <dt className="type-label text-text-tertiary">Bracket</dt>
              <dd className={cx("font-medium", h.champion ? "text-surf" : "text-text-primary")}>{h.champion ? "Champions" : (h.bracketRoundReached ?? "—")}</dd>
            </div>
          </dl>
          <details className="group border-t border-border-subtle pt-3">
            <summary className="target -my-2 flex cursor-pointer list-none items-center justify-between type-label text-text-secondary hover:text-text-primary">
              <span>{`Matches · ${h.matches.length}`}</span>
              <Icons.chevronDown size={16} className="transition-transform duration-(--d-micro) group-open:rotate-180" />
            </summary>
            <ol className="mt-2 divide-y divide-border-subtle">
              {h.matches.map((m) => (
                <li key={m.matchId}>
                  <Link href={`/m/${m.matchId}`} className="flex min-h-11 items-center justify-between gap-3 py-1.5 hover:text-text-primary">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-text-primary">{m.status === "bye" ? "Bye" : `vs ${m.opponentName ?? "TBD"}`}</span>
                      <span className="block type-label text-text-tertiary">{m.roundLabel}</span>
                    </span>
                    <span className="tabular shrink-0 text-end type-mono-stat text-text-secondary">
                      {m.status === "final" && m.sets.length ? m.sets.map((s) => `${s.mine}–${s.theirs}`).join(" ") : m.status === "forfeited" ? "Forfeit" : m.status === "bye" ? "" : m.status.replace("_", " ")}
                    </span>
                    <span className={cx("w-5 shrink-0 text-end type-label", m.won === true ? "text-surf" : m.won === false ? "text-text-tertiary" : "text-text-tertiary")}>
                      {m.won === null ? "" : m.won ? "W" : "L"}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : null}
    </article>
  );
}
