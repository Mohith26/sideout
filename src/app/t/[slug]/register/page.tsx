import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LucraEntryStep } from "@/components/lucra/LucraEntryStep";
import { LucraGate } from "@/components/lucra/LucraGate";
import { RegistrationSteps } from "@/components/registration/RegistrationSteps";
import { registrationState } from "@/components/registration/state";
import { Container } from "@/components/shell/Container";
import { LiveRefresh } from "@/components/ui/LiveRefresh";
import { findUserTeamInTournament, getTeamDetail } from "@/db/queries/teams";
import { listUserTeams } from "@/db/queries/teams";
import { env } from "@/env";
import { signInHref } from "@/lib/redirects";
import { viewer } from "@/server/auth/viewer";
import { lucraEntryStatus } from "@/server/lucra";
import { requireTournament } from "../_lib";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Register" };

/** While the stub provider still shows a donation as pending, check back at this cadence. */
const PENDING_REFRESH_MS = 15_000;

/**
 * Registration (spec §11.4): the two visually distinct steps for the viewer's
 * team in this event. Anonymous visitors sign in first and come back here.
 * Once the team is registered, step 2 is live: the entry state is read from
 * Lucra's participant list on the server and handed to `LucraEntryStep`
 * inside a `LucraGate`, the only place the SDK is loaded.
 */
export default async function RegisterPage({ params }: PageProps<"/t/[slug]">) {
  const { slug } = await params;
  const summary = await requireTournament(slug);
  const user = await viewer();
  if (!user) redirect(signInHref(`/t/${slug}/register`));
  const { tournament, charity, activeTeams } = summary;

  const team = findUserTeamInTournament(user.id, tournament.id);
  const detail = team ? getTeamDetail(team.id) : null;
  const donation = team ? (listUserTeams(user.id).find((t) => t.team.id === team.id)?.donation ?? null) : null;
  const state = registrationState({
    tournamentStatus: tournament.status,
    team: detail ? { status: detail.status, memberCount: detail.members.length, pendingInvitePhone: detail.invites.find((i) => i.status === "pending")?.phoneE164 ?? null } : null,
    donation: donation ? { status: donation.status, amountCents: donation.amountCents, currency: donation.currency } : null,
    entryDonationCents: tournament.entryDonationCents,
    full: activeTeams >= tournament.maxTeams,
  });

  const entry =
    state.kind === "registered" && detail
      ? await lucraEntryStatus({ tournamentId: tournament.id, teamId: detail.id, roster: detail.members.map((m) => ({ userId: m.userId, displayName: m.displayName })), callerUserId: user.id })
      : null;

  const steps = (
    <RegistrationSteps
      slug={tournament.slug}
      tournamentName={tournament.name}
      charityName={charity.name}
      entryDonationCents={tournament.entryDonationCents}
      currency={tournament.currency}
      state={state}
      teamId={detail?.id ?? null}
      teamName={detail?.name ?? null}
      entry={entry ? <LucraEntryStep slug={tournament.slug} tournamentName={tournament.name} initial={entry} supportHref={env.LUCRA_SUPPORT_URL} /> : null}
    />
  );

  return (
    <Container className="py-6 md:py-8">
      {state.kind === "registered" && state.donation?.status === "pending" ? <LiveRefresh intervalMs={PENDING_REFRESH_MS} /> : null}
      <div className="mx-auto max-w-2xl">
        <h1 className="sr-only">Register for {tournament.name}</h1>
        {detail ? (
          <p className="mb-4 text-text-secondary">
            Registering <span className="font-medium text-text-primary">{detail.name}</span>
            {detail.members.length ? <span className="text-text-tertiary"> · {detail.members.map((m) => m.displayName).join(" & ")}</span> : null}
          </p>
        ) : null}
        {entry ? <LucraGate>{steps}</LucraGate> : steps}
      </div>
    </Container>
  );
}
