import "server-only";
import { asc, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { charities, donations, rewards, sponsors, teams, tournaments, users, type Charity, type Reward, type Sponsor, type Tournament } from "@/db/schema";
import { sortSponsors, UNPUBLISHED_STATUS } from "@/db/queries/tournaments";

/**
 * Charity-side read models. Only `succeeded` donations count toward a total;
 * pending, failed and refunded rows are shown for what they are. Nothing here
 * touches the prize ledger except to list rewards side by side (spec §4.3:
 * separate tables, no join, no arithmetic across them).
 */

export interface DonorWallEntry {
  id: string;
  /** Display name, team name, or "Anonymous". */
  label: string;
  kind: "team_entry" | "supporter" | "anonymous";
  amountCents: number;
  currency: string;
  createdAt: number;
}

export interface ImpactBreakdown {
  goalCents: number;
  raisedCents: number;
  entryCents: number;
  supporterCents: number;
  pendingCents: number;
  donorCount: number;
  entryCount: number;
  currency: string;
  /** Raised / goal, uncapped so a met goal reads above 100%. */
  fraction: number;
}

export interface TournamentImpact {
  breakdown: ImpactBreakdown;
  donorWall: DonorWallEntry[];
  sponsors: Sponsor[];
  sponsorPrizeCents: number;
  rewards: Array<Reward & { teamName: string }>;
}

export function getTournamentImpact(tournament: Tournament): TournamentImpact {
  const db = getDb();
  const rows = db
    .select({
      donation: donations,
      teamName: teams.name,
      userName: users.displayName,
    })
    .from(donations)
    .leftJoin(teams, eq(teams.id, donations.teamId))
    .leftJoin(users, eq(users.id, donations.userId))
    .where(eq(donations.tournamentId, tournament.id))
    .orderBy(desc(donations.createdAt))
    .all();

  let raised = 0;
  let entry = 0;
  let supporter = 0;
  let pending = 0;
  let donorCount = 0;
  let entryCount = 0;
  const wall: DonorWallEntry[] = [];
  for (const { donation, teamName, userName } of rows) {
    if (donation.status === "pending") pending += donation.amountCents;
    if (donation.status !== "succeeded") continue;
    raised += donation.amountCents;
    donorCount += 1;
    if (donation.teamId) {
      entry += donation.amountCents;
      entryCount += 1;
      wall.push({
        id: donation.id,
        label: teamName ?? "Team entry",
        kind: "team_entry",
        amountCents: donation.amountCents,
        currency: donation.currency,
        createdAt: donation.createdAt,
      });
    } else {
      supporter += donation.amountCents;
      wall.push({
        id: donation.id,
        label: userName ?? "Anonymous",
        kind: userName ? "supporter" : "anonymous",
        amountCents: donation.amountCents,
        currency: donation.currency,
        createdAt: donation.createdAt,
      });
    }
  }

  const sponsorRows = sortSponsors(db.select().from(sponsors).where(eq(sponsors.tournamentId, tournament.id)).all());
  const rewardRows = db
    .select({ reward: rewards, teamName: teams.name })
    .from(rewards)
    .innerJoin(teams, eq(teams.id, rewards.teamId))
    .where(eq(rewards.tournamentId, tournament.id))
    .orderBy(asc(rewards.placement))
    .all()
    .map((r) => ({ ...r.reward, teamName: r.teamName }));

  return {
    breakdown: {
      goalCents: tournament.fundraisingGoalCents,
      raisedCents: raised,
      entryCents: entry,
      supporterCents: supporter,
      pendingCents: pending,
      donorCount,
      entryCount,
      currency: tournament.currency,
      fraction: tournament.fundraisingGoalCents > 0 ? raised / tournament.fundraisingGoalCents : 0,
    },
    donorWall: wall,
    sponsors: sponsorRows,
    sponsorPrizeCents: sponsorRows.reduce((s, x) => s + x.prizeContributionCents, 0),
    rewards: rewardRows,
  };
}

export interface GlobalImpact {
  charity: Charity | null;
  totalRaisedCents: number;
  totalGoalCents: number;
  donorCount: number;
  currency: string;
  perEvent: Array<{ tournament: Tournament; raisedCents: number; donorCount: number }>;
}

/** Site-wide totals over every published event; a draft's goal is not a public promise yet. */
export function getGlobalImpact(): GlobalImpact {
  const db = getDb();
  const charity = db.select().from(charities).limit(1).get() ?? null;
  const events = db.select().from(tournaments).where(ne(tournaments.status, UNPUBLISHED_STATUS)).orderBy(asc(tournaments.startsAt)).all();
  const agg = db
    .select({
      tournamentId: donations.tournamentId,
      raised: sql<number>`coalesce(sum(${donations.amountCents}), 0)`,
      donors: sql<number>`count(*)`,
    })
    .from(donations)
    .where(eq(donations.status, "succeeded"))
    .groupBy(donations.tournamentId)
    .all();
  const aggBy = new Map(agg.map((a) => [a.tournamentId, a]));
  const perEvent = events.map((t) => ({
    tournament: t,
    raisedCents: aggBy.get(t.id)?.raised ?? 0,
    donorCount: aggBy.get(t.id)?.donors ?? 0,
  }));
  return {
    charity,
    totalRaisedCents: perEvent.reduce((s, e) => s + e.raisedCents, 0),
    totalGoalCents: events.reduce((s, t) => s + t.fundraisingGoalCents, 0),
    donorCount: perEvent.reduce((s, e) => s + e.donorCount, 0),
    currency: events[0]?.currency ?? "USD",
    perEvent,
  };
}
