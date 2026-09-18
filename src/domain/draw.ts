import { z } from "zod";
import { BEST_OF, type BestOf, type MatchSlot, type TournamentFormat } from "@/db/schema";
import { compareAcrossPools, type StandingRow } from "@/domain/standings";
import type { Rng } from "@/lib/rng";

/**
 * Draw engine (spec §16 phase 2). Pure and deterministic: the only sources of
 * variation are the injected `Rng` (ordering of unseeded teams) and the inputs.
 * Nothing here knows about the database; the plan uses local string keys and
 * the service layer (`@/server/draw`) mints ids and writes rows.
 *
 * Formats:
 * - `pool_to_bracket` — balanced pools by snake seeding, a round-robin schedule
 *   per pool, and a single-elimination bracket skeleton sized by the
 *   advancement rule. The bracket's first round is filled later, from pool
 *   standings, by `seedBracketSlots` (see `selectAdvancing`).
 * - `single_elim` — a bracket seeded directly from the entry order.
 * - `round_robin` — one pool of everyone.
 * - `double_elim` — in the schema enum, not drawable yet; `draw` refuses it with
 *   `unsupported_format` (follow-up listed in docs/open-questions.md).
 *
 * Byes exist only in round 1 and only when the bracket size is not a power of
 * two; a bye auto-advances the present team into round 2 at seeding time.
 */

export const DRAW_ERROR_CODES = [
  "unsupported_format",
  "too_few_teams",
  "duplicate_team",
  "bad_seed",
  "bad_option",
  "bad_advancement",
  "bracket_mismatch",
] as const;
export type DrawErrorCode = (typeof DRAW_ERROR_CODES)[number];

export class DrawError extends Error {
  constructor(
    readonly code: DrawErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DrawError";
  }
}

export interface DrawTeam {
  id: string;
  /** Organizer-assigned entry seed, 1 = strongest; null for unseeded. */
  seed: number | null;
}

/** Top `perPool` from each pool, then the `bestRemaining` next-placed teams by standings. */
export interface AdvancementRule {
  perPool: number;
  bestRemaining: number;
}

/**
 * Everything a pools-stage draw was configured with, minus the entrants and the
 * format (which live on their own rows). Persisted as
 * `tournaments.draw_config_json` so the bracket stage applies the advancement
 * rule that sized the bracket and a preview can be reproduced from `rngSeed`.
 */
export const drawConfigSchema = z.object({
  courts: z.number().int().min(1),
  /** Target pool size for pool_to_bracket; pools differ in size by at most one. */
  poolSize: z.number().int().min(2),
  advance: z.object({ perPool: z.number().int().min(0), bestRemaining: z.number().int().min(0) }),
  poolBestOf: z.enum(BEST_OF),
  bracketBestOf: z.enum(BEST_OF),
  schedule: z.object({
    /** When the first round (pool play, or the bracket for single_elim) starts. */
    startsAt: z.number().int(),
    /** Court slot length for a pool match, including changeover. */
    poolMatchMinutes: z.number().int().min(1),
    /** Court slot length for a bracket match. */
    bracketMatchMinutes: z.number().int().min(1),
    /** Rest between pool play and the bracket, and between bracket rounds. */
    restMinutes: z.number().int().min(0),
  }),
  rngSeed: z.number().int().min(0),
});
export type DrawConfig = z.infer<typeof drawConfigSchema>;
export type DrawSchedule = DrawConfig["schedule"];

export interface DrawOptions extends Omit<DrawConfig, "rngSeed"> {
  format: TournamentFormat;
  teams: readonly DrawTeam[];
  rng: Rng;
}

export interface DrawPool {
  key: string;
  label: string;
  /** Display label: "Court 3" or "Courts 1, 4". */
  courtLabel: string;
  courts: string[];
  teamIds: string[];
}

