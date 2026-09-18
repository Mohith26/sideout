import "server-only";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { donations, teamInvites, teamMembers, teams, tournaments, users, type Donation, type Team, type TeamInvite, type TeamRole, type Tournament } from "@/db/schema";

/**
 * Team-side read models: a team with its roster, a user's teams across
 * events, and pending invites for a phone. Capacity counts (`registered` or
 * `checked_in`) live here too so every caller agrees on what "full" means.
 */

export interface TeamMemberView {
  userId: string;
  displayName: string;
  role: TeamRole;
}

export interface TeamDetail extends Team {
  members: TeamMemberView[];
  invites: TeamInvite[];
}

export function getTeamDetail(teamId: string): TeamDetail | null {
  const db = getDb();
  const team = db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return null;
  const members = db
    .select({ userId: teamMembers.userId, displayName: users.displayName, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .all()
    .sort((x, y) => (x.role === "captain" ? -1 : y.role === "captain" ? 1 : 0));
  const invites = db.select().from(teamInvites).where(eq(teamInvites.teamId, teamId)).orderBy(desc(teamInvites.createdAt)).all();
  return { ...team, members, invites };
}

/** Teams that occupy a slot: registered or checked in. Forming and withdrawn do not. */
export function countActiveTeams(tournamentId: string): number {
  return getDb()
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.tournamentId, tournamentId), inArray(teams.status, ["registered", "checked_in"])))
    .all().length;
}

/** The team a user is on in a tournament, if any (withdrawn teams do not count). */
export function findUserTeamInTournament(userId: string, tournamentId: string): Team | null {
  return (
    getDb()
      .select({ team: teams })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, userId), eq(teams.tournamentId, tournamentId), ne(teams.status, "withdrawn")))
      .get()?.team ?? null
  );
}

export interface UserTeamView {
  team: Team;
  role: TeamRole;
  tournament: Pick<Tournament, "id" | "slug" | "name" | "status" | "startsAt" | "endsAt" | "venueCity" | "venueState" | "venueTimezone">;
  members: TeamMemberView[];
  /** The team's entry donation, if registration has happened. */
  donation: Pick<Donation, "id" | "status" | "amountCents" | "currency" | "createdAt"> | null;
}

export function listUserTeams(userId: string): UserTeamView[] {
  const db = getDb();
  const rows = db
    .select({ team: teams, role: teamMembers.role, tournament: tournaments })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(tournaments, eq(tournaments.id, teams.tournamentId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(desc(tournaments.startsAt))
    .all();
  if (rows.length === 0) return [];
  const teamIds = rows.map((r) => r.team.id);
  const memberRows = db
    .select({ teamId: teamMembers.teamId, userId: teamMembers.userId, displayName: users.displayName, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(inArray(teamMembers.teamId, teamIds))
    .all();
  const donationRows = db.select().from(donations).where(inArray(donations.teamId, teamIds)).orderBy(desc(donations.createdAt)).all();
  return rows.map(({ team, role, tournament }) => {
    const donation = donationRows.find((d) => d.teamId === team.id) ?? null;
    return {
      team,
      role,
      tournament: {
        id: tournament.id,
        slug: tournament.slug,
        name: tournament.name,
        status: tournament.status,
        startsAt: tournament.startsAt,
        endsAt: tournament.endsAt,
        venueCity: tournament.venueCity,
        venueState: tournament.venueState,
        venueTimezone: tournament.venueTimezone,
      },
      members: memberRows
        .filter((m) => m.teamId === team.id)
        .map(({ userId: id, displayName, role: r }) => ({ userId: id, displayName, role: r }))
        .sort((x, y) => (x.role === "captain" ? -1 : y.role === "captain" ? 1 : 0)),
      donation: donation ? { id: donation.id, status: donation.status, amountCents: donation.amountCents, currency: donation.currency, createdAt: donation.createdAt } : null,
    };
  });
}

export interface PendingInviteView {
  invite: TeamInvite;
  team: Pick<Team, "id" | "name" | "status">;
  tournament: Pick<Tournament, "id" | "slug" | "name" | "status" | "startsAt">;
  invitedBy: { userId: string; displayName: string };
}

export function listPendingInvitesForPhone(phoneE164: string): PendingInviteView[] {
  return getDb()
    .select({ invite: teamInvites, team: teams, tournament: tournaments, inviter: users })
    .from(teamInvites)
    .innerJoin(teams, eq(teams.id, teamInvites.teamId))
    .innerJoin(tournaments, eq(tournaments.id, teams.tournamentId))
    .innerJoin(users, eq(users.id, teamInvites.invitedByUserId))
    .where(and(eq(teamInvites.phoneE164, phoneE164), eq(teamInvites.status, "pending")))
    .orderBy(desc(teamInvites.createdAt))
    .all()
    .map(({ invite, team, tournament, inviter }) => ({
      invite,
      team: { id: team.id, name: team.name, status: team.status },
      tournament: { id: tournament.id, slug: tournament.slug, name: tournament.name, status: tournament.status, startsAt: tournament.startsAt },
      invitedBy: { userId: inviter.id, displayName: inviter.displayName },
    }));
}
