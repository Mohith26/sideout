import type {
  BestOf,
  NewAuditLogEntry,
  NewCharity,
  NewDonation,
  NewLucraLink,
  NewLucraScoreSubmission,
  NewMatch,
  NewMatchConsensus,
  NewPool,
  NewPoolTeam,
  NewReward,
  NewScoreSubmission,
  NewSetRow,
  NewSponsor,
  NewTeam,
  NewTeamInvite,
  NewTeamMember,
  NewTournament,
  NewUser,
  MatchStatus,
  VerificationState,
} from "@/db/schema";
import {
  draw,
  seedBracketSlots,
  selectAdvancing,
  type AdvancementRule,
  type DrawMatch,
  type DrawConfig,
  type DrawOptions,
  type DrawPlan,
  type DrawTeam,
} from "@/domain/draw";
import { canonicalizeSubmission, CONSENSUS_AUDIT, describeDifferences, diffScorelines, toPerspective, type StoredSubmission } from "@/domain/consensus";
import { buildLucraScoreWrite, callsForStorage, LUCRA_AUDIT, OUTCOME_EVENT, OUTCOME_TO_STATE, storedRequestFor, storedResponseFor, type StoredLucraRequest } from "@/domain/lucra-score";
import { computeStandings, type StandingRow, type StandingsMatch } from "@/domain/standings";
import { assertTeamRoster } from "@/domain/team";
import { DECIDING_SET_TARGET, SET_TARGET, judgeMatch, judgeSet, setTarget, type Scoreline, type SetScore, type Side } from "@/domain/scoreline";
import { hashScoreline } from "@/domain/scoreline-hash";
import { pairName, surname } from "@/lib/format";
import { createRng, type Rng } from "@/lib/rng";
import { createUuidV7Generator, shortId, uuidFromSeed } from "@/lib/uuid";
import { LUCRA_API_KEY_HEADER, LUCRA_ERROR_BODIES, LUCRA_PATHS, REDACTED } from "@/lucra/endpoints";
import type { ScoreWriteResult, WriteOutcome } from "@/lucra/adapter";
import type { CallRecord } from "@/lucra/types";
import { ORGANIZER_NAMES, PLAYER_NAMES } from "@/seed/names";

/**
 * Builds the complete section 13 dataset as plain rows. Pure and deterministic:
 * the same `anchorMs` and `rngSeed` produce byte-identical output, and every
 * result on screen (standings, seeds, winners, impact totals) follows from
 * these rows rather than being typed anywhere.
 *
 * Nothing here touches the database; `@/seed/write` persists the result.
 */

export interface SeedOptions {
  /** Midnight, venue-local, of the day the flagship event is "live". */
  anchorMs: number;
  rngSeed?: number;
}

export interface SeedDataset {
  charities: NewCharity[];
  users: NewUser[];
  lucraLinks: NewLucraLink[];
  tournaments: NewTournament[];
  teams: NewTeam[];
  teamMembers: NewTeamMember[];
  teamInvites: NewTeamInvite[];
  pools: NewPool[];
  poolTeams: NewPoolTeam[];
  matches: NewMatch[];
  sets: NewSetRow[];
  scoreSubmissions: NewScoreSubmission[];
  matchConsensus: NewMatchConsensus[];
  lucraScoreSubmissions: NewLucraScoreSubmission[];
  donations: NewDonation[];
  sponsors: NewSponsor[];
  rewards: NewReward[];
  auditLog: NewAuditLogEntry[];
}

export const DEFAULT_RNG_SEED = 0x51de0f7;
export const CURRENCY = "USD";
export const VENUE_TIMEZONE = "America/Los_Angeles";
// OPEN: (§17.5) how a gameId is registered for an outdoor, non-fixed venue sport
// is unresolved. One constant for the whole product until Lucra clarifies.
export const LUCRA_GAME_ID = "SIDEOUT_BEACH_2V2";