export interface DrawMatch {
  key: string;
  poolKey: string | null;
  round: number;
  bracketPosition: number | null;
  courtLabel: string | null;
  teamAId: string | null;
  teamBId: string | null;
  bestOf: BestOf;
  status: "scheduled" | "bye";
  winnerTeamId: string | null;
  nextMatchKey: string | null;
  nextMatchSlot: MatchSlot | null;
  scheduledAt: number | null;
}

export interface BracketShape {
  size: number;
  rounds: number;
  advancing: number;
}

export interface DrawPlan {
  format: TournamentFormat;
  /** Entry order: seeded teams by seed, then unseeded teams in rng order. */
  order: string[];
  pools: DrawPool[];
  matches: DrawMatch[];
  /**
   * Bracket order this draw placed into round 1 (single_elim: the entry order;
   * pool_to_bracket: empty until the bracket stage ranks the pools). Recorded
   * on the bracket slots only; `teams.seed` stays the organizer's entry seed.
   */
  seeds: Array<{ teamId: string; seed: number }>;
  bracket: BracketShape | null;
}

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Ordering and pools
// ---------------------------------------------------------------------------

/** Seeded teams first by seed, then the rest in rng order. */
export function orderTeams(teams: readonly DrawTeam[], rng: Rng): string[] {
  const ids = new Set<string>();
  const seeds = new Set<number>();
  for (const t of teams) {
    if (ids.has(t.id)) throw new DrawError("duplicate_team", `Team ${t.id} appears twice.`);
    ids.add(t.id);
    if (t.seed !== null) {
      if (!Number.isInteger(t.seed) || t.seed < 1) throw new DrawError("bad_seed", `Seed ${t.seed} for team ${t.id} is not a positive integer.`);
      if (seeds.has(t.seed)) throw new DrawError("bad_seed", `Seed ${t.seed} is assigned twice.`);
      seeds.add(t.seed);
    }
  }
  const seeded = teams.filter((t): t is DrawTeam & { seed: number } => t.seed !== null).sort((x, y) => x.seed - y.seed);
  const unseeded = rng.shuffle(teams.filter((t) => t.seed === null));
  return [...seeded, ...unseeded].map((t) => t.id);
}

/** Pools as close to `poolSize` as possible, never fewer than two teams each. */
export function poolCountFor(teamCount: number, poolSize: number): number {
  if (!Number.isInteger(poolSize) || poolSize < 2) throw new DrawError("bad_option", `Pool size must be an integer of at least 2; got ${poolSize}.`);
  const byTarget = Math.max(1, Math.round(teamCount / poolSize));
  return Math.min(byTarget, Math.floor(teamCount / 2)) || 1;
}

/**
 * Snake seeding: the ordered list is dealt into pools left-to-right, then
 * right-to-left, so pool strength stays balanced and sizes differ by at most one.
 */
export function snakePools(orderedIds: readonly string[], poolCount: number): string[][] {
  if (!Number.isInteger(poolCount) || poolCount < 1) throw new DrawError("bad_option", `Pool count must be at least 1; got ${poolCount}.`);
  const pools: string[][] = Array.from({ length: poolCount }, () => []);
  orderedIds.forEach((id, i) => {
    const pass = Math.floor(i / poolCount);
    const col = i % poolCount;
    const target = pass % 2 === 0 ? col : poolCount - 1 - col;
    pools[target]?.push(id);
  });
  return pools;
}

/**
 * Circle-method round robin: every pair meets exactly once. Odd sizes get a
 * phantom slot whose opponent rests that round. Returns rounds of index pairs.
 */
export function roundRobinRounds(size: number): Array<Array<[number, number]>> {
  if (size < 2) return [];
  const slots: Array<number | null> = Array.from({ length: size }, (_, i) => i);
  if (size % 2 === 1) slots.push(null);
  const n = slots.length;
  const rounds: Array<Array<[number, number]>> = [];
  for (let r = 0; r < n - 1; r += 1) {
    const round: Array<[number, number]> = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = slots[i];
      const b = slots[n - 1 - i];
      if (a === null || b === null || a === undefined || b === undefined) continue;
      round.push([a, b]);
    }
    rounds.push(round);
    // Keep slot 0 fixed; rotate the rest one step clockwise.
    const fixed = slots[0];
    const rest = slots.slice(1);
    const last = rest.pop();
    slots.splice(0, slots.length, fixed ?? null, ...(last === undefined ? [] : [last]), ...rest);
  }
  return rounds;
}

