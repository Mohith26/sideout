import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CreateTeamForm } from "@/components/registration/CreateTeamForm";
import { Container } from "@/components/shell/Container";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { StatusPill, TOURNAMENT_STATUS_PILL } from "@/components/ui/StatusPill";
import { findUserTeamInTournament } from "@/db/queries/teams";
import { getTournamentSummaryBySlug, isPublished } from "@/db/queries/tournaments";
import { formatCents, formatDate } from "@/lib/format";
import { loadAsync } from "@/lib/load";
import { signInHref } from "@/lib/redirects";
import { viewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New team" };

/** Create a team for an open event and invite a partner by phone (spec §11.4). */
export default async function NewTeamPage({ searchParams }: PageProps<"/teams/new">) {
  const { t } = await searchParams;
  const slug = Array.isArray(t) ? t[0] : t;
  if (!slug) notFound();
  const loaded = await loadAsync(async () => ({ summary: getTournamentSummaryBySlug(slug), user: await viewer() }));
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  const { summary, user } = loaded.data;
  if (!summary || !isPublished(summary.tournament.status)) notFound();
  if (!user) redirect(signInHref(`/teams/new?t=${encodeURIComponent(slug)}`));
  const { tournament, charity, activeTeams } = summary;
  const existing = findUserTeamInTournament(user.id, tournament.id);

  return (
    <Container className="py-6 md:py-8">
      <div className="mx-auto max-w-md space-y-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill spec={TOURNAMENT_STATUS_PILL[tournament.status]} size="sm" />
            <span className="tabular type-label text-text-tertiary">{formatDate(tournament.startsAt, tournament.venueTimezone)}</span>
          </div>
          <h1 className="type-display-l mt-2">New team</h1>
          <p className="mt-2 text-text-secondary">
            <Link href={`/t/${tournament.slug}`} className="link-inline text-text-primary hover:text-volt">
              {tournament.name}
            </Link>{" "}
            · {activeTeams} of {tournament.maxTeams} teams in · entry is a {formatCents(tournament.entryDonationCents, tournament.currency)} donation to {charity.name}, collected when you register.
          </p>
        </div>

        {tournament.status !== "registration_open" ? (
          <EmptyState
            level={2}
            icon="ban"
            title="Registration is not open"
            body={`${tournament.name} is ${TOURNAMENT_STATUS_PILL[tournament.status].label.toLowerCase()}, so no new teams can be created.`}
            action={
              <Button variant="secondary" href={`/t/${tournament.slug}`}>
                Back to the event
              </Button>
            }
          />
        ) : existing && existing.status !== "forming" ? (
          <EmptyState
            level={2}
            icon="users"
            title={`You are already on "${existing.name}"`}
            body="A player holds one entry per event."
            action={
              <Button variant="secondary" href="/me">
                See your teams
              </Button>
            }
          />
        ) : (
          <>
            {existing ? (
              <Notice tone="info" title={`You already started "${existing.name}"`}>
                It is still waiting for a partner. Creating a new team here replaces it and cancels that invite.
              </Notice>
            ) : null}
            {activeTeams >= tournament.maxTeams ? (
              <Notice tone="attention" title="The event is full">
                You can still form a team; registering will only succeed if a spot opens up.
              </Notice>
            ) : null}
            <CreateTeamForm slug={tournament.slug} tournamentName={tournament.name} />
          </>
        )}
      </div>
    </Container>
  );
}
