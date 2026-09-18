import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { linksForUsers } from "@/db/queries/lucra";
import { listTeamsWithMembers } from "@/db/queries/tournaments";
import { tournaments, users } from "@/db/schema";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { uuidFromSeed } from "@/lib/uuid";
import { getLucra, mockAccountFor, mockLucraUserId, mockMatchupMetadata } from "@/server/lucra";
import { deliverPendingMockWebhooks } from "@/server/lucra-webhooks";

/**
 * The organizer's stand-in for Lucra's console, mock mode only (spec §7.4
 * and open question 6: tournaments are created and closed by a game operator
 * in Lucra's console, never by a partner API call). In sandbox or production
 * a Lucra representative creates the tournament with this event's
 * `externalId`; here the in-process mock is Lucra, so this is how an event
 * created after boot gets its matchup — `buildMockSeedFromDb` only knows the
 * events that existed when the process started.
 *
 * With `enterRoster`, every registered player who has a Lucra link joins the
 * matchup the way the SDK's `joinTournament` would, so the mock emits
 * `TournamentUserJoined` for each and the receiver records their Lucra ids;
 * a player with no link is reported, not invented. An event the mock already
 * holds (it seeds itself from the database on first use, so an event created
 * before that is already there) is not created twice: the existing matchup is
 * returned with `created: false` and the roster still enters. Nothing here is
 * reachable outside a mock build (`src/lib/build-gates.ts`).
 */

export const mockCreateTournamentSchema = z
  .object({
    tournamentId: z.string().min(1),
    enterRoster: z.boolean().optional(),
  })
  .strict();

export interface MockCreateTournamentResult {
  matchupId: string;
  externalId: string;
  /** False when the mock already held the tournament (seeded from the database at first use). */
  created: boolean;
  participants: number;
  /** Registered players who could not enter because they have never signed in to Lucra. */
  unlinked: Array<{ userId: string; displayName: string }>;
}

export async function createMockTournament(input: z.infer<typeof mockCreateTournamentSchema>, clock: Clock = systemClock): Promise<MockCreateTournamentResult> {
  const mock = getLucra().mock;
  if (!mock) throw new ApiFailure("conflict", "The Lucra mock console exists only in mock mode.", { code: "not_mock_mode" });
  const db = getDb();
  const t = db.select().from(tournaments).where(eq(tournaments.id, input.tournamentId)).get();
  if (!t) throw new ApiFailure("not_found", "No tournament with that id.");
  const held = mock.listMatchups().filter((m) => m.kind === "pool_tournament" && m.metadata.externalId === t.lucraExternalId);
  if (held.length > 1) throw new ApiFailure("conflict", `Lucra (mock) holds ${held.length} tournaments with externalId ${t.lucraExternalId}; rule 7.3.4 refuses to write to any of them.`, { code: "matchup_ambiguous", count: held.length });
  const matchup =
    held[0] ??
    mock.addMatchup({
      id: uuidFromSeed(`matchup:${t.lucraExternalId}`),
      kind: "pool_tournament",
      title: t.name,
      gameId: t.lucraGameId,
      locationIds: t.lucraLocationId ? [t.lucraLocationId] : [],
      metadata: mockMatchupMetadata(t),
      participants: [],
      createdAt: clock.now(),
    });
  const created = held.length === 0;
  if (matchup.status === "CLOSED" || matchup.status === "CANCELED") throw new ApiFailure("conflict", `Lucra (mock) holds this tournament as ${matchup.status}; nobody can enter it.`, { code: "matchup_closed" });

  const unlinked: MockCreateTournamentResult["unlinked"] = [];
  if (input.enterRoster) {
    const roster = listTeamsWithMembers(t.id).filter((team) => team.status === "registered" || team.status === "checked_in");
    const members = roster.flatMap((team) => team.members);
    const links = linksForUsers(db, members.map((m) => m.userId));
    const userRows = new Map(db.select().from(users).all().map((u) => [u.id, u]));
    for (const member of members) {
      const link = links.get(member.userId);
      if (!link) {
        unlinked.push({ userId: member.userId, displayName: member.displayName });
        continue;
      }
      const lucraUserId = mockLucraUserId(link);
      if (!mock.getUser(lucraUserId)) {
        const user = userRows.get(member.userId);
        mock.addUser({
          id: lucraUserId,
          username: (user?.displayName ?? member.displayName).toLowerCase().replace(/[^a-z0-9]+/g, "."),
          phoneNumber: user?.phoneE164 ?? null,
          metadata: { externalId: link.externalId },
          ...mockAccountFor(link.verificationState),
        });
      }
      mock.join(matchup.id, lucraUserId);
    }
    await deliverPendingMockWebhooks(clock);
  }
  return { matchupId: matchup.id, externalId: t.lucraExternalId, created, participants: matchup.participants.size, unlinked };
}