export function poolLabel(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Pool ${s}`;
}

function courtName(n: number): string {
  return `Court ${n}`;
}

function courtsLabel(courts: readonly string[]): string {
  if (courts.length === 1) return courts[0] ?? "";
  return `Courts ${courts.map((c) => c.replace(/^Court /, "")).join(", ")}`;
}

// ---------------------------------------------------------------------------
// Bracket
// ---------------------------------------------------------------------------

export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/**
 * Standard placement for a bracket of `size` (a power of two): seed 1 meets
 * seed `size`, seeds 1 and 2 sit in opposite halves, 1–4 in separate quarters,
 * and so on. Built recursively: each seed of the half-size bracket becomes the
 * pair (s, size + 1 − s).
 */
export function bracketSeedOrder(size: number): number[] {
  if (size < 2 || (size & (size - 1)) !== 0) throw new DrawError("bad_option", `Bracket size must be a power of two ≥ 2; got ${size}.`);
  let order = [1, 2];
  while (order.length < size) {
    const doubled = order.length * 2;
    order = order.flatMap((s) => [s, doubled + 1 - s]);
  }
  return order;
}

export interface BracketSlot {
  key: string;
  round: number;
  bracketPosition: number;
  teamAId: string | null;
  teamBId: string | null;
  status: string;
  nextMatchKey: string | null;
  nextMatchSlot: MatchSlot | null;
}

export interface BracketPatch {
  key: string;
  teamAId: string | null;
  teamBId: string | null;
  status: "scheduled" | "bye";
  winnerTeamId: string | null;
}

/**
 * Fill round 1 of an empty bracket from an ordered seed list (index 0 = seed 1).
 * Byes appear only where the seed list is shorter than the bracket, and the
 * present team is advanced into its round-2 slot immediately.
 */
export function seedBracketSlots(slots: readonly BracketSlot[], seedOrder: readonly string[]): BracketPatch[] {
  const first = slots.filter((s) => s.round === 1).sort((x, y) => x.bracketPosition - y.bracketPosition);
  const size = first.length * 2;
  if (first.length === 0) throw new DrawError("bracket_mismatch", "The bracket has no first round.");
  if (seedOrder.length < 2) throw new DrawError("too_few_teams", "A bracket needs at least two teams.");
  if (seedOrder.length > size || seedOrder.length <= size / 2) {
    throw new DrawError("bracket_mismatch", `A ${size}-slot bracket seats ${size / 2 + 1}–${size} teams; got ${seedOrder.length}.`);
  }
  if (new Set(seedOrder).size !== seedOrder.length) throw new DrawError("duplicate_team", "A team cannot hold two seeds.");
  for (const slot of first) {
    if (slot.teamAId !== null || slot.teamBId !== null || slot.status !== "scheduled") {
      throw new DrawError("bracket_mismatch", `Bracket position ${slot.bracketPosition} is already seeded.`);
    }
  }

  const byKey = new Map(slots.map((s) => [s.key, s]));
  const patches = new Map<string, BracketPatch>();
  const patchFor = (slot: BracketSlot): BracketPatch => {
    const existing = patches.get(slot.key);
    if (existing) return existing;
    const created: BracketPatch = {
      key: slot.key,
      teamAId: slot.teamAId,
      teamBId: slot.teamBId,
      status: slot.status === "bye" ? "bye" : "scheduled",
      winnerTeamId: null,
    };
    patches.set(slot.key, created);
    return created;
  };

  const order = bracketSeedOrder(size);
  first.forEach((slot, i) => {
    const a = seedOrder[(order[i * 2] ?? 0) - 1] ?? null;
    const b = seedOrder[(order[i * 2 + 1] ?? 0) - 1] ?? null;
    const patch = patchFor(slot);
    patch.teamAId = a;
    patch.teamBId = b;
    if (a && b) return;
    const present = a ?? b;
    if (!present) throw new DrawError("bracket_mismatch", `Bracket position ${slot.bracketPosition} would have no teams.`);
    patch.teamAId = present;
    patch.teamBId = null;
    patch.status = "bye";
    patch.winnerTeamId = present;
    if (slot.nextMatchKey && slot.nextMatchSlot) {
      const next = byKey.get(slot.nextMatchKey);
      if (!next) throw new DrawError("bracket_mismatch", `Bracket position ${slot.bracketPosition} advances to an unknown match.`);
      const nextPatch = patchFor(next);
      if (slot.nextMatchSlot === "a") nextPatch.teamAId = present;
      else nextPatch.teamBId = present;
    }
  });
  return [...patches.values()];
}

/**
 * Advancing teams in seed order: the pool winners ranked against each other,
 * then the runners-up, and so on for `perPool` places; then the best
 * `bestRemaining` of the next place across pools (then the place after, if
 * that runs out). Cross-pool ranking is per match played
 * (`compareAcrossPools`), since pools can differ in size by one and teams
 * from different pools have not met.
 */
export function selectAdvancing(pools: ReadonlyArray<{ rows: readonly StandingRow[] }>, rule: AdvancementRule): string[] {
  validateAdvancement(rule);
  const byPlace: StandingRow[][] = [];
  for (const pool of pools) {
    pool.rows.forEach((row, place) => {
      (byPlace[place] ??= []).push(row);
    });
  }
  const out: string[] = [];
  for (let place = 0; place < rule.perPool; place += 1) {
    const group = byPlace[place];
    if (!group || group.length < pools.length) {
      throw new DrawError("bad_advancement", `Every pool needs at least ${rule.perPool} teams to advance ${rule.perPool} per pool.`);
    }
    out.push(...[...group].sort(compareAcrossPools).map((r) => r.teamId));
  }
  let remaining = rule.bestRemaining;
  for (let place = rule.perPool; remaining > 0 && place < byPlace.length; place += 1) {
    const group = [...(byPlace[place] ?? [])].sort(compareAcrossPools);
    const take = group.slice(0, remaining);
    out.push(...take.map((r) => r.teamId));
    remaining -= take.length;
  }
  if (remaining > 0) throw new DrawError("bad_advancement", `Not enough teams to advance ${rule.perPool} per pool plus ${rule.bestRemaining}.`);
  return out;
}

function validateAdvancement(rule: AdvancementRule): void {
  if (!Number.isInteger(rule.perPool) || rule.perPool < 0) throw new DrawError("bad_advancement", "perPool must be a non-negative integer.");
  if (!Number.isInteger(rule.bestRemaining) || rule.bestRemaining < 0) throw new DrawError("bad_advancement", "bestRemaining must be a non-negative integer.");
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

export function draw(options: DrawOptions): DrawPlan {
  validateOptions(options);
  const order = orderTeams(options.teams, options.rng);

  switch (options.format) {
    case "double_elim":
      throw new DrawError("unsupported_format", "Double elimination is not drawable yet; use pool_to_bracket, single_elim, or round_robin.");
    case "round_robin":
      return drawRoundRobin(order, options);
    case "single_elim":
      return drawSingleElimination(order, options);
    case "pool_to_bracket":
      return drawPoolToBracket(order, options);
  }
}

function validateOptions(options: DrawOptions): void {
  if (options.teams.length < 2) throw new DrawError("too_few_teams", `A draw needs at least two teams; got ${options.teams.length}.`);
  if (!Number.isInteger(options.courts) || options.courts < 1) throw new DrawError("bad_option", `Courts must be an integer of at least 1; got ${options.courts}.`);
  const s = options.schedule;
  for (const [name, value] of [
    ["poolMatchMinutes", s.poolMatchMinutes],
    ["bracketMatchMinutes", s.bracketMatchMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new DrawError("bad_option", `${name} must be a positive integer number of minutes.`);
  }
  if (!Number.isInteger(s.restMinutes) || s.restMinutes < 0) throw new DrawError("bad_option", "restMinutes must be a non-negative integer.");
  if (!Number.isFinite(s.startsAt)) throw new DrawError("bad_option", "startsAt must be a timestamp.");
}

interface PoolScheduleResult {
  pools: DrawPool[];
  matches: DrawMatch[];
  /** Start of the latest pool match, or null when there are none. */
  lastStartsAt: number | null;
}

/**
 * Court and time assignment for pools. Each pool owns one or more courts when
 * there are at least as many courts as pools; otherwise pools share courts in
 * shifts. Rounds are aligned across pools so "round r" starts together.
 */
function schedulePools(groups: readonly string[][], labels: readonly string[], options: DrawOptions): PoolScheduleResult {
  const { courts, schedule } = options;
  const poolCount = groups.length;
  const courtsFor = (p: number): string[] => {
    if (courts >= poolCount) {
      const mine: string[] = [];
      for (let c = 0; c < courts; c += 1) if (c % poolCount === p) mine.push(courtName(c + 1));
      return mine;
    }
    return [courtName((p % courts) + 1)];
  };
  const rounds = groups.map((g) => roundRobinRounds(g.length));
  const maxRounds = Math.max(0, ...rounds.map((r) => r.length));
  const wavesPerRound = groups.map((g, p) => {
    const perRound = Math.floor(g.length / 2);
    return Math.ceil(perRound / courtsFor(p).length);
  });
  const roundMinutes = Math.max(1, ...wavesPerRound) * schedule.poolMatchMinutes;

  const pools: DrawPool[] = [];
  const matches: DrawMatch[] = [];
  let lastStartsAt: number | null = null;
  groups.forEach((teamIds, p) => {
    const key = `pool:${p}`;
    const poolCourts = courtsFor(p);
    pools.push({ key, label: labels[p] ?? poolLabel(p), courtLabel: courtsLabel(poolCourts), courts: poolCourts, teamIds: [...teamIds] });
    const shift = courts >= poolCount ? 0 : Math.floor(p / courts);
    rounds[p]?.forEach((round, r) => {
      const roundStart = schedule.startsAt + (shift * maxRounds + r) * roundMinutes * MINUTE;
      round.forEach(([ia, ib], m) => {
        const wave = Math.floor(m / poolCourts.length);
        const scheduledAt = roundStart + wave * schedule.poolMatchMinutes * MINUTE;
        lastStartsAt = lastStartsAt === null ? scheduledAt : Math.max(lastStartsAt, scheduledAt);
        matches.push({
          key: `${key}:r${r + 1}:m${m + 1}`,
          poolKey: key,
          round: r + 1,
          bracketPosition: null,
          courtLabel: poolCourts[m % poolCourts.length] ?? null,
          teamAId: teamIds[ia] ?? null,
          teamBId: teamIds[ib] ?? null,
          bestOf: options.poolBestOf,
          status: "scheduled",
          winnerTeamId: null,
          nextMatchKey: null,
          nextMatchSlot: null,
          scheduledAt,
        });
      });
    });
  });
  return { pools, matches, lastStartsAt };
}

/** Empty bracket of `size` slots: positions numbered breadth-first from round 1, next links wired. */
function bracketSkeleton(size: number, startsAt: number, options: DrawOptions): { matches: DrawMatch[]; shape: Omit<BracketShape, "advancing"> } {
  const rounds = Math.log2(size);
  const matches: DrawMatch[] = [];
  const byRound: DrawMatch[][] = [];
  let position = 1;
  let roundStart = startsAt;
  for (let r = 1; r <= rounds; r += 1) {
    const count = size / 2 ** r;
    const round: DrawMatch[] = [];
    for (let i = 0; i < count; i += 1) {
      const wave = Math.floor(i / options.courts);
      round.push({
        key: `bracket:${position}`,
        poolKey: null,
        round: r,
        bracketPosition: position,
        courtLabel: courtName((i % options.courts) + 1),
        teamAId: null,
        teamBId: null,
        bestOf: options.bracketBestOf,
        status: "scheduled",
        winnerTeamId: null,
        nextMatchKey: null,
        nextMatchSlot: null,
        scheduledAt: roundStart + wave * options.schedule.bracketMatchMinutes * MINUTE,
      });
      position += 1;
    }
    byRound.push(round);
    matches.push(...round);
    const waves = Math.ceil(count / options.courts);
    roundStart += (waves * options.schedule.bracketMatchMinutes + options.schedule.restMinutes) * MINUTE;
  }
  for (let r = 0; r < byRound.length - 1; r += 1) {
    const cur = byRound[r];
    const next = byRound[r + 1];
    if (!cur || !next) continue;
    cur.forEach((m, i) => {
      const target = next[Math.floor(i / 2)];
      if (!target) return;
      m.nextMatchKey = target.key;
      m.nextMatchSlot = i % 2 === 0 ? "a" : "b";
    });
  }
  return { matches, shape: { size, rounds } };
}

function applyPatches(matches: DrawMatch[], patches: readonly BracketPatch[]): void {
  const byKey = new Map(matches.map((m) => [m.key, m]));
  for (const p of patches) {
    const m = byKey.get(p.key);
    if (!m) throw new DrawError("bracket_mismatch", `Patch for unknown match ${p.key}.`);
    m.teamAId = p.teamAId;
    m.teamBId = p.teamBId;
    m.status = p.status;
    m.winnerTeamId = p.winnerTeamId;
  }
}

function drawRoundRobin(order: string[], options: DrawOptions): DrawPlan {
  const { pools, matches } = schedulePools([order], ["Round robin"], options);
  return { format: "round_robin", order, pools, matches, seeds: [], bracket: null };
}

function drawSingleElimination(order: string[], options: DrawOptions): DrawPlan {
  const size = nextPowerOfTwo(order.length);
  const { matches, shape } = bracketSkeleton(size, options.schedule.startsAt, options);
  applyPatches(
    matches,
    seedBracketSlots(
      matches.map((m) => ({ ...m, bracketPosition: m.bracketPosition ?? 0 })),
      order,
    ),
  );
  return {
    format: "single_elim",
    order,
    pools: [],
    matches,
    seeds: order.map((teamId, i) => ({ teamId, seed: i + 1 })),
    bracket: { ...shape, advancing: order.length },
  };
}

function drawPoolToBracket(order: string[], options: DrawOptions): DrawPlan {
  const poolCount = poolCountFor(order.length, options.poolSize);
  const groups = snakePools(order, poolCount);
  validateAdvancement(options.advance);
  const smallest = Math.min(...groups.map((g) => g.length));
  if (options.advance.perPool > smallest) {
    throw new DrawError("bad_advancement", `perPool ${options.advance.perPool} exceeds the smallest pool (${smallest} teams).`);
  }
  const advancing = options.advance.perPool * poolCount + options.advance.bestRemaining;
  if (advancing < 2) throw new DrawError("bad_advancement", "At least two teams must advance to form a bracket.");
  if (advancing > order.length) {
    throw new DrawError("bad_advancement", `${advancing} teams would advance but only ${order.length} are entered.`);
  }
  const { pools, matches, lastStartsAt } = schedulePools(
    groups,
    groups.map((_, i) => poolLabel(i)),
    options,
  );
  const bracketStartsAt = (lastStartsAt ?? options.schedule.startsAt) + (options.schedule.poolMatchMinutes + options.schedule.restMinutes) * MINUTE;
  const size = nextPowerOfTwo(advancing);
  const bracket = bracketSkeleton(size, bracketStartsAt, options);
  return {
    format: "pool_to_bracket",
    order,
    pools,
    matches: [...matches, ...bracket.matches],
    seeds: [],
    bracket: { ...bracket.shape, advancing },
  };
}
