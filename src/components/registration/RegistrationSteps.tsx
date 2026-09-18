import Link from "next/link";
import type { ReactNode } from "react";
import { RegisterButton } from "@/components/registration/RegisterButton";
import { donationStep, type RegistrationState } from "@/components/registration/state";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { DONATION_STATUS_PILL, StatusPill } from "@/components/ui/StatusPill";
import { formatCents } from "@/lib/format";
import { maskPhone } from "@/lib/phone";
import { cx } from "@/lib/cx";

/**
 * The two registration steps (spec §11.4), deliberately unalike so a donation
 * is never mistaken for a wager:
 *
 * 1. Charitable donation — the ember accent, the beneficiary's name, and copy
 *    that says "donation". The stub provider's pending → received state is
 *    shown as it is.
 * 2. Tournament entry — a neutral card that, once the team is registered,
 *    holds `LucraEntryStep` (spec §11.4, phase 4b): Lucra's own sign-in and
 *    the SDK's join, confirmed by reading Lucra's participant list back.
 *    Before registration it is locked and says so.
 */
export interface RegistrationStepsProps {
  slug: string;
  tournamentName: string;
  charityName: string;
  entryDonationCents: number;
  currency: string;
  state: RegistrationState;
  teamId: string | null;
  teamName: string | null;
  /** Step 2's live content once the team is registered (`LucraEntryStep`), else null. */
  entry?: ReactNode;
}

function StepCard({ number, title, tone, status, children, className }: { number: number; title: string; tone: "ember" | "neutral"; status: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`step-${number}-heading`} className={cx("rounded-md", tone === "ember" ? "surface-raised border-t-2 border-t-ember" : "surface-inset", className)}>
      <div className="flex items-start gap-4 p-4 md:p-5">
        <span
          aria-hidden="true"
          className={cx("tabular flex size-9 shrink-0 items-center justify-center rounded-full type-label", tone === "ember" ? "bg-ember/10 text-ember" : "bg-bg-overlay text-text-tertiary")}
        >
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={`step-${number}-heading`} className="type-subheading">
              <span className="sr-only">Step {number}: </span>
              {title}
            </h3>
            {status}
          </div>
          <div className="mt-3 space-y-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function RegistrationSteps({ slug, tournamentName, charityName, entryDonationCents, currency, state, teamId, teamName, entry = null }: RegistrationStepsProps) {
  const step1 = donationStep(state, entryDonationCents);
  const amount = formatCents(entryDonationCents, currency);
  const donation = state.kind === "registered" ? state.donation : null;

  return (
    <div className="space-y-4">
      <StepCard
        number={1}
        title="Charitable donation"
        tone="ember"
        status={donation ? <StatusPill spec={DONATION_STATUS_PILL[donation.status]} size="sm" /> : step1 === "free" ? <span className="type-label text-text-tertiary">No entry fee</span> : null}
      >
        <p className="text-text-secondary">
          Entry to {tournamentName} is a <span className="tabular font-medium text-ember">{amount}</span> donation to <span className="text-text-primary">{charityName}</span>. It goes to the
          beneficiary, it is not a wager, and it is not prize money; prizes are sponsor-funded and kept on a separate ledger.
        </p>

        {state.kind === "no_team" ? (
          <Notice tone="info" title="Create a team first">
            Registration is per team of two. Name the team and invite your partner by phone; come back here once they have accepted.
          </Notice>
        ) : null}
        {state.kind === "waiting_partner" ? (
          <Notice tone="info" title="Waiting for your partner">
            {state.invitePhone ? (
              <>
                The invite went to <span className="tabular text-text-primary">{maskPhone(state.invitePhone)}</span>. When they sign in with that number and accept, this step unlocks.
              </>
            ) : (
              "This step unlocks once both players are on the team."
            )}
          </Notice>
        ) : null}
        {state.kind === "closed" ? (
          <Notice tone="attention" title="Registration is closed">
            {`${tournamentName} is no longer taking entries.`}
          </Notice>
        ) : null}
        {state.kind === "ready" && state.full ? (
          <Notice tone="attention" title="The event is full">
            Every spot is taken right now. Registering will only succeed if one opens.
          </Notice>
        ) : null}
        {step1 === "processing" ? (
          <Notice tone="info" title="Your donation is being processed">
            The provider has accepted it and will confirm shortly; this page checks back on its own. Your spot is held.
          </Notice>
        ) : null}
        {step1 === "received" ? (
          <Notice tone="success" title="Donation received">
            {donation ? `${formatCents(donation.amountCents, donation.currency)} went to ${charityName}. Thank you.` : null}
          </Notice>
        ) : null}
        {step1 === "failed" ? (
          <Notice tone="error" title="The donation did not go through">
            Contact the organizer to sort out the entry.
          </Notice>
        ) : null}

        {state.kind === "ready" && teamId ? (
          <RegisterButton slug={slug} teamId={teamId} label={entryDonationCents > 0 ? `Donate ${amount} and register ${teamName ?? "the team"}` : `Register ${teamName ?? "the team"}`} />
        ) : null}
        {state.kind === "no_team" ? (
          <Button variant="primary" size="lg" className="w-full" href={`/teams/new?t=${slug}`}>
            Create a team
          </Button>
        ) : null}
      </StepCard>

      <StepCard
        number={2}
        title="Enter the tournament with Lucra"
        tone="neutral"
        status={
          entry ? (
            <span className="inline-flex items-center gap-1.5 type-label text-text-secondary">
              <Icons.shieldCheck size={14} />
              Run by Lucra
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 type-label text-text-tertiary">
              <Icons.lock size={14} />
              Opens after step 1
            </span>
          )
        }
      >
        {entry ?? (
          <p className="text-text-secondary">
            Entering the competition is a separate step run by Lucra, who host the tournament, its rewards and its settlement. It unlocks once the team is registered; your donation above is not affected by it and is never staked.
          </p>
        )}
      </StepCard>

      <p className="text-text-secondary">
        <Link href="/me" className="link-inline text-text-primary hover:text-volt">
          Your teams
        </Link>{" "}
        shows every event you are in and the state of each entry.
      </p>
    </div>
  );
}
