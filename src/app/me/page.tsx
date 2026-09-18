import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { InviteCard } from "@/components/profile/InviteCard";
import { SignOutButton } from "@/components/profile/SignOutButton";
import { TeamHistoryCard } from "@/components/profile/TeamHistoryCard";
import { Container } from "@/components/shell/Container";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icons } from "@/components/ui/icons";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { getUserHistory, type TeamHistory } from "@/db/queries/profile";
import { getTeamDetail } from "@/db/queries/teams";
import { listTournamentSummaries } from "@/db/queries/tournaments";
import type { RewardStatus } from "@/db/schema";
import { env } from "@/env";
import { formatCents, ordinal } from "@/lib/format";
import { loadAsync } from "@/lib/load";
import { maskPhone } from "@/lib/phone";
import { signInHref } from "@/lib/redirects";
import { viewer } from "@/server/auth/viewer";
import { getProfile, type Profile } from "@/server/me";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Me" };

const REWARD_STATUS_LABEL: Record<RewardStatus, string> = { projected: "Projected", awarded: "Awarded", claimed: "Claimed" };
const CURRENT_EVENT = new Set(["registration_open", "registration_closed", "live"]);

type RewardRow = Profile["rewards"][number];

const rewardColumns: DataTableColumn<RewardRow>[] = [
  {
    key: "event",
    header: "Event",
    render: (r) => (
      <Link href={`/t/${r.tournamentSlug}/impact`} className="target -my-2.5 flex items-center py-2.5 font-medium text-text-primary hover:text-volt">
        {r.tournamentName}
      </Link>
    ),
  },
  { key: "place", header: "Place", numeric: true, render: (r) => ordinal(r.placement) },
  { key: "team", header: "Team", hideBelowMd: true, render: (r) => <span className="text-text-secondary">{r.teamName}</span> },
  { key: "reward", header: "Reward", render: (r) => <span className="text-text-secondary">{r.description}</span> },
  { key: "value", header: "Value", numeric: true, render: (r) => (r.amountCents === null ? <span className="text-text-tertiary">Item</span> : formatCents(r.amountCents, r.currency ?? "USD")) },
  { key: "status", header: "Status", render: (r) => <span className="text-text-secondary">{REWARD_STATUS_LABEL[r.status]}</span> },
];

/**
 * Profile (spec §11.5): who you are, invites waiting on you, your teams and
 * how each event went, rewards earned, and the responsible-play links.
 *
 * PHASE 4 SLOT — the Lucra identity/verification row and the wallet chip
 * mount directly under the identity card, before "Invites". `profile.lucra`
 * already carries the verification state enum (and nothing else, spec §4.6);
 * `LucraGate` will own launching the identity and wallet flows. Nothing is
 * rendered in that position today rather than a fake status.
 */
