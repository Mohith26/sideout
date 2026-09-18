import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { donations, matches } from "@/db/schema";

/** Disputed matches across every event: the console's primary alert figure. */
export function countDisputedMatches(): number {
  return getDb().select({ n: sql<number>`count(*)` }).from(matches).where(eq(matches.status, "disputed")).get()?.n ?? 0;
}

/** Donation rows of any status for an event: once one exists the beneficiary and currency are fixed. */
export function countDonationRows(tournamentId: string): number {
  return getDb().select({ n: sql<number>`count(*)` }).from(donations).where(eq(donations.tournamentId, tournamentId)).get()?.n ?? 0;
}