export const SLUGS = {
  live: "sandbar-classic-2026",
  upcoming: "pier-9-open-2026",
  settled: "low-tide-open-2026",
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Draw inputs for the seeded events. The seed runs the real draw engine with
 * these, and `src/seed/build.test.ts` re-runs `draw` from the same inputs to
 * prove the seeded rows are exactly what the engine produces.
 */
export interface SeedDrawSpec {
  rngSeed: number;
  courts: number;
  poolSize: number;
  advance: AdvancementRule;
  poolBestOf: BestOf;
  bracketBestOf: BestOf;
  /** Minutes after `tournaments.starts_at` that the first pool round begins. */
  startOffsetMinutes: number;
  poolMatchMinutes: number;
  bracketMatchMinutes: number;
  restMinutes: number;
}

export const SEED_DRAWS: Record<"live" | "settled", SeedDrawSpec> = {
  // Six pools of four on six courts; the six winners, six runners-up and three
  // best third-placed teams make fifteen into a sixteen-slot bracket, so the
  // top seed draws the one bye.
  live: {
    rngSeed: 0x5a9db4c,
    courts: 6,
    poolSize: 4,
    advance: { perPool: 2, bestRemaining: 3 },
    poolBestOf: "1",
    bracketBestOf: "3",
    startOffsetMinutes: 30,
    poolMatchMinutes: 30,
    bracketMatchMinutes: 50,
    restMinutes: 30,
  },
  // Four pools of four on four courts; winners and runners-up fill an eight-slot bracket.
  settled: {
    rngSeed: 0x10e71de,
    courts: 4,
    poolSize: 4,
    advance: { perPool: 2, bestRemaining: 0 },
    poolBestOf: "1",
    bracketBestOf: "3",
    startOffsetMinutes: 30,
    poolMatchMinutes: 30,
    bracketMatchMinutes: 50,
    restMinutes: 30,
  },
};

/** The `DrawConfig` a seeded event stores as `tournaments.draw_config_json`, exactly as the draw service would. */
export function seedDrawConfig(t: Pick<NewTournament, "startsAt">, spec: SeedDrawSpec): DrawConfig {
  return {
    courts: spec.courts,
    poolSize: spec.poolSize,
    advance: spec.advance,
    poolBestOf: spec.poolBestOf,
    bracketBestOf: spec.bracketBestOf,
    schedule: {
      startsAt: t.startsAt + spec.startOffsetMinutes * MINUTE,
      poolMatchMinutes: spec.poolMatchMinutes,
      bracketMatchMinutes: spec.bracketMatchMinutes,
      restMinutes: spec.restMinutes,
    },
    rngSeed: spec.rngSeed,
  };
}

/** The exact `DrawOptions` the seed hands the engine for a tournament. */
export function seedDrawOptions(t: Pick<NewTournament, "format" | "startsAt">, teams: readonly DrawTeam[], spec: SeedDrawSpec): DrawOptions {
  const config = seedDrawConfig(t, spec);
  return { ...config, format: t.format, teams, rng: createRng(config.rngSeed) };
}

// ---------------------------------------------------------------------------
// Internal working types
// ---------------------------------------------------------------------------

interface SeedUser {
  row: NewUser;
  strength: number; // hidden skill in [-1, 1], drives plausible results
}

interface SeedTeam {
  row: NewTeam;
  members: [captain: SeedUser, player: SeedUser];
  strength: number;
}

/** Desired status per bracket position; positions left out stay `scheduled`. */
type BracketPlan = Record<number, MatchStatus>;

interface DrawnEvent {
  plan: DrawPlan;
  poolRows: Map<string, NewPool>;
  matchRows: Map<string, NewMatch>;
}

interface PoolResult {
  poolKey: string;
  standings: StandingRow[];
}

/** What a seeded Lucra attempt looks like: the outcome, and for a failure the documented shape it carries. */
type SeededLucraAttempt = { outcome: "accepted" } | { outcome: "partial" } | { outcome: "rejected"; error: string; httpStatus: number } | { outcome: "transport_error"; httpStatus: number };

interface AgreedMatch {
  match: NewMatch;
  consensus: NewMatchConsensus;
  a: SeedTeam;
  b: SeedTeam;
  sets: SetScore[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

class SeedBuilder {
  readonly rng: Rng;
  private clock: number;
  private readonly mint: () => string;
  /** Every agreed match, so the Lucra writes can be replayed after play. */
  readonly agreed = new Map<string, AgreedMatch>();
  readonly data: SeedDataset = {
    charities: [],
    users: [],
    lucraLinks: [],
    tournaments: [],
    teams: [],
    teamMembers: [],
    teamInvites: [],
    pools: [],
    poolTeams: [],
    matches: [],
    sets: [],
    scoreSubmissions: [],
    matchConsensus: [],
    lucraScoreSubmissions: [],
    donations: [],
    sponsors: [],
    rewards: [],
    auditLog: [],
  };

  constructor(
    readonly anchorMs: number,
    rngSeed: number,
  ) {
    this.rng = createRng(rngSeed);
    this.clock = anchorMs - 120 * DAY;
    this.mint = createUuidV7Generator({ now: () => this.clock, random: (n) => this.rng.bytes(n) });
  }

  /** Mint an id whose embedded timestamp is `at` (ids stay time-ordered). */
  id(at: number): string {
    this.clock = at;
    return this.mint();
  }

  /** Opaque provider-style reference: prefix plus the random tail of a fresh id. */
  opaqueRef(prefix: string): string {
    return `${prefix}_${this.mint().replace(/-/g, "").slice(-16)}`;
  }

  audit(entry: Omit<NewAuditLogEntry, "id">): void {
    this.data.auditLog.push({ id: this.id(entry.createdAt), ...entry });
  }

  // -- identity -------------------------------------------------------------

  buildUsers(): SeedUser[] {
    const createdBase = this.anchorMs - 110 * DAY;
    const users: SeedUser[] = PLAYER_NAMES.map(([first, last], i) => {
      const createdAt = createdBase + i * (17 * HOUR) + this.rng.int(0, 6 * HOUR);
      const slug = `${first}.${last}`
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z.]/g, "");
      return {
        strength: this.rng.next() * 2 - 1,
        row: {
          id: this.id(createdAt),
          displayName: `${first} ${last}`,
          // 555-01xx is the reserved fictional exchange; never a real subscriber.
          phoneE164: `+1555${String(100 + i).padStart(3, "0")}${String(1000 + i * 7).slice(-4)}`,
          email: `${slug}@example.com`,
          avatarUrl: null,
          role: "player",
          createdAt,
        },
      };
    });
    this.data.users.push(...users.map((u) => u.row));

    // Verification states: mostly verified, a handful unverified, and exactly one
    // each of the two states the profile UI must render without contrivance.
    const states: VerificationState[] = users.map((_, i) => {
      if (i === 5) return "not_allowed";
      if (i === 11) return "demographics_missing";
      return "unverified";
    });
    const unverifiedIdx = users.map((_, i) => i).filter((i) => i !== 5 && i !== 11);
    const stillUnverified = new Set(this.rng.shuffle(unverifiedIdx).slice(0, 8));
    for (const i of unverifiedIdx) if (!stillUnverified.has(i)) states[i] = "verified";

    users.forEach((u, i) => {
      const state = states[i] ?? "unverified";
      const knownToLucra = state !== "unverified";
      const linkedAt = knownToLucra ? u.row.createdAt + this.rng.int(1, 5) * DAY : null;
      this.data.lucraLinks.push({
        id: this.id(u.row.createdAt + 1),
        userId: u.row.id,
        lucraUserId: knownToLucra ? this.opaqueRef("lu") : null,
        // Opaque, minted by us; never the email or phone (spec §6.1).
        externalId: `sideout-user-${shortId(u.row.id)}`,
        verificationState: state,
        linkedAt,
        lastSyncedAt: linkedAt === null ? null : this.anchorMs - this.rng.int(1, 72) * HOUR,
      });
    });
    return users;
  }

  /** Organizer accounts: they run events and never play, so they hold no Lucra link. */
  buildOrganizers(): NewUser[] {
    const createdBase = this.anchorMs - 119 * DAY;
    const rows = ORGANIZER_NAMES.map(([first, last], i): NewUser => {
      const createdAt = createdBase + i * HOUR;
      return {
        id: this.id(createdAt),
        displayName: `${first} ${last}`,
        phoneE164: `+1555010${String(9000 + i)}`,
        email: `${first}.${last}`.toLowerCase() + "@example.com",
        avatarUrl: null,
        role: "organizer",
        createdAt,
      };
    });
    this.data.users.push(...rows);
    return rows;
  }

  buildCharity(): NewCharity {
    const charity: NewCharity = {
      id: this.id(this.anchorMs - 118 * DAY),
      name: "Open Court Project",
      ein: "84-3921657",
      missionShort:
        "Open Court Project keeps public beach volleyball courts free to play on, funding nets, lights, and volunteer coaching so kids in coastal neighborhoods can learn the game without paying club fees.",
      logoUrl: null,
      // Reserved example domain: the beneficiary is illustrative, not a real organization.
      websiteUrl: "https://opencourt.example.org",
    };
    this.data.charities.push(charity);
    return charity;
  }

  // -- tournaments ----------------------------------------------------------

  tournament(
    input: Omit<NewTournament, "id" | "lucraExternalId" | "lucraGameId" | "lucraLocationId" | "currency" | "venueTimezone">,
  ): NewTournament {
    const id = this.id(input.createdAt);
    const row: NewTournament = {
      ...input,
      id,
      currency: CURRENCY,
      venueTimezone: VENUE_TIMEZONE,
      // Namespaced and globally unique (spec §7.3.3); phase 4 owns the exact contract.
      lucraExternalId: `sideout-${input.slug}-${shortId(id)}`,
      lucraGameId: LUCRA_GAME_ID,
      // OPEN: (§17.5) a travelling event has no fixed locationId; left null.
      lucraLocationId: null,
    };
    this.data.tournaments.push(row);
    return row;
  }

  tournamentTransitions(
    t: NewTournament,
    organizer: NewUser,
    transitions: ReadonlyArray<readonly [from: string, to: string, at: number]>,
  ): void {
    for (const [from, to, at] of transitions) {
      this.audit({
        actorUserId: organizer.id,
        actorKind: "organizer",
        action: "tournament.status_changed",
        subjectType: "tournament",
        subjectId: t.id,
        detailJson: JSON.stringify({ from, to }),
        createdAt: at,
      });
    }
  }

  // -- teams ----------------------------------------------------------------

  /** Pair users into teams for a tournament. `pairs` are indexes into `users`. */
  buildTeams(
    t: NewTournament,
    users: readonly SeedUser[],
    pairs: ReadonlyArray<readonly [number, number]>,
    options: { status: NewTeam["status"]; registeredFrom: number; registeredTo: number },
  ): SeedTeam[] {
    const teams: SeedTeam[] = [];
    const spacing = Math.max(1, Math.floor((options.registeredTo - options.registeredFrom) / Math.max(1, pairs.length)));
    pairs.forEach(([ia, ib], i) => {
      const captain = users[ia];
      const player = users[ib];
      if (!captain || !player) throw new Error(`seed: pair index out of range (${ia}, ${ib})`);
      const createdAt = options.registeredFrom + i * spacing + this.rng.int(0, Math.max(0, spacing - 1));
      const row: NewTeam = {
        id: this.id(createdAt),
        tournamentId: t.id,
        name: pairName(captain.row.displayName, player.row.displayName),
        seed: null,
        status: options.status,
        createdAt,
      };
      const members: NewTeamMember[] = [
        { id: this.id(createdAt + 1), teamId: row.id, userId: captain.row.id, role: "captain" },
        { id: this.id(createdAt + 2), teamId: row.id, userId: player.row.id, role: "player" },
      ];
      assertTeamRoster(members.map((m) => ({ userId: m.userId, role: m.role })));
      this.data.teams.push(row);
      this.data.teamMembers.push(...members);
      teams.push({ row, members: [captain, player], strength: (captain.strength + player.strength) / 2 });
    });
    return teams;
  }

  /**
   * A team mid-formation: the captain is in, the partner has a pending invite
   * by phone. Forming teams never count toward capacity and have no donation.
   */
  buildFormingTeam(t: NewTournament, captain: SeedUser, invitee: SeedUser, name: string, createdAt: number, options: { accepted?: boolean } = {}): NewTeam {
    const row: NewTeam = { id: this.id(createdAt), tournamentId: t.id, name, seed: null, status: "forming", createdAt };
    this.data.teams.push(row);
    this.data.teamMembers.push({ id: this.id(createdAt + 1), teamId: row.id, userId: captain.row.id, role: "captain" });
    const phone = invitee.row.phoneE164;
    if (!phone) throw new Error("seed: invitee has no phone");
    this.data.teamInvites.push({
      id: this.id(createdAt + 2),
      teamId: row.id,
      invitedByUserId: captain.row.id,
      phoneE164: phone,
      status: "pending",
      acceptedByUserId: null,
      createdAt: createdAt + 2,
      respondedAt: null,
    });
    this.audit({
      actorUserId: captain.row.id,
      actorKind: "player",
      action: "team.created",
      subjectType: "team",
      subjectId: row.id,
      detailJson: JSON.stringify({ tournamentId: t.id, name }),
      createdAt,
    });
    this.audit({
      actorUserId: captain.row.id,
      actorKind: "player",
      action: "team.invite_sent",
      subjectType: "team",
      subjectId: row.id,
      detailJson: JSON.stringify({ knownPlayer: true }),
      createdAt: createdAt + 2,
    });
    if (options.accepted) {
      // The partner accepted (what `POST /api/teams/:id/join` writes): the roster is
      // complete and the team is ready to register, with no donation yet.
      const invite = this.data.teamInvites[this.data.teamInvites.length - 1];
      if (!invite) throw new Error("seed: invite missing");
      const respondedAt = createdAt + 20 * MINUTE;
      invite.status = "accepted";
      invite.acceptedByUserId = invitee.row.id;
      invite.respondedAt = respondedAt;
      this.data.teamMembers.push({ id: this.id(respondedAt), teamId: row.id, userId: invitee.row.id, role: "player" });
      this.audit({
        actorUserId: invitee.row.id,
        actorKind: "player",
        action: "team.member_joined",
        subjectType: "team",
        subjectId: row.id,
        detailJson: JSON.stringify({ inviteId: invite.id, supersedes: null }),
        createdAt: respondedAt,
      });
    }
    return row;
  }

  // -- scoring --------------------------------------------------------------

  /** One legal completed set between two strengths. */
  playSet(a: SeedTeam, b: SeedTeam, target: number): { a: number; b: number; winner: Side } {
    const diff = a.strength - b.strength;
    const pA = 1 / (1 + Math.exp(-2.4 * diff));
    const winner: Side = this.rng.chance(pA) ? "a" : "b";
    const closeness = 1 - Math.min(1, Math.abs(diff)); // 0 = mismatch, 1 = even
    const deuce = this.rng.chance(0.08 + 0.1 * closeness);
    let loser: number;
    if (deuce) {
      loser = target + this.rng.int(-1, 3);
      // A deuce set: the loser reached target-1 or more, winner finished two clear.
      loser = Math.max(target - 1, loser);
    } else {
      const spread = target === DECIDING_SET_TARGET ? 4 : 6;
      const mean = target - 2 - spread + spread * closeness; // 13..19 for 21, 9..13 for 15
      const sample = mean + (this.rng.next() + this.rng.next() - 1) * spread;
      loser = Math.min(target - 2, Math.max(Math.round(target * 0.35), Math.round(sample)));
    }
    const win = loser >= target - 1 ? loser + 2 : target;
    const verdict = judgeSet(winner === "a" ? win : loser, winner === "a" ? loser : win, target);
    if (!verdict.legal) throw new Error(`seed: generated an illegal set ${win}–${loser} to ${target}`);
    return winner === "a" ? { a: win, b: loser, winner } : { a: loser, b: win, winner };
  }

  /** A complete, legal match. */
  playMatch(a: SeedTeam, b: SeedTeam, bestOf: BestOf): { sets: SetScore[]; winner: Side } {
    const sets: SetScore[] = [];
    const won = { a: 0, b: 0 };
    const needed = bestOf === "3" ? 2 : 1;
    let n = 1;
    while (won.a < needed && won.b < needed) {
      const s = this.playSet(a, b, setTarget(n, bestOf));
      sets.push({ setNumber: n, teamAPoints: s.a, teamBPoints: s.b });
      won[s.winner] += 1;
      n += 1;
    }
    const verdict = judgeMatch(sets, bestOf);
    if (!verdict.legal) throw new Error(`seed: generated an illegal match: ${verdict.reason}`);
    return { sets, winner: verdict.winner };
  }

  // -- consensus + sets -----------------------------------------------------
  //
  // Everything below writes exactly the rows and audit entries the consensus
  // service (`@/server/consensus`) would have written for the same events, so
  // a seeded match is indistinguishable from one played through the API.

  /** The `match_consensus` row for a match, created as `awaiting_first` at `at`. */
  openConsensus(match: NewMatch, at: number): NewMatchConsensus {
    const row: NewMatchConsensus = {
      id: this.id(at),
      matchId: match.id,
      state: "awaiting_first",
      agreedPayloadJson: null,
      agreedPayloadHash: null,
      disputedReason: null,
      resolvedByUserId: null,
      idempotencyKey: null,
      updatedAt: at,
    };
    this.data.matchConsensus.push(row);
    return row;
  }

  /** A match going onto the sand: `scheduled → in_progress`, as the organizer's live board records it. */
  startMatch(match: NewMatch, organizer: NewUser, startedAt: number): void {
    match.status = "in_progress";
    match.startedAt = startedAt;
    this.audit({
      actorUserId: organizer.id,
      actorKind: "organizer",
      action: "match.status_changed",
      subjectType: "match",
      subjectId: match.id,
      detailJson: JSON.stringify({ from: "scheduled", to: "in_progress" }),
      createdAt: startedAt,
    });
  }

  private consensusTransition(consensus: NewMatchConsensus, to: NewMatchConsensus["state"], actor: { kind: "player" | "organizer"; userId: string }, at: number, detail: Record<string, unknown>): void {
    this.audit({
      actorUserId: actor.userId,
      actorKind: actor.kind,
      action: CONSENSUS_AUDIT.stateChanged,
      subjectType: "consensus",
      subjectId: consensus.id,
      detailJson: JSON.stringify({ matchId: consensus.matchId, from: consensus.state, to, ...detail }),
      createdAt: at,
    });
    consensus.state = to;
    consensus.updatedAt = at;
  }

  private matchTransition(match: NewMatch, to: MatchStatus, actor: { kind: "player" | "organizer" | "system"; userId: string | null }, at: number, detail: Record<string, unknown>): void {
    this.audit({
      actorUserId: actor.userId,
      actorKind: actor.kind,
      action: "match.status_changed",
      subjectType: "match",
      subjectId: match.id,
      detailJson: JSON.stringify({ from: match.status, to, ...detail }),
      createdAt: at,
    });
    match.status = to;
  }

  /** The first team's submission: `awaiting_first → awaiting_second`, `in_progress → awaiting_scores`. */
  firstSubmission(match: NewMatch, consensus: NewMatchConsensus, team: SeedTeam, scoreline: Scoreline, side: Side, at: number): NewScoreSubmission {
    const sub = this.submission(match, team, scoreline, side, at);
    const actor = { kind: "player" as const, userId: sub.submittedByUserId };
    this.consensusTransition(consensus, "awaiting_second", actor, at, { event: "first_submission", teamId: team.row.id, submissionId: sub.id });
    this.matchTransition(match, "awaiting_scores", actor, at, { submissionId: sub.id });
    return sub;
  }

  /** Record two agreeing captain submissions, the agreed consensus, and the set rows. */
  recordAgreedResult(match: NewMatch, a: SeedTeam, b: SeedTeam, sets: readonly SetScore[], finalizedAt: number): void {
    const scoreline: Scoreline = { matchId: match.id, sets: [...sets] };
    const hash = hashScoreline(scoreline, "a");
    const firstAt = finalizedAt - this.rng.int(4, 9) * MINUTE;
    const consensus = this.openConsensus(match, match.startedAt ?? firstAt);
    const subA = this.firstSubmission(match, consensus, a, scoreline, "a", firstAt);
    const subB = this.submission(match, b, scoreline, "b", finalizedAt);
    if (subA.payloadHash !== subB.payloadHash || subA.payloadHash !== hash) {
      throw new Error("seed: agreeing submissions must hash identically");
    }
    const winnerTeamId = match.winnerTeamId;
    if (!winnerTeamId) throw new Error("seed: an agreed result needs a winner");
    const idempotencyKey = this.id(finalizedAt);
    this.consensusTransition(consensus, "agreed", { kind: "player", userId: subB.submittedByUserId }, finalizedAt, {
      event: "matching_submission",
      hash,
      idempotencyKey,
      mintedKey: true,
      winnerTeamId,
      resolvedByUserId: null,
    });
    consensus.agreedPayloadJson = JSON.stringify(scoreline);
    consensus.agreedPayloadHash = hash;
    consensus.idempotencyKey = idempotencyKey;
    for (const s of sets) {
      this.data.sets.push({
        id: this.id(finalizedAt),
        matchId: match.id,
        setNumber: s.setNumber,
        teamAPoints: s.teamAPoints,
        teamBPoints: s.teamBPoints,
        agreed: true,
      });
    }
    this.matchTransition(match, "final", { kind: "system", userId: null }, finalizedAt, { winnerTeamId, consensusId: consensus.id, hash });
    match.finalizedAt = finalizedAt;
    this.agreed.set(match.id, { match, consensus, a, b, sets: [...sets] });
  }

  // -- Lucra ------------------------------------------------------------------
  //
  // The rows and audit entries `submitConsensusScores` (`@/server/lucra`)
  // writes for an agreed match: the consensus moves `agreed → submitting →
  // accepted | partial | rejected` as actor `system`, and one
  // `lucra_score_submissions` row per attempt holds exactly what went over the
  // wire (key redacted) and exactly what came back. The mock is rebuilt from
  // these rows at boot, so the leaderboard it serves agrees with them.

  /** The mock's matchup id for a tournament: what the pre-write query returns for its `externalId`. */
  static lucraMatchupId(t: Pick<NewTournament, "lucraExternalId">): string {
    return uuidFromSeed(`matchup:${t.lucraExternalId}`);
  }

  /** The §7.3.4 assertion, already run and cached for a tournament whose scores were written. */
  verifyLucraMatchup(t: NewTournament, at: number): void {
    t.lucraMatchupId = SeedBuilder.lucraMatchupId(t);
    t.lucraMatchupVerifiedAt = at;
    this.audit({
      actorUserId: null,
      actorKind: "system",
      action: LUCRA_AUDIT.matchupVerified,
      subjectType: "tournament",
      subjectId: t.id,
      detailJson: JSON.stringify({ externalId: t.lucraExternalId, matchupId: t.lucraMatchupId, count: 1 }),
      createdAt: at,
    });
  }

  /** One Lucra attempt for an agreed match, exactly as the service records it. */
  writeToLucra(t: NewTournament, agreed: AgreedMatch, attempt: SeededLucraAttempt, attemptNumber: number, at: number): NewLucraScoreSubmission {
    const { match, consensus, a, b, sets } = agreed;
    const idempotencyKey = consensus.idempotencyKey;
    if (!idempotencyKey) throw new Error("seed: an agreed consensus has no idempotency key");
    const externalIdOf = (u: SeedUser) => this.data.lucraLinks.find((l) => l.userId === u.row.id)?.externalId ?? null;
    const team = (st: SeedTeam) => ({ id: st.row.id, members: st.members.map((m) => ({ userId: m.row.id, externalId: externalIdOf(m) })) });
    const { input, unlinked } = buildLucraScoreWrite({
      match: { id: match.id, round: match.round, winnerTeamId: match.winnerTeamId ?? null },
      tournament: { slug: t.slug, lucraExternalId: t.lucraExternalId, lucraGameId: t.lucraGameId, lucraLocationId: t.lucraLocationId ?? null },
      idempotencyKey,
      teamA: team(a),
      teamB: team(b),
      sets,
    });
    if (unlinked.length > 0) throw new Error("seed: every seeded player is linked");
    const matchupId = SeedBuilder.lucraMatchupId(t);
    const submissionId = this.id(at);
    const startedAt = at;
    const finishedAt = at + 180 + this.rng.int(0, 420);

    // One call per user score, as the type-specific endpoint takes them.
    const headers = { Accept: "application/json", [LUCRA_API_KEY_HEADER]: REDACTED, "Content-Type": "application/json" };
    const calls: CallRecord[] = input.userScores.map((userScore, i) => {
      const body = { object: { matchupMetadata: { externalId: t.lucraExternalId }, gameId: t.lucraGameId, userScore } };
      const base = { method: "POST" as const, path: LUCRA_PATHS.poolTournamentUserScore, request: { headers, body }, startedAt: startedAt + i, error: null };
      switch (attempt.outcome) {
        case "accepted":
          return { ...base, tries: 1, finishedAt: finishedAt + i, response: { status: 200, body: { status: "success", data: { affectedMatchupIds: [matchupId], failedMatchupIds: [] } } } };
        case "partial":
          return { ...base, tries: 1, finishedAt: finishedAt + i, response: { status: 200, body: { status: "success", data: { affectedMatchupIds: [], failedMatchupIds: [matchupId] } } } };
        case "rejected":
          return { ...base, tries: 1, finishedAt: finishedAt + i, response: { status: attempt.httpStatus, body: { status: "failure", error: attempt.error } }, error: { code: attempt.error === LUCRA_ERROR_BODIES.matchupNotFound ? "matchup_not_found" : "user_not_found", message: `Lucra refused the request: ${attempt.error}` } };
        case "transport_error":
          return { ...base, tries: 4, finishedAt: finishedAt + 2_000 + i, response: { status: attempt.httpStatus, body: { error: "upstream unavailable" } }, error: { code: "server", message: `Lucra answered ${attempt.httpStatus} (after 4 tries)` } };
      }
    });
    const outcome: WriteOutcome = attempt.outcome;
    const httpStatus = attempt.outcome === "accepted" || attempt.outcome === "partial" ? 200 : attempt.httpStatus;
    const error: ScoreWriteResult["error"] =
      attempt.outcome === "accepted"
        ? null
        : attempt.outcome === "partial"
          ? { code: "validation", message: `Lucra reported failed matchups: ${matchupId}` }
          : (calls[0]?.error ?? null);
    const result: ScoreWriteResult = { outcome, endpoint: "pool_tournament", calls, affectedMatchupIds: attempt.outcome === "accepted" ? [matchupId] : [], failedMatchupIds: attempt.outcome === "partial" ? [matchupId] : [], httpStatus, error };
    const stored: StoredLucraRequest = { ...storedRequestFor(input), calls: callsForStorage(calls) };
    const row: NewLucraScoreSubmission = {
      id: submissionId,
      matchId: match.id,
      tournamentId: t.id,
      idempotencyKey,
      requestJson: JSON.stringify(stored),
      responseJson: JSON.stringify(storedResponseFor(result)),
      httpStatus,
      affectedMatchupIdsJson: JSON.stringify(result.affectedMatchupIds),
      failedMatchupIdsJson: JSON.stringify(result.failedMatchupIds),
      outcome,
      attempt: attemptNumber,
      createdAt: startedAt,
    };
    this.data.lucraScoreSubmissions.push(row);

    const system = { kind: "system" as const, userId: null };
    const actorKind = attemptNumber === 1 ? "system" : "organizer";
    const actorUserId = attemptNumber === 1 ? null : (this.data.users.find((u) => u.role === "organizer")?.id ?? null);
    this.audit({
      actorUserId,
      actorKind,
      action: CONSENSUS_AUDIT.stateChanged,
      subjectType: "consensus",
      subjectId: consensus.id,
      detailJson: JSON.stringify({ matchId: match.id, from: consensus.state, to: "submitting", event: attemptNumber === 1 ? "lucra_submit" : "organizer_retry", attempt: attemptNumber, submissionId, idempotencyKey }),
      createdAt: startedAt,
    });
    consensus.state = "submitting";
    consensus.updatedAt = startedAt;
    const next = OUTCOME_TO_STATE[outcome];
    this.audit({
      actorUserId: system.userId,
      actorKind: system.kind,
      action: CONSENSUS_AUDIT.stateChanged,
      subjectType: "consensus",
      subjectId: consensus.id,
      detailJson: JSON.stringify({ matchId: match.id, from: "submitting", to: next, event: OUTCOME_EVENT[outcome], outcome, attempt: attemptNumber, submissionId, httpStatus, error }),
      createdAt: finishedAt,
    });
    consensus.state = next;
    consensus.updatedAt = finishedAt;
    this.audit({
      actorUserId: null,
      actorKind: "system",
      action: LUCRA_AUDIT.scoreWritten,
      subjectType: "match",
      subjectId: match.id,
      detailJson: JSON.stringify({ submissionId, attempt: attemptNumber, outcome, affected: result.affectedMatchupIds, failed: result.failedMatchupIds, httpStatus, error, calls: calls.length }),
      createdAt: finishedAt,
    });
    return row;
  }

  /**
   * Write every agreed match of a tournament to Lucra as it was agreed, with
   * `failures` naming matches whose first attempt did not land (each is then
   * retried by the organizer and accepted), so the audit view shows every
   * outcome on first run.
   */
  writeAgreedToLucra(t: NewTournament, failures: ReadonlyMap<string, SeededLucraAttempt>): void {
    const rows = [...this.agreed.values()].filter((x) => x.match.tournamentId === t.id).sort((x, y) => (x.match.finalizedAt ?? 0) - (y.match.finalizedAt ?? 0));
    if (rows.length === 0) return;
    const firstAt = Math.min(...rows.map((r) => r.match.finalizedAt ?? 0));
    this.verifyLucraMatchup(t, firstAt + 1_000);
    for (const agreed of rows) {
      const at = (agreed.match.finalizedAt ?? 0) + 2_000 + this.rng.int(0, 3_000);
      const failure = failures.get(agreed.match.id);
      if (!failure) {
        this.writeToLucra(t, agreed, { outcome: "accepted" }, 1, at);
        continue;
      }
      this.writeToLucra(t, agreed, failure, 1, at);
      // The organizer retries a few minutes later with the same key; it lands.
      this.writeToLucra(t, agreed, { outcome: "accepted" }, 2, at + this.rng.int(4, 11) * MINUTE);
    }
  }

  /**
   * One captain's submission. The stored payload is exactly what they typed —
   * their own points first — and the hash is of the canonical (team-A oriented)
   * form, so two honest views of one result agree.
   */
  submission(match: NewMatch, team: SeedTeam, scoreline: Scoreline, perspective: Side, at: number): NewScoreSubmission {
    const stored: StoredSubmission = { matchId: scoreline.matchId, perspective, sets: toPerspective(scoreline.sets, perspective) };
    const canonical = canonicalizeSubmission(match.id, stored.sets, perspective, match.bestOf);
    if (!canonical.verdict.legal) throw new Error(`seed: illegal submission: ${canonical.verdict.reason}`);
    const row: NewScoreSubmission = {
      id: this.id(at),
      matchId: match.id,
      submittedByUserId: team.members[0].row.id,
      submittedForTeamId: team.row.id,
      payloadJson: JSON.stringify(stored),
      payloadHash: canonical.hash,
      createdAt: at,
      supersededById: null,
    };
    this.data.scoreSubmissions.push(row);
    this.audit({
      actorUserId: team.members[0].row.id,
      actorKind: "player",
      action: CONSENSUS_AUDIT.scoreSubmitted,
      subjectType: "match",
      subjectId: match.id,
      detailJson: JSON.stringify({ submissionId: row.id, teamId: team.row.id, side: perspective, hash: row.payloadHash, replaced: false }),
      createdAt: at,
    });
    return row;
  }

  // -- draw -----------------------------------------------------------------

  /**
   * Run the draw engine for a tournament and mint its pool and match rows,
   * exactly as `POST /api/admin/tournaments/:id/draw` would, storing the
   * configuration on the tournament row. Team order is creation order; every
   * entry seed is null, so pool placement follows the engine's rng for
   * `spec.rngSeed`.
   */
  drawEvent(t: NewTournament, organizer: NewUser, teams: readonly SeedTeam[], spec: SeedDrawSpec, drawnAt: number): DrawnEvent {
    const config = seedDrawConfig(t, spec);
    const plan = draw({ ...config, format: t.format, teams: teams.map((team) => ({ id: team.row.id, seed: null })), rng: createRng(config.rngSeed) });
    t.drawConfigJson = JSON.stringify(config);
    const poolRows = new Map<string, NewPool>();
    plan.pools.forEach((pool, p) => {
      const row: NewPool = { id: this.id(t.createdAt + p), tournamentId: t.id, label: pool.label, courtLabel: pool.courtLabel };
      poolRows.set(pool.key, row);
      this.data.pools.push(row);
      for (const teamId of pool.teamIds) this.data.poolTeams.push({ id: this.id(t.createdAt + p + 1), poolId: row.id, teamId });
    });
    const matchRows = new Map<string, NewMatch>();
    for (const m of plan.matches) {
      const poolRow = m.poolKey === null ? null : poolRows.get(m.poolKey);
      if (m.poolKey !== null && !poolRow) throw new Error(`seed: match ${m.key} references unknown pool ${m.poolKey}`);
      matchRows.set(m.key, {
        id: this.id(m.scheduledAt ?? drawnAt),
        tournamentId: t.id,
        poolId: poolRow?.id ?? null,
        round: m.round,
        bracketPosition: m.bracketPosition,
        courtLabel: m.courtLabel,
        teamAId: m.teamAId,
        teamBId: m.teamBId,
        bestOf: m.bestOf,
        status: m.status,
        winnerTeamId: m.winnerTeamId,
        nextMatchId: null,
        nextMatchSlot: m.nextMatchSlot,
        scheduledAt: m.scheduledAt,
        startedAt: null,
        finalizedAt: null,
      });
    }
    for (const m of plan.matches) {
      const row = matchRows.get(m.key);
      if (row && m.nextMatchKey !== null) row.nextMatchId = matchRows.get(m.nextMatchKey)?.id ?? null;
    }
    this.audit({
      actorUserId: organizer.id,
      actorKind: "organizer",
      action: "tournament.draw_generated",
      subjectType: "tournament",
      subjectId: t.id,
      detailJson: JSON.stringify({
        format: plan.format,
        rngSeed: config.rngSeed,
        courts: config.courts,
        poolSize: config.poolSize,
        advance: config.advance,
        pools: plan.pools.length,
        matches: plan.matches.length,
        bracket: plan.bracket,
      }),
      createdAt: drawnAt,
    });
    return { plan, poolRows, matchRows };
  }

  // -- pool play ------------------------------------------------------------

  /** Play every pool match to a final, agreed result; returns standings per pool. */
  playPools(drawn: DrawnEvent, organizer: NewUser, teamsById: Map<string, SeedTeam>): PoolResult[] {
    const played = new Map<string, StandingsMatch[]>();
    const poolMatches = drawn.plan.matches.filter((m) => m.poolKey !== null).sort((x, y) => (x.scheduledAt ?? 0) - (y.scheduledAt ?? 0));
    for (const m of poolMatches) {
      const row = drawn.matchRows.get(m.key);
      const a = teamsById.get(m.teamAId ?? "");
      const b = teamsById.get(m.teamBId ?? "");
      if (!row || !a || !b || row.scheduledAt === null || row.scheduledAt === undefined) throw new Error(`seed: pool match ${m.key} is incomplete`);
      const startedAt = row.scheduledAt + this.rng.int(0, 4) * MINUTE;
      const finalizedAt = startedAt + this.rng.int(18, 27) * MINUTE;
      const result = this.playMatch(a, b, row.bestOf);
      this.startMatch(row, organizer, startedAt);
      row.winnerTeamId = result.winner === "a" ? a.row.id : b.row.id;
      this.recordAgreedResult(row, a, b, result.sets, finalizedAt);
      const list = played.get(m.poolKey ?? "") ?? [];
      list.push({ teamAId: a.row.id, teamBId: b.row.id, winnerTeamId: row.winnerTeamId, sets: result.sets });
      played.set(m.poolKey ?? "", list);
    }
    return drawn.plan.pools.map((pool) => ({ poolKey: pool.key, standings: computeStandings(pool.teamIds, played.get(pool.key) ?? []) }));
  }

  /**
   * Seed the bracket from pool results through the engine's advancement rule
   * and resolve round-1 byes (the present team advances). The order lives on
   * the round-1 slots; `teams.seed` stays the (null) entry seed.
   */
  seedBracketFromPools(t: NewTournament, drawn: DrawnEvent, results: readonly PoolResult[], spec: SeedDrawSpec, teamsById: Map<string, SeedTeam>, at: number): void {
    const advancing = selectAdvancing(
      results.map((r) => ({ rows: r.standings })),
      spec.advance,
    );
    for (const teamId of advancing) if (!teamsById.has(teamId)) throw new Error("seed: advancing team is unknown");
    const bracket = drawn.plan.matches.filter((m): m is DrawMatch & { bracketPosition: number } => m.bracketPosition !== null);
    const patches = seedBracketSlots(bracket, advancing);
    for (const patch of patches) {
      const row = drawn.matchRows.get(patch.key);
      if (!row) throw new Error(`seed: patch for unknown match ${patch.key}`);
      row.teamAId = patch.teamAId;
      row.teamBId = patch.teamBId;
      if (patch.status === "bye") {
        row.status = "bye";
        row.winnerTeamId = patch.winnerTeamId;
        row.finalizedAt = at;
        this.audit({
          actorUserId: null,
          actorKind: "system",
          action: "match.status_changed",
          subjectType: "match",
          subjectId: row.id,
          detailJson: JSON.stringify({ from: "scheduled", to: "bye", winnerTeamId: row.winnerTeamId }),
          createdAt: at,
        });
      }
    }
    this.audit({
      actorUserId: null,
      actorKind: "system",
      action: "tournament.bracket_seeded",
      subjectType: "tournament",
      subjectId: t.id,
      detailJson: JSON.stringify({ advance: spec.advance, seeds: advancing }),
      createdAt: at,
    });
  }

  // -- bracket --------------------------------------------------------------

  /** Play the bracket to the planned status per position, advancing winners as the engine does. */
  playBracket(drawn: DrawnEvent, organizer: NewUser, plan: BracketPlan, teamsById: Map<string, SeedTeam>): void {
    const bracket = drawn.plan.matches
      .filter((m): m is DrawMatch & { bracketPosition: number } => m.bracketPosition !== null)
      .sort((x, y) => x.bracketPosition - y.bracketPosition);
    const rowOf = (key: string): NewMatch => {
      const row = drawn.matchRows.get(key);
      if (!row) throw new Error(`seed: unknown bracket match ${key}`);
      return row;
    };
    /** The winner moves into the next slot, as `applyAdvancement` records it. */
    const advance = (m: DrawMatch, winner: SeedTeam, at: number) => {
      if (m.nextMatchKey === null || m.nextMatchSlot === null) return;
      const next = rowOf(m.nextMatchKey);
      if (m.nextMatchSlot === "a") next.teamAId = winner.row.id;
      else next.teamBId = winner.row.id;
      this.audit({
        actorUserId: null,
        actorKind: "system",
        action: "match.slot_filled",
        subjectType: "match",
        subjectId: next.id,
        detailJson: JSON.stringify({ slot: m.nextMatchSlot, teamId: winner.row.id, fromMatchId: rowOf(m.key).id }),
        createdAt: at,
      });
    };

    for (const m of bracket) {
      const row = rowOf(m.key);
      const desired: MatchStatus = plan[m.bracketPosition] ?? "scheduled";
      if (row.status === "bye") {
        if (desired !== "scheduled" && desired !== "bye") throw new Error(`seed: position ${m.bracketPosition} is a bye and cannot be ${desired}`);
        continue;
      }
      if (desired === "scheduled") continue;
      const scheduledAt = row.scheduledAt ?? this.anchorMs;
      const a = teamsById.get(row.teamAId ?? "");
      const b = teamsById.get(row.teamBId ?? "");
      if (!a || !b) throw new Error(`seed: position ${m.bracketPosition} planned as ${desired} but lacks two teams`);
      const startedAt = scheduledAt + this.rng.int(2, 9) * MINUTE;
      this.startMatch(row, organizer, startedAt);

      switch (desired) {
        case "final": {
          const result = this.playMatch(a, b, row.bestOf);
          const finalizedAt = startedAt + (38 + 14 * (result.sets.length - 2)) * MINUTE + this.rng.int(0, 6) * MINUTE;
          row.winnerTeamId = result.winner === "a" ? a.row.id : b.row.id;
          this.recordAgreedResult(row, a, b, result.sets, finalizedAt);
          advance(m, result.winner === "a" ? a : b, finalizedAt);
          break;
        }
        case "disputed": {
          // Two captains, two different set-3 totals. Everything else agrees.
          const result = this.playMatch(a, b, "3");
          if (result.sets.length < 3) {
            // Force a deciding set so the disagreement lives in set 3, where it is easiest to see.
            result.sets.length = 0;
            result.sets.push(
              { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
              { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
              { setNumber: 3, teamAPoints: 15, teamBPoints: 13 },
            );
          }
          const viewA: Scoreline = { matchId: row.id, sets: result.sets };
          const third = result.sets[2];
          if (!third) throw new Error("seed: disputed match needs three sets");
          const loserPoints = Math.min(third.teamAPoints, third.teamBPoints);
          const altLoser = loserPoints >= 2 ? loserPoints - 2 : loserPoints + 2;
          const altWin = altLoser >= DECIDING_SET_TARGET - 1 ? altLoser + 2 : DECIDING_SET_TARGET;
          const viewB: Scoreline = {
            matchId: row.id,
            sets: result.sets.map((s) =>
              s.setNumber === 3
                ? {
                    setNumber: 3,
                    teamAPoints: s.teamAPoints > s.teamBPoints ? altWin : altLoser,
                    teamBPoints: s.teamBPoints > s.teamAPoints ? altWin : altLoser,
                  }
                : s,
            ),
          };
          const verdictB = judgeMatch(viewB.sets, "3");
          if (!verdictB.legal) throw new Error(`seed: disputed alternate scoreline is illegal: ${verdictB.reason}`);
          const endedAt = startedAt + 52 * MINUTE;
          const firstAt = endedAt + 3 * MINUTE;
          const secondAt = endedAt + 6 * MINUTE;
          const consensus = this.openConsensus(row, startedAt);
          const subA = this.firstSubmission(row, consensus, a, viewA, "a", firstAt);
          const subB = this.submission(row, b, viewB, "b", secondAt);
          if (subA.payloadHash === subB.payloadHash) throw new Error("seed: disputed submissions must differ");
          const reason = describeDifferences(diffScorelines(viewA.sets, viewB.sets));
          this.consensusTransition(consensus, "disputed", { kind: "player", userId: subB.submittedByUserId }, secondAt, {
            event: "conflicting_submission",
            reason,
            hashes: [subA.payloadHash, subB.payloadHash],
          });
          consensus.disputedReason = reason;
          this.matchTransition(row, "disputed", { kind: "system", userId: null }, secondAt, { consensusId: consensus.id, reason });
          break;
        }
        case "awaiting_scores": {
          const result = this.playMatch(a, b, "3");
          const endedAt = startedAt + 44 * MINUTE;
          const consensus = this.openConsensus(row, startedAt);
          this.firstSubmission(row, consensus, a, { matchId: row.id, sets: result.sets }, "a", endedAt + 2 * MINUTE);
          break;
        }
        case "in_progress": {
          // Set 1 complete, set 2 under way. Provisional (agreed = false) until
          // both teams confirm through consensus; the live strip reads these.
          const first = this.playSet(a, b, SET_TARGET);
          this.data.sets.push({
            id: this.id(startedAt + 24 * MINUTE),
            matchId: row.id,
            setNumber: 1,
            teamAPoints: first.a,
            teamBPoints: first.b,
            agreed: false,
          });
          const liveA = this.rng.int(9, 16);
          const liveB = Math.max(0, liveA - this.rng.int(1, 5));
          this.data.sets.push({
            id: this.id(startedAt + 36 * MINUTE),
            matchId: row.id,
            setNumber: 2,
            teamAPoints: first.winner === "a" ? liveB : liveA,
            teamBPoints: first.winner === "a" ? liveA : liveB,
            agreed: false,
          });
          this.openConsensus(row, startedAt);
          break;
        }
        case "bye":
        case "forfeited":
          throw new Error(`seed: unsupported planned status ${desired}`);
      }
    }
  }

  /** Push the drawn match rows into the dataset in schedule order. */
  commitMatches(drawn: DrawnEvent): void {
    this.data.matches.push(
      ...[...drawn.matchRows.values()].sort(
        (x, y) => (x.scheduledAt ?? 0) - (y.scheduledAt ?? 0) || (x.bracketPosition ?? 0) - (y.bracketPosition ?? 0) || x.id.localeCompare(y.id),
      ),
    );
  }

  // -- money ----------------------------------------------------------------

  entryDonations(t: NewTournament, teams: readonly SeedTeam[], status: NewDonation["status"] = "succeeded"): void {
    for (const team of teams) {
      const at = team.row.createdAt + this.rng.int(1, 20) * MINUTE;
      this.data.donations.push({
        id: this.id(at),
        tournamentId: t.id,
        teamId: team.row.id,
        userId: team.members[0].row.id,
        amountCents: t.entryDonationCents,
        currency: CURRENCY,
        provider: "stub",
        providerRef: this.opaqueRef("stub"),
        status: team.row.status === "withdrawn" ? "refunded" : status,
        createdAt: at,
      });
    }
  }

  /**
   * Individual gifts from players and anonymous supporters. Keeps adding until the
   * succeeded total lands inside [minFraction, maxFraction] of the goal.
   */
  supporterDonations(
    t: NewTournament,
    users: readonly SeedUser[],
    window: { from: number; to: number },
    target: { minFraction: number; maxFraction: number },
  ): void {
    const succeededSoFar = () =>
      this.data.donations
        .filter((d) => d.tournamentId === t.id && d.status === "succeeded")
        .reduce((sum, d) => sum + d.amountCents, 0);
    const goal = t.fundraisingGoalCents;
    const floor = Math.round(goal * target.minFraction);
    const ceiling = Math.round(goal * target.maxFraction);
    const amounts = [1000, 1500, 2000, 2500, 2500, 5000, 5000, 5000, 7500, 10000, 10000, 15000, 25000];
    let guard = 0;
    // A few non-succeeded rows so every status is represented without touching the total.
    const offStatuses: NewDonation["status"][] = ["pending", "failed", "refunded"];
    let offIdx = 0;

    while (succeededSoFar() < floor && guard < 200) {
      guard += 1;
      const remaining = floor - succeededSoFar();
      const candidates = amounts.filter((a) => succeededSoFar() + a <= ceiling);
      const amount = candidates.length ? this.rng.pick(candidates) : Math.min(remaining, 2500);
      if (amount <= 0) break;
      const at = this.rng.int(window.from, window.to);
      const anonymous = this.rng.chance(0.3);
      const user = anonymous ? null : this.rng.pick(users);
      const status: NewDonation["status"] = guard % 9 === 0 ? (offStatuses[offIdx++ % offStatuses.length] ?? "pending") : "succeeded";
      this.data.donations.push({
        id: this.id(at),
        tournamentId: t.id,
        teamId: null,
        userId: user?.row.id ?? null,
        amountCents: amount,
        currency: CURRENCY,
        provider: "stub",
        providerRef: this.opaqueRef("stub"),
        status,
        createdAt: at,
      });
    }
  }

  sponsor(t: NewTournament, name: string, tier: NewSponsor["tier"], prizeContributionCents: number): NewSponsor {
    const row: NewSponsor = {
      id: this.id(t.createdAt + 3 * DAY),
      tournamentId: t.id,
      name,
      logoUrl: null,
      tier,
      prizeContributionCents,
      currency: CURRENCY,
    };
    this.data.sponsors.push(row);
    return row;
  }
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

export function buildSeed(options: SeedOptions): SeedDataset {
  const b = new SeedBuilder(options.anchorMs, options.rngSeed ?? DEFAULT_RNG_SEED);
  const anchor = options.anchorMs;

  const charity = b.buildCharity();
  const users = b.buildUsers();
  const [organizer, coOrganizer] = b.buildOrganizers();
  if (!organizer || !coOrganizer) throw new Error("seed: organizers missing");

  // ---- Low Tide Open — settled six weeks ago -------------------------------
  {
    const day = anchor - 45 * DAY;
    const createdAt = day - 70 * DAY;
    const t = b.tournament({
      slug: SLUGS.settled,
      name: "Low Tide Open",
      subtitle: "Coed doubles on the Hermosa strand",
      beneficiaryId: charity.id,
      venueName: "Hermosa Pier Courts",
      venueCity: "Hermosa Beach",
      venueState: "CA",
      startsAt: day + 8 * HOUR,
      endsAt: day + 17 * HOUR,
      format: "pool_to_bracket",
      division: "coed",
      maxTeams: 16,
      entryDonationCents: 7500,
      fundraisingGoalCents: 500000,
      prizeKind: "free_to_play_rewards",
      status: "settled",
      lucraMatchupId: null,
      createdAt,
    });
    b.tournamentTransitions(t, coOrganizer, [
      ["draft", "registration_open", createdAt + 2 * DAY],
      ["registration_open", "registration_closed", day - 2 * DAY],
      ["registration_closed", "live", day + 8 * HOUR],
      ["live", "awaiting_settlement", day + 16 * HOUR + 40 * MINUTE],
      ["awaiting_settlement", "settled", day + 2 * DAY + 11 * HOUR],
    ]);

    const idx = b.rng.shuffle(users.map((_, i) => i)).slice(0, 32);
    const pairs: Array<readonly [number, number]> = [];
    for (let i = 0; i < 32; i += 2) pairs.push([idx[i] ?? 0, idx[i + 1] ?? 1]);
    const teams = b.buildTeams(t, users, pairs, {
      status: "checked_in",
      registeredFrom: createdAt + 3 * DAY,
      registeredTo: day - 3 * DAY,
    });
    const teamsById = new Map(teams.map((x) => [x.row.id, x]));
    const drawn = b.drawEvent(t, coOrganizer, teams, SEED_DRAWS.settled, day - 2 * DAY + 3 * HOUR);
    const results = b.playPools(drawn, organizer, teamsById);
    const lastPool = Math.max(...[...drawn.matchRows.values()].map((m) => m.finalizedAt ?? 0));
    b.seedBracketFromPools(t, drawn, results, SEED_DRAWS.settled, teamsById, lastPool + 5 * MINUTE);
    b.playBracket(drawn, organizer, { 1: "final", 2: "final", 3: "final", 4: "final", 5: "final", 6: "final", 7: "final" }, teamsById);
    b.commitMatches(drawn);
    // Every agreed result was written to Lucra as it was agreed. One pool match hit a
    // Lucra outage (503s through every retry) and one quarterfinal was written before
    // the matchup existed in Lucra ("Matchup not found"); both were retried and landed.
    {
      const finals = b.data.matches.filter((m) => m.tournamentId === t.id && m.status === "final").sort((x, y) => (x.finalizedAt ?? 0) - (y.finalizedAt ?? 0));
      const outage = finals[3];
      const early = finals.find((m) => m.bracketPosition === 1);
      const failures = new Map<string, SeededLucraAttempt>();
      if (outage) failures.set(outage.id, { outcome: "transport_error", httpStatus: 503 });
      if (early) failures.set(early.id, { outcome: "rejected", error: LUCRA_ERROR_BODIES.matchupNotFound, httpStatus: 404 });
      b.writeAgreedToLucra(t, failures);
    }

    const northline = b.sponsor(t, "Northline Boardworks", "presenting", 150000);
    b.sponsor(t, "Dune & Co. Eyewear", "prize", 50000);
    b.entryDonations(t, teams);
    b.supporterDonations(t, users, { from: createdAt + 3 * DAY, to: day + 16 * HOUR }, { minFraction: 1.04, maxFraction: 1.12 });

    // Placements follow from the bracket: final winner, final loser, both semifinal losers.
    const finalMatch = b.data.matches.find((m) => m.tournamentId === t.id && m.bracketPosition === 7);
    const semis = b.data.matches.filter((m) => m.tournamentId === t.id && (m.bracketPosition === 5 || m.bracketPosition === 6));
    if (!finalMatch?.winnerTeamId || !finalMatch.teamAId || !finalMatch.teamBId) throw new Error("seed: settled final missing");
    const champion = finalMatch.winnerTeamId;
    const runnerUp = finalMatch.teamAId === champion ? finalMatch.teamBId : finalMatch.teamAId;
    const thirds = semis.map((m) => (m.teamAId === m.winnerTeamId ? m.teamBId : m.teamAId)).filter((x): x is string => Boolean(x));
    const awardedAt = day + 2 * DAY + 11 * HOUR;
    const rewardRows: NewReward[] = [
      {
        id: b.id(awardedAt),
        tournamentId: t.id,
        teamId: champion,
        placement: 1,
        kind: "lucra_reward",
        amountCents: 75000,
        currency: CURRENCY,
        description: `Champions — ${northline.name} prize pool`,
        lucraRewardRef: null,
        status: "claimed",
      },
      {
        id: b.id(awardedAt + 1),
        tournamentId: t.id,
        teamId: runnerUp,
        placement: 2,
        kind: "lucra_reward",
        amountCents: 40000,
        currency: CURRENCY,
        description: `Finalists — ${northline.name} prize pool`,
        lucraRewardRef: null,
        status: "awarded",
      },
      ...thirds.map(
        (teamId, i): NewReward => ({
          id: b.id(awardedAt + 2 + i),
          tournamentId: t.id,
          teamId,
          placement: 3,
          kind: "sponsor_item",
          amountCents: null,
          currency: null,
          description: "Semifinalists — Dune & Co. polarized eyewear, one pair per player",
          lucraRewardRef: null,
          status: i === 0 ? "claimed" : "awarded",
        }),
      ),
    ];
    b.data.rewards.push(...rewardRows);
    for (const r of rewardRows) {
      b.audit({
        actorUserId: coOrganizer.id,
        actorKind: "organizer",
        action: "reward.awarded",
        subjectType: "reward",
        subjectId: r.id,
        detailJson: JSON.stringify({ teamId: r.teamId, placement: r.placement, amountCents: r.amountCents }),
        createdAt: awardedAt,
      });
    }
  }

  // ---- Sandbar Classic — live today -----------------------------------------
  {
    const day = anchor;
    const createdAt = day - 75 * DAY;
    const t = b.tournament({
      slug: SLUGS.live,
      name: "Sandbar Classic",
      subtitle: "Open doubles · 24 teams · six courts on the sand",
      beneficiaryId: charity.id,
      venueName: "Huntington State Beach Courts",
      venueCity: "Huntington Beach",
      venueState: "CA",
      startsAt: day + 8 * HOUR,
      endsAt: day + 18 * HOUR,
      format: "pool_to_bracket",
      division: "open",
      maxTeams: 24,
      entryDonationCents: 7500,
      fundraisingGoalCents: 750000,
      prizeKind: "free_to_play_rewards",
      status: "live",
      lucraMatchupId: null,
      createdAt,
    });
    b.tournamentTransitions(t, organizer, [
      ["draft", "registration_open", createdAt + 1 * DAY],
      ["registration_open", "registration_closed", day - 1 * DAY],
      ["registration_closed", "live", day + 8 * HOUR],
    ]);

    const idx = b.rng.shuffle(users.map((_, i) => i));
    const pairs: Array<readonly [number, number]> = [];
    for (let i = 0; i < 48; i += 2) pairs.push([idx[i] ?? 0, idx[i + 1] ?? 1]);
    const teams = b.buildTeams(t, users, pairs, {
      status: "checked_in",
      registeredFrom: createdAt + 1 * DAY,
      registeredTo: day - 2 * DAY,
    });
    const teamsById = new Map(teams.map((x) => [x.row.id, x]));
    const drawn = b.drawEvent(t, organizer, teams, SEED_DRAWS.live, day - 1 * DAY + 2 * HOUR);
    const results = b.playPools(drawn, organizer, teamsById);
    const lastPool = Math.max(...[...drawn.matchRows.values()].map((m) => m.finalizedAt ?? 0));
    b.seedBracketFromPools(t, drawn, results, SEED_DRAWS.live, teamsById, lastPool + 5 * MINUTE);
    // Position 1 is the top seed's bye (engine-made). Round of 16 done, quarters
    // mid-way, one semifinal on the sand.
    b.playBracket(
      drawn,
      organizer,
      {
        2: "final",
        3: "final",
        4: "final",
        5: "final",
        6: "final",
        7: "final",
        8: "final",
        9: "final",
        10: "final",
        11: "disputed",
        12: "awaiting_scores",
        13: "in_progress",
      },
      teamsById,
    );
    b.commitMatches(drawn);
    // Written as agreed, including the two finished quarterfinals; Lucra reported the
    // matchup as failed on quarterfinal 10's first attempt (a partial), retried and accepted.
    {
      const ten = b.data.matches.find((m) => m.tournamentId === t.id && m.bracketPosition === 10);
      const failures = new Map<string, SeededLucraAttempt>();
      if (ten) failures.set(ten.id, { outcome: "partial" });
      b.writeAgreedToLucra(t, failures);
    }

    b.sponsor(t, "Northline Boardworks", "presenting", 250000);
    b.sponsor(t, "Saltwater Coffee Roasters", "court", 75000);
    b.sponsor(t, "Kinetic Sports Nutrition", "prize", 100000);
    b.entryDonations(t, teams);
    b.supporterDonations(t, users, { from: createdAt + 2 * DAY, to: day + 14 * HOUR }, { minFraction: 0.58, maxFraction: 0.72 });
  }

  // ---- Pier 9 Open — registration open, 40% full ----------------------------
  {
    const day = anchor + 38 * DAY;
    const createdAt = anchor - 12 * DAY;
    const t = b.tournament({
      slug: SLUGS.upcoming,
      name: "Pier 9 Open",
      subtitle: "Coed doubles under the pier lights",
      beneficiaryId: charity.id,
      venueName: "Santa Monica Pier Courts",
      venueCity: "Santa Monica",
      venueState: "CA",
      startsAt: day + 9 * HOUR,
      endsAt: day + 18 * HOUR,
      format: "pool_to_bracket",
      division: "coed",
      maxTeams: 20,
      entryDonationCents: 7500,
      fundraisingGoalCents: 600000,
      prizeKind: "free_to_play_rewards",
      status: "registration_open",
      lucraMatchupId: null,
      createdAt,
    });
    b.tournamentTransitions(t, organizer, [["draft", "registration_open", createdAt + 1 * DAY]]);

    const idx = b.rng.shuffle(users.map((_, i) => i));
    const pairs: Array<readonly [number, number]> = [];
    for (let i = 0; i < 18; i += 2) pairs.push([idx[i] ?? 0, idx[i + 1] ?? 1]);
    const teams = b.buildTeams(t, users, pairs, {
      status: "registered",
      registeredFrom: createdAt + 1 * DAY,
      registeredTo: anchor - 1 * HOUR,
    });
    // One pair withdrew; their entry donation is refunded and they do not count toward capacity.
    const withdrawn = teams[teams.length - 1];
    if (withdrawn) withdrawn.row.status = "withdrawn";
    // One team is still forming: captain in, partner invited by phone, no donation yet.
    const captain = users[idx[18] ?? 0];
    const invitee = users[idx[19] ?? 1];
    if (!captain || !invitee) throw new Error("seed: forming team needs two spare players");
    b.buildFormingTeam(t, captain, invitee, `${surname(captain.row.displayName)} / TBD`, anchor - 3 * HOUR);
    // One more team is complete (partner accepted an hour ago) and has not registered
    // yet: the demo's registrant (`src/seed/demo.ts`) walks it through the two steps.
    const readyCaptain = users[idx[20] ?? 0];
    const readyPartner = users[idx[21] ?? 1];
    if (!readyCaptain || !readyPartner) throw new Error("seed: ready team needs two spare players");
    b.buildFormingTeam(t, readyCaptain, readyPartner, pairName(readyCaptain.row.displayName, readyPartner.row.displayName), anchor - 1 * HOUR, { accepted: true });
    b.sponsor(t, "Saltwater Coffee Roasters", "court", 50000);
    b.entryDonations(t, teams);
    b.supporterDonations(t, users, { from: createdAt + 2 * DAY, to: anchor - 1 * HOUR }, { minFraction: 0.14, maxFraction: 0.2 });
  }

  return b.data;
}

/** Midnight (00:00) of the current calendar day in `timeZone`, as epoch ms. */
export function startOfTodayIn(timeZone: string, nowMs: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Local wall-clock components reinterpreted as UTC, then shifted by the zone offset.
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = localAsUtc - Math.floor(nowMs / 1000) * 1000;
  const midnightLocalAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"));
  return midnightLocalAsUtc - offset;
}
