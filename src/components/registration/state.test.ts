import { describe, expect, it } from "vitest";
import { donationStep, registrationState, type RegistrationInput } from "@/components/registration/state";

const base: RegistrationInput = {
  tournamentStatus: "registration_open",
  team: null,
  donation: null,
  entryDonationCents: 7500,
  full: false,
};

describe("registrationState", () => {
  it("walks the forming team from invite to ready to registered", () => {
    expect(registrationState(base)).toEqual({ kind: "no_team" });
    expect(registrationState({ ...base, team: { status: "forming", memberCount: 1, pendingInvitePhone: "+15550100100" } })).toEqual({ kind: "waiting_partner", invitePhone: "+15550100100" });
    expect(registrationState({ ...base, team: { status: "forming", memberCount: 2, pendingInvitePhone: null } })).toEqual({ kind: "ready", full: false });
    expect(registrationState({ ...base, full: true, team: { status: "forming", memberCount: 2, pendingInvitePhone: null } })).toEqual({ kind: "ready", full: true });
    const donation = { status: "pending" as const, amountCents: 7500, currency: "USD" };
    expect(registrationState({ ...base, team: { status: "registered", memberCount: 2, pendingInvitePhone: null }, donation })).toEqual({ kind: "registered", donation, checkedIn: false });
    expect(registrationState({ ...base, team: { status: "checked_in", memberCount: 2, pendingInvitePhone: null }, donation })).toEqual({ kind: "registered", donation, checkedIn: true });
    expect(registrationState({ ...base, team: { status: "withdrawn", memberCount: 2, pendingInvitePhone: null }, donation: { ...donation, status: "refunded" } })).toEqual({
      kind: "withdrawn",
      donation: { ...donation, status: "refunded" },
    });
  });

  it("closes the door once registration is not open, but keeps showing a registered team its state", () => {
    expect(registrationState({ ...base, tournamentStatus: "live" })).toEqual({ kind: "closed", tournamentStatus: "live" });
    expect(registrationState({ ...base, tournamentStatus: "registration_closed", team: { status: "forming", memberCount: 2, pendingInvitePhone: null } })).toEqual({ kind: "closed", tournamentStatus: "registration_closed" });
    expect(registrationState({ ...base, tournamentStatus: "live", team: { status: "disbanded", memberCount: 1, pendingInvitePhone: null } })).toEqual({ kind: "closed", tournamentStatus: "live" });
    const donation = { status: "succeeded" as const, amountCents: 7500, currency: "USD" };
    expect(registrationState({ ...base, tournamentStatus: "live", team: { status: "checked_in", memberCount: 2, pendingInvitePhone: null }, donation })).toEqual({ kind: "registered", donation, checkedIn: true });
  });

  it("describes the donation step honestly for every provider state", () => {
    expect(donationStep({ kind: "no_team" }, 7500)).toBe("locked");
    expect(donationStep({ kind: "waiting_partner", invitePhone: null }, 7500)).toBe("locked");
    expect(donationStep({ kind: "ready", full: false }, 7500)).toBe("due");
    expect(donationStep({ kind: "ready", full: false }, 0)).toBe("free");
    const d = (status: "pending" | "succeeded" | "refunded" | "failed") => ({ kind: "registered" as const, donation: { status, amountCents: 7500, currency: "USD" }, checkedIn: false });
    expect(donationStep(d("pending"), 7500)).toBe("processing");
    expect(donationStep(d("succeeded"), 7500)).toBe("received");
    expect(donationStep(d("refunded"), 7500)).toBe("refunded");
    expect(donationStep(d("failed"), 7500)).toBe("failed");
    expect(donationStep({ kind: "registered", donation: null, checkedIn: false }, 0)).toBe("free");
    expect(donationStep({ kind: "registered", donation: null, checkedIn: false }, 7500)).toBe("locked");
  });
});
