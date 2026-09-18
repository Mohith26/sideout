import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { findUserTeamInTournament, getTeamDetail, type TeamDetail } from "@/db/queries/teams";
import { teamInvites, teamMembers, teams, users, type Team, type User } from "@/db/schema";
import { checkTeamRoster } from "@/domain/team";
import type { TransitionActor } from "@/domain/transitions";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { phoneSchema } from "@/lib/phone";
import { uuidv7 } from "@/lib/uuid";
import { writeAudit, type Tx } from "@/server/audit";
import { getSmsSender } from "@/server/auth/sms";
import { requireTournamentBySlug } from "@/server/tournaments";

/**
 * Teams (spec §6.1, §11.4): a captain creates a team for an open event and
 * invites a partner by phone; the partner signs in with that phone and joins.
 * The two-member rule from `@/domain/team` is enforced on the roster that
 * results, and a player holds at most one live team per event.
 *
 * A player's own `forming` team never traps them: creating another team, or
 * accepting an invite to one, disbands it (pending invite revoked, every member
 * released, both audited) in the same transaction. Only a team that has
 * registered blocks a second one.
 */

export const createTeamSchema = z
  .object({
    tournamentSlug: z.string().trim().min(1),
    name: z.string().trim().min(2).max(40),
    partnerPhone: phoneSchema,
  })
  .strict();
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

/** The caller's current team in the event: a forming one is superseded by what they do next, anything registered blocks it. */
function supersedable(existing: Team | null): { superseded: Team | null } {
  if (existing && existing.status !== "forming") {
    throw new ApiFailure("conflict", `You are already on "${existing.name}" in this event.`, { teamId: existing.id });
  }
  return { superseded: existing };
}

/** Disband a forming team the caller is leaving behind: pending invite revoked, every member released, both audited. */
function disbandTeam(tx: Tx, team: Team, actor: TransitionActor, supersededBy: string, now: number): void {
  const released = tx.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).all().map((m) => m.userId);
  const revoked = tx
    .update(teamInvites)
    .set({ status: "revoked", respondedAt: now })
    .where(and(eq(teamInvites.teamId, team.id), eq(teamInvites.status, "pending")))
    .run();
  tx.update(teams).set({ status: "disbanded" }).where(eq(teams.id, team.id)).run();
  if (revoked.changes > 0) {
    writeAudit(tx, { actor, action: "team.invite_revoked", subjectType: "team", subjectId: team.id, detail: { reason: "superseded", supersededBy }, at: now });
  }
  writeAudit(tx, { actor, action: "team.disbanded", subjectType: "team", subjectId: team.id, detail: { from: "forming", to: "disbanded", supersededBy, released }, at: now });
}

export function createTeam(input: CreateTeamInput, captain: User, clock: Clock = systemClock): TeamDetail {
  const db = getDb();
  const { tournament } = requireTournamentBySlug(input.tournamentSlug);
  if (tournament.status !== "registration_open") {
    throw new ApiFailure("conflict", `Registration is not open for ${tournament.name}; it is ${tournament.status}.`);
  }
  if (captain.phoneE164 && captain.phoneE164 === input.partnerPhone) throw new ApiFailure("bad_request", "Invite someone other than yourself.");
  const { superseded } = supersedable(findUserTeamInTournament(captain.id, tournament.id));
  const partner = db.select().from(users).where(eq(users.phoneE164, input.partnerPhone)).get();
  const partnerTeam = partner ? findUserTeamInTournament(partner.id, tournament.id) : null;
  if (partnerTeam && partnerTeam.status !== "forming") {
    throw new ApiFailure("conflict", "That player is already on a team in this event.");
  }

  const now = clock.now();
  const teamId = uuidv7();
  db.transaction((tx) => {
    const actor = { kind: "player" as const, userId: captain.id };
    if (superseded) disbandTeam(tx, superseded, actor, teamId, now);
    tx.insert(teams).values({ id: teamId, tournamentId: tournament.id, name: input.name, seed: null, status: "forming", createdAt: now }).run();
    tx.insert(teamMembers).values({ id: uuidv7(), teamId, userId: captain.id, role: "captain" }).run();
    tx.insert(teamInvites)
      .values({ id: uuidv7(), teamId, invitedByUserId: captain.id, phoneE164: input.partnerPhone, status: "pending", acceptedByUserId: null, createdAt: now, respondedAt: null })
      .run();
    writeAudit(tx, { actor, action: "team.created", subjectType: "team", subjectId: teamId, detail: { tournamentId: tournament.id, name: input.name, supersedes: superseded?.id ?? null }, at: now });
    writeAudit(tx, { actor, action: "team.invite_sent", subjectType: "team", subjectId: teamId, detail: { knownPlayer: Boolean(partner) }, at: now });
  });
  // Best-effort: the invite also waits under the partner's profile, so no sender is not a failure.
  getSmsSender()?.send(input.partnerPhone, `${captain.displayName} invited you to play ${tournament.name} as "${input.name}" on Sideout. Sign in with this number to accept.`);

  const detail = getTeamDetail(teamId);
  if (!detail) throw new ApiFailure("internal", "Team was not created.");
  return detail;
}

export function joinTeam(teamId: string, user: User, clock: Clock = systemClock): TeamDetail {
  const db = getDb();
  const team = db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw new ApiFailure("not_found", "No team with that id.");
  if (!user.phoneE164) throw new ApiFailure("forbidden", "Add a phone number to your account to accept invites.");
  const invite = db
    .select()
    .from(teamInvites)
    .where(and(eq(teamInvites.teamId, teamId), eq(teamInvites.phoneE164, user.phoneE164), eq(teamInvites.status, "pending")))
    .get();
  if (!invite) throw new ApiFailure("forbidden", "There is no pending invite for your phone number on this team.");
  if (team.status !== "forming") throw new ApiFailure("conflict", `This team is ${team.status} and no longer accepting a partner.`);
  const existing = findUserTeamInTournament(user.id, team.tournamentId);
  if (existing?.id === teamId) throw new ApiFailure("conflict", `You are already on "${existing.name}".`, { teamId });
  const { superseded } = supersedable(existing);

  const roster = db.select({ userId: teamMembers.userId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.teamId, teamId)).all();
  const verdict = checkTeamRoster([...roster, { userId: user.id, role: "player" }]);
  if (!verdict.ok) throw new ApiFailure("conflict", verdict.reason);

  const now = clock.now();
  db.transaction((tx) => {
    const actor = { kind: "player" as const, userId: user.id };
    if (superseded) disbandTeam(tx, superseded, actor, teamId, now);
    tx.insert(teamMembers).values({ id: uuidv7(), teamId, userId: user.id, role: "player" }).run();
    tx.update(teamInvites).set({ status: "accepted", acceptedByUserId: user.id, respondedAt: now }).where(eq(teamInvites.id, invite.id)).run();
    writeAudit(tx, { actor, action: "team.member_joined", subjectType: "team", subjectId: teamId, detail: { inviteId: invite.id, supersedes: superseded?.id ?? null }, at: now });
  });
  const detail = getTeamDetail(teamId);
  if (!detail) throw new ApiFailure("internal", "Team disappeared.");
  return detail;
}