export default async function MePage() {
  const loaded = await loadAsync(() => viewer());
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const user = loaded.data;
  if (!user) redirect(signInHref("/me"));

  const profile = getProfile(user);
  const history = getUserHistory(user.id);
  const openEvents = listTournamentSummaries(["registration_open"]).filter((s) => !history.some((h) => h.tournament.id === s.tournament.id && h.team.status !== "disbanded" && h.team.status !== "withdrawn"));
  const inviteFor = (h: TeamHistory) => (h.team.status === "forming" && h.members.length < 2 ? (getTeamDetail(h.team.id)?.invites.find((i) => i.status === "pending") ?? null) : null);
  const current = history.filter((h) => CURRENT_EVENT.has(h.tournament.status) && h.team.status !== "disbanded");
  const past = history.filter((h) => !CURRENT_EVENT.has(h.tournament.status) && h.team.status !== "disbanded");
  const hasInvites = profile.invites.length > 0;
  const readyTeam = current.find((h) => h.team.status === "forming" && h.members.length === 2 && h.tournament.status === "registration_open");

  return (
    <Container className="space-y-10 py-6 md:py-8">
      <section aria-labelledby="identity-heading" className="surface-raised flex flex-wrap items-start justify-between gap-4 rounded-md p-5 md:p-6">
        <div className="min-w-0">
          <h1 id="identity-heading" className="type-display-l">
            {profile.user.displayName}
          </h1>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-text-secondary">
            <div className="flex items-center gap-2">
              <Icons.phone size={16} className="text-text-tertiary" />
              <dt className="sr-only">Phone</dt>
              <dd className="tabular">{profile.user.phoneE164 ? maskPhone(profile.user.phoneE164) : "No phone on file"}</dd>
            </div>
            {profile.user.role === "organizer" ? (
              <div className="flex items-center gap-2">
                <Icons.console size={16} className="text-text-tertiary" />
                <dt className="sr-only">Role</dt>
                <dd>
                  Organizer ·{" "}
                  <Link href="/organizer" className="text-text-primary hover:text-volt">
                    open the console
                  </Link>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <SignOutButton />
      </section>

      {hasInvites ? (
        <section aria-labelledby="invites-heading">
          <SectionHeading id="invites-heading" aside={<span className="tabular">{profile.invites.length}</span>}>
            Invites waiting on you
          </SectionHeading>
          <div className="space-y-3">
            {profile.invites.map((invite, i) => (
              <InviteCard key={invite.invite.id} invite={invite} timeZone={invite.tournament.venueTimezone} primary={i === 0} />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="teams-heading">
        <SectionHeading id="teams-heading">Your teams</SectionHeading>
        {current.length === 0 ? (
          <EmptyState
            icon="users"
            title="No team in an upcoming event"
            body={openEvents.length ? `Registration is open for ${openEvents.map((s) => s.tournament.name).join(", ")}. Create a team and invite your partner by phone.` : "When an event opens registration, create a team here."}
            action={
              openEvents[0] ? (
                <Button variant={hasInvites ? "secondary" : "primary"} href={`/teams/new?t=${openEvents[0].tournament.slug}`}>
                  Create a team
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {current.map((h) => (
              <TeamHistoryCard key={h.team.id} history={h} pendingInvite={inviteFor(h)} primaryAction={!hasInvites && readyTeam?.team.id === h.team.id} />
            ))}
          </div>
        )}
        {current.length > 0 && openEvents.length > 0 ? (
          <p className="mt-3 text-text-secondary">
            Also open:{" "}
            {openEvents.map((s, i) => (
              <span key={s.tournament.id}>
                {i > 0 ? ", " : ""}
                <Link href={`/teams/new?t=${s.tournament.slug}`} className="text-text-primary hover:text-volt">
                  {s.tournament.name}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="history-heading">
        <SectionHeading id="history-heading" aside={<span className="tabular">{past.length} events</span>}>
          Tournament history
        </SectionHeading>
        {past.length === 0 ? (
          <EmptyState icon="trophy" title="Nothing played yet" body="Results, pool finishes and bracket runs from past events collect here." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {past.map((h) => (
              <TeamHistoryCard key={h.team.id} history={h} pendingInvite={null} primaryAction={false} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="rewards-heading">
        <SectionHeading id="rewards-heading" aside={<span className="tabular">{profile.rewards.length}</span>}>
          Rewards earned
        </SectionHeading>
        {profile.rewards.length === 0 ? (
          <EmptyState icon="gift" title="No rewards yet" body="Sponsor-funded rewards are awarded by placement when an event settles. They are separate from donations." />
        ) : (
          <DataTable columns={rewardColumns} rows={profile.rewards} getRowKey={(r) => r.id} caption="Rewards earned by your teams" />
        )}
      </section>

      <section aria-labelledby="responsible-heading" className="surface-inset rounded-md p-5">
        <SectionHeading id="responsible-heading">Responsible play</SectionHeading>
        <p className="max-w-prose text-text-secondary">
          Rewards on Sideout are settled by Lucra. Entry fees are charitable donations and are never staked. If play stops feeling like play, Lucra publishes limits, cooling-off and
          self-exclusion tools alongside its policy.
        </p>
        <a href={env.LUCRA_RESPONSIBLE_GAMING_URL} target="_blank" rel="noreferrer noopener" className="target mt-3 inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt">
          <Icons.shieldCheck size={16} />
          Lucra responsible gaming policy
          <Icons.externalLink size={14} />
        </a>
      </section>
    </Container>
  );
}
