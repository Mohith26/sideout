import type { SeedDataset } from "@/seed/build";
import { SLUGS } from "@/seed/build";

/**
 * The public demo's curated accounts (`DEMO_ACCOUNTS`, `docs/deploy.md`
 * "Public demo"), named from the seed dataset rather than from row ids: ids
 * embed the day the seed ran, while a seeded phone number is the same on
 * every host and survives everything a demo does to the rows. The server
 * (`src/db/queries/demo.ts`) resolves these phones against the database and
 * reads each account's live state from there.
 *
 * `src/seed/build.test.ts` proves the roster against the dataset: the match
 * is a Sandbar Classic quarterfinal awaiting scores, the registrant captains a
 * complete team that has not registered for Pier 9, and so on.
 */

export const DEMO_ACCOUNT_KEYS = ["captain_a", "captain_b", "registrant", "organizer", "not_allowed", "demographics_missing"] as const;
export type DemoAccountKey = (typeof DEMO_ACCOUNT_KEYS)[number];

/** The seeded Sandbar Classic bracket match the two captains play: quarterfinal 4, `awaiting_scores`. */
export const DEMO_MATCH_BRACKET_POSITION = 12;

export interface DemoRoster {
  /** Seeded phone (E.164) per account. */
  phones: Record<DemoAccountKey, string>;
  liveSlug: string;
  upcomingSlug: string;
  matchBracketPosition: number;
}

function phoneOf(data: SeedDataset, userId: string | undefined, what: string): string {
  const user = data.users.find((u) => u.id === userId);
  if (!user?.phoneE164) throw new Error(`seed: demo ${what} has no phone`);
  return user.phoneE164;
}

/** Derive the roster from a built dataset (pure; the seed builder is deterministic). */
export function demoRoster(data: SeedDataset): DemoRoster {
  const live = data.tournaments.find((t) => t.slug === SLUGS.live);
  const upcoming = data.tournaments.find((t) => t.slug === SLUGS.upcoming);
  if (!live || !upcoming) throw new Error("seed: demo events missing");

  const match = data.matches.find((m) => m.tournamentId === live.id && m.bracketPosition === DEMO_MATCH_BRACKET_POSITION);
  if (!match?.teamAId || !match.teamBId) throw new Error(`seed: demo match at bracket position ${DEMO_MATCH_BRACKET_POSITION} is not a two-team match`);
  const captainOf = (teamId: string) => data.teamMembers.find((m) => m.teamId === teamId && m.role === "captain")?.userId;

  // The complete team that has not registered: forming, with a captain and a player.
  const ready = data.teams.find((t) => t.tournamentId === upcoming.id && t.status === "forming" && data.teamMembers.filter((m) => m.teamId === t.id).length === 2);
  if (!ready) throw new Error("seed: demo registrant team missing");

  const organizer = data.users.find((u) => u.role === "organizer");
  const linkFor = (state: string) => data.lucraLinks.find((l) => l.verificationState === state);

  return {
    phones: {
      captain_a: phoneOf(data, captainOf(match.teamAId), "captain A"),
      captain_b: phoneOf(data, captainOf(match.teamBId), "captain B"),
      registrant: phoneOf(data, captainOf(ready.id), "registrant"),
      organizer: phoneOf(data, organizer?.id, "organizer"),
      not_allowed: phoneOf(data, linkFor("not_allowed")?.userId, "not-allowed player"),
      demographics_missing: phoneOf(data, linkFor("demographics_missing")?.userId, "demographics-missing player"),
    },
    liveSlug: SLUGS.live,
    upcomingSlug: SLUGS.upcoming,
    matchBracketPosition: DEMO_MATCH_BRACKET_POSITION,
  };
}
