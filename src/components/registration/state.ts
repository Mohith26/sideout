import type { DonationStatus, TeamStatus, TournamentStatus } from "@/db/schema";

/**
 * Where a team is in registration (spec §11.4), derived from rows so the page,
 * the tests and the e2e flow agree. Two steps: the charitable donation (step 1,
 * this phase) and Lucra tournament entry (step 2, phase 4, never faked).
 */
export interface RegistrationInput {
  tournamentStatus: TournamentStatus;
  /** Null when the viewer has no live team in the event. */
  team: { status: TeamStatus; memberCount: number; pendingInvitePhone: string | null } | null;
  donation: { status: DonationStatus; amountCents: number; currency: string } | null;
  /** The event's entry donation; 0 means entry is free and step 1 records nothing. */
  entryDonationCents: number;
  /** Event capacity already reached by other teams. */
  full: boolean;
}

export type RegistrationState =
  | { kind: "no_team" }
  | { kind: "closed"; tournamentStatus: TournamentStatus }
  | { kind: "waiting_partner"; invitePhone: string | null }
  | { kind: "ready"; full: boolean }
  | { kind: "registered"; donation: RegistrationInput["donation"] };

export function registrationState(input: RegistrationInput): RegistrationState {
  const { team } = input;
  if (!team || team.status === "withdrawn" || team.status === "disbanded") {
    return input.tournamentStatus === "registration_open" ? { kind: "no_team" } : { kind: "closed", tournamentStatus: input.tournamentStatus };
  }
  if (team.status === "registered" || team.status === "checked_in") return { kind: "registered", donation: input.donation };
  // forming
  if (input.tournamentStatus !== "registration_open") return { kind: "closed", tournamentStatus: input.tournamentStatus };
  if (team.memberCount < 2) return { kind: "waiting_partner", invitePhone: team.pendingInvitePhone };
  return { kind: "ready", full: input.full };
}

/** Step 1's visual state: what the donation card says. */
export type DonationStepState = "locked" | "due" | "processing" | "received" | "refunded" | "failed" | "free";

export function donationStep(state: RegistrationState, entryDonationCents: number): DonationStepState {
  if (state.kind === "ready") return entryDonationCents > 0 ? "due" : "free";
  if (state.kind === "registered") {
    if (!state.donation) return entryDonationCents > 0 ? "locked" : "free";
    switch (state.donation.status) {
      case "pending":
        return "processing";
      case "succeeded":
        return "received";
      case "refunded":
        return "refunded";
      case "failed":
        return "failed";
    }
  }
  return "locked";
}
