import "server-only";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getBracketRoundCount } from "@/db/queries/tournaments";
import { GONE_TEAM_STATUSES } from "@/db/queries/teams";
import { lucraLinks, matches, scoreSubmissions, teamMembers, teams, tournaments, users, type MatchStatus, type TeamStatus, type User, type VerificationState } from "@/db/schema";
import { bracketRoundLabel } from "@/lib/rounds";
import { buildSeed, DEFAULT_RNG_SEED, startOfTodayIn, VENUE_TIMEZONE } from "@/seed/build";
import { demoRoster, type DemoAccountKey, type DemoRoster } from "@/seed/demo";

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`): the curated seeded
 * users, resolved by their seeded phone numbers (`src/seed/demo.ts`) against
 * the live rows, each with the state a visitor should know before choosing —
 * the match the two captains are on and whether their own scoreline is in,
 * the registrant's team, the two Lucra states. Only read while the switch is
 * on; `POST /api/auth/demo` signs in from the same list.
 */

export type DemoAccountDetail =
  | { kind: "match"; matchId: string; matchStatus: MatchStatus; round: string; teamName: string; opponentName: string | null; ownScorelineIn: boolean }
  | { kind: "register"; teamId: string; teamName: string; teamStatus: TeamStatus }
  | { kind: "organizer" }
  | { kind: "lucra"; verificationState: VerificationState };

export interface DemoAccount {
  key: DemoAccountKey;
  userId: string;
  displayName: string;
  role: User["role"];
  /** The event the account's story is about. */
  tournament: { slug: string; name: string };
  /** Where the picker sends the visitor after signing in. */
  href: string;
  detail: DemoAccountDetail;
}

declare global {
  var __sideoutDemoRoster: DemoRoster | undefined;
}

/** The roster is a pure function of the seed builder; derive it once per process. */
function roster(): DemoRoster {
  globalThis.__sideoutDemoRoster ??= demoRoster(buildSeed({ anchorMs: startOfTodayIn(VENUE_TIMEZONE), rngSeed: DEFAULT_RNG_SEED }));
  return globalThis.__sideoutDemoRoster;
}

function userByPhone(phone: string): User | null {
  return getDb().select().from(users).where(eq(users.phoneE164, phone)).get() ?? null;
}

function teamOf(userId: string, tournamentId: string): { id: string; name: string; status: TeamStatus } | null {
  return (
    getDb()
      .select({ id: teams.id, name: teams.name, status: teams.status })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, userId), eq(teams.tournamentId, tournamentId), notInArray(teams.status, [...GONE_TEAM_STATUSES])))
      .orderBy(desc(teams.createdAt))
      .get() ?? null
  );
}

/** Every demo account with its live state, in picker order; null when the seeded rows are not there (an unseeded database). */
export function listDemoAccounts(): DemoAccount[] | null {
  const db = getDb();
  const r = roster();
  const live = db.select({ id: tournaments.id, slug: tournaments.slug, name: tournaments.name }).from(tournaments).where(eq(tournaments.slug, r.liveSlug)).get();
  const upcoming = db.select({ id: tournaments.id, slug: tournaments.slug, name: tournaments.name }).from(tournaments).where(eq(tournaments.slug, r.upcomingSlug)).get();
  if (!live || !upcoming) return null;
  const match = db.select().from(matches).where(and(eq(matches.tournamentId, live.id), eq(matches.bracketPosition, r.matchBracketPosition))).get();
  if (!match) return null;
  const rounds = getBracketRoundCount(live.id);
  const round = bracketRoundLabel(match.round, rounds).replace(/s$/, "");
  const teamName = (id: string | null) => (id ? (db.select({ name: teams.name }).from(teams).where(eq(teams.id, id)).get()?.name ?? null) : null);

  const out: DemoAccount[] = [];
  const captain = (key: "captain_a" | "captain_b", ownTeamId: string | null, opponentId: string | null): DemoAccount | null => {
    const user = userByPhone(r.phones[key]);
    if (!user || !ownTeamId) return null;
    const own = teamName(ownTeamId);
    // A live submission (not superseded) for this team means its scoreline is in.
    const ownIn = db
      .select({ id: scoreSubmissions.id })
      .from(scoreSubmissions)
      .where(and(eq(scoreSubmissions.matchId, match.id), eq(scoreSubmissions.submittedForTeamId, ownTeamId), isNull(scoreSubmissions.supersededById)))
      .get();
    return {
      key,
      userId: user.id,
      displayName: user.displayName,
      role: user.role,
      tournament: { slug: live.slug, name: live.name },
      href: `/m/${match.id}`,
      detail: { kind: "match", matchId: match.id, matchStatus: match.status, round, teamName: own ?? "Team", opponentName: teamName(opponentId), ownScorelineIn: Boolean(ownIn) },
    };
  };
  const a = captain("captain_a", match.teamAId, match.teamBId);
  const b = captain("captain_b", match.teamBId, match.teamAId);
  if (a) out.push(a);
  if (b) out.push(b);

  const registrant = userByPhone(r.phones.registrant);
  const team = registrant ? teamOf(registrant.id, upcoming.id) : null;
  if (registrant && team) {
    out.push({
      key: "registrant",
      userId: registrant.id,
      displayName: registrant.displayName,
      role: registrant.role,
      tournament: { slug: upcoming.slug, name: upcoming.name },
      href: `/t/${upcoming.slug}/register`,
      detail: { kind: "register", teamId: team.id, teamName: team.name, teamStatus: team.status },
    });
  }

  const organizer = userByPhone(r.phones.organizer);
  if (organizer) {
    out.push({ key: "organizer", userId: organizer.id, displayName: organizer.displayName, role: organizer.role, tournament: { slug: live.slug, name: live.name }, href: "/organizer/events", detail: { kind: "organizer" } });
  }

  for (const key of ["not_allowed", "demographics_missing"] as const) {
    const user = userByPhone(r.phones[key]);
    if (!user) continue;
    const link = db.select({ state: lucraLinks.verificationState }).from(lucraLinks).where(eq(lucraLinks.userId, user.id)).get();
    out.push({ key, userId: user.id, displayName: user.displayName, role: user.role, tournament: { slug: live.slug, name: live.name }, href: "/me", detail: { kind: "lucra", verificationState: link?.state ?? "unverified" } });
  }
  return out;
}

/** One demo account by key, or null when the switch's roster does not resolve to it. */
export function findDemoAccount(key: DemoAccountKey): DemoAccount | null {
  return listDemoAccounts()?.find((a) => a.key === key) ?? null;
}
