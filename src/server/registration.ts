import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { countActiveTeams, getTeamDetail, type TeamDetail } from "@/db/queries/teams";
import { donations, teamMembers, teams, type Donation, type User } from "@/db/schema";
import { checkTeamRoster } from "@/domain/team";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { uuidv7 } from "@/lib/uuid";
import { writeAudit } from "@/server/audit";
import { getDonationProvider, settleDueDonations } from "@/server/donations/stub-provider";
import { requireTournamentBySlug } from "@/server/tournaments";

/**
 * Registration (spec §11.4): a complete team enters an open event. Two
 * visually and structurally distinct steps — the charitable donation intent
 * (this module, through the donation provider seam) and the Lucra tournament
 * entry (phase 4, `lucraEntryHook` below). The two never share a table or a
 * foreign key (spec §4.3).
 */

export const registerSchema = z.object({ teamId: z.string().min(1) }).strict();

export interface LucraEntryOutcome {
  /** Phase 4 replaces this with the real SDK/REST entry; nothing here pretends otherwise. */
  state: "not_available";
  reason: string;
}

/**
 * PHASE 4 HOOK — Lucra tournament entry. Called after the donation intent is
 * recorded so the two steps stay ordered and separate. Today it reports that
 * the step is not built; it never fakes an enrolment.
 */
export function lucraEntryHook(_input: { tournamentId: string; teamId: string; userIds: string[] }): LucraEntryOutcome {
  return { state: "not_available", reason: "Lucra tournament entry arrives in phase 4." };
}

export interface RegistrationResult {
  team: TeamDetail;
  /** Null for an event with no entry donation. */
  donation: Donation | null;
  lucraEntry: LucraEntryOutcome;
}

export function registerTeam(slug: string, teamId: string, user: User, clock: Clock = systemClock): RegistrationResult {
  const db = getDb();
  const now = clock.now();
  settleDueDonations(db, now);

  const { tournament, activeTeams } = requireTournamentBySlug(slug);
  const team = db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team || team.tournamentId !== tournament.id) throw new ApiFailure("not_found", "No such team in this event.");
  const roster = db.select({ userId: teamMembers.userId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.teamId, teamId)).all();
  if (!roster.some((m) => m.userId === user.id)) throw new ApiFailure("forbidden", "Only a member of the team can register it.");
  if (team.status !== "forming") throw new ApiFailure("conflict", `This team is already ${team.status}.`);
  const verdict = checkTeamRoster(roster);
  if (!verdict.ok) throw new ApiFailure("conflict", `The team is not complete: ${verdict.reason}`);
  if (tournament.status !== "registration_open") {
    throw new ApiFailure("conflict", `Registration is not open for ${tournament.name}; it is ${tournament.status}.`);
  }
  if (now >= tournament.startsAt) throw new ApiFailure("conflict", "Registration closed when the event started.");
  // Re-count inside the request rather than trusting the summary, and once more inside the transaction.
  if (activeTeams >= tournament.maxTeams) throw new ApiFailure("conflict", `${tournament.name} is full (${tournament.maxTeams} teams).`);

  const intent = getDonationProvider().createIntent({ amountCents: tournament.entryDonationCents, currency: tournament.currency });
  const donationId = uuidv7();
  db.transaction((tx) => {
    if (countActiveTeams(tournament.id) >= tournament.maxTeams) throw new ApiFailure("conflict", `${tournament.name} is full (${tournament.maxTeams} teams).`);
    tx.update(teams).set({ status: "registered" }).where(eq(teams.id, teamId)).run();
    if (tournament.entryDonationCents > 0) {
      tx.insert(donations)
        .values({
          id: donationId,
          tournamentId: tournament.id,
          teamId,
          userId: user.id,
          amountCents: tournament.entryDonationCents,
          currency: tournament.currency,
          provider: intent.provider,
          providerRef: intent.providerRef,
          status: intent.status,
          createdAt: now,
        })
        .run();
    }
    const actor = { kind: "player" as const, userId: user.id };
    writeAudit(tx, { actor, action: "team.registered", subjectType: "team", subjectId: teamId, detail: { tournamentId: tournament.id, from: "forming", to: "registered" }, at: now });
    if (tournament.entryDonationCents > 0) {
      writeAudit(tx, {
        actor,
        action: "donation.created",
        subjectType: "donation",
        subjectId: donationId,
        detail: { tournamentId: tournament.id, teamId, amountCents: tournament.entryDonationCents, provider: intent.provider },
        at: now,
      });
    }
  });

  const lucraEntry = lucraEntryHook({ tournamentId: tournament.id, teamId, userIds: roster.map((m) => m.userId) });
  const detail = getTeamDetail(teamId);
  const donation = db.select().from(donations).where(eq(donations.id, donationId)).get() ?? null;
  if (!detail) throw new ApiFailure("internal", "Team disappeared.");
  return {
    team: detail,
    donation,
    lucraEntry,
  };
}
