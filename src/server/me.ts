import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { listPendingInvitesForPhone, listUserTeams, type PendingInviteView, type UserTeamView } from "@/db/queries/teams";
import { lucraLinks, rewards, tournaments, type Reward, type User, type VerificationState } from "@/db/schema";
import { systemClock, type Clock } from "@/lib/clock";
import { settleDueDonations } from "@/server/donations/stub-provider";

/**
 * `GET /api/me`: the signed-in user's profile, Lucra link state, teams with
 * their events (the tournament history), pending invites for their phone, and
 * rewards earned by their teams. Only the verification *state* is ever stored
 * or shown (spec §4.6).
 */

export interface Profile {
  user: Pick<User, "id" | "displayName" | "phoneE164" | "email" | "avatarUrl" | "role" | "createdAt">;
  lucra: { verificationState: VerificationState; linkedAt: number | null; lastSyncedAt: number | null } | null;
  teams: UserTeamView[];
  invites: PendingInviteView[];
  rewards: Array<Reward & { tournamentSlug: string; tournamentName: string; teamName: string }>;
}

export function getProfile(user: User, clock: Clock = systemClock): Profile {
  const db = getDb();
  settleDueDonations(db, clock.now());
  const link = db.select().from(lucraLinks).where(eq(lucraLinks.userId, user.id)).get();
  const teams = listUserTeams(user.id);
  const teamIds = teams.map((t) => t.team.id);
  const rewardRows = teamIds.length
    ? db
        .select({ reward: rewards, tournamentSlug: tournaments.slug, tournamentName: tournaments.name })
        .from(rewards)
        .innerJoin(tournaments, eq(tournaments.id, rewards.tournamentId))
        .where(inArray(rewards.teamId, teamIds))
        .orderBy(asc(rewards.placement))
        .all()
    : [];
  return {
    user: {
      id: user.id,
      displayName: user.displayName,
      phoneE164: user.phoneE164,
      email: user.email,
      avatarUrl: user.avatarUrl,
      role: user.role,
      createdAt: user.createdAt,
    },
    lucra: link ? { verificationState: link.verificationState, linkedAt: link.linkedAt, lastSyncedAt: link.lastSyncedAt } : null,
    teams,
    invites: user.phoneE164 ? listPendingInvitesForPhone(user.phoneE164) : [],
    rewards: rewardRows.map((r) => ({
      ...r.reward,
      tournamentSlug: r.tournamentSlug,
      tournamentName: r.tournamentName,
      teamName: teams.find((t) => t.team.id === r.reward.teamId)?.team.name ?? "",
    })),
  };
}
