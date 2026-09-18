import "server-only";
import { randomInt } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getPoolStandings } from "@/db/queries/standings";
import { getTournamentDetail, type TournamentDetail } from "@/db/queries/tournaments";
import { matchConsensus, matches, pools, poolTeams, scoreSubmissions, sets, teams, tournaments, type Match, type NewMatch, type Tournament } from "@/db/schema";
import { draw, drawConfigSchema, seedBracketSlots, selectAdvancing, type DrawConfig, type DrawPlan, type DrawTeam } from "@/domain/draw";
import { DRAWABLE_STATUSES, TERMINAL_MATCH_STATUSES, transitionMatch, type TransitionActor } from "@/domain/transitions";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { createRng } from "@/lib/rng";
import { uuidv7 } from "@/lib/uuid";
import { SYSTEM_ACTOR, writeAudit, type Tx } from "@/server/audit";
import { requireTournamentById } from "@/server/tournaments";

/**
 * Draw service behind `POST /api/admin/tournaments/:id/draw`.
 *
 * Stage `pools` (the default) runs the engine for the tournament's format and,
 * unless `preview` is set, writes pools, pool_teams and matches in one
 * transaction and stores the configuration it used as
 * `tournaments.draw_config_json`. It is allowed only in `registration_closed`;
 * a re-draw replaces an existing draw only while no match has started.
 *
 * `teams.seed` is the organizer's entry seed. It is written only from the
 * request's `seeds` list and survives a re-draw; the bracket order a draw
 * produces lives on the bracket slots and is never copied back to it.
 *
 * Stage `bracket` applies to `pool_to_bracket` once every pool match is
 * terminal: it ranks the pools, selects the advancing teams by the stored
 * advancement rule and seeds round 1 (byes auto-advance). The request carries
 * nothing but the stage. The consensus phase can call `seedBracketFromPools`
 * itself when the last pool match finalizes.
 */

const poolsRequestSchema = z
  .object({
    stage: z.literal("pools").default("pools"),
    courts: z.number().int().min(1).max(64).default(4),
    poolSize: z.number().int().min(2).max(12).default(4),
    advance: z
      .object({ perPool: z.number().int().min(0).max(12), bestRemaining: z.number().int().min(0).max(64) })
      .default({ perPool: 2, bestRemaining: 0 }),
    poolBestOf: z.enum(["1", "3"]).default("1"),
    bracketBestOf: z.enum(["1", "3"]).default("3"),
    /** Defaults to `tournaments.starts_at`. */
    startsAt: z.number().int().positive().optional(),
    poolMatchMinutes: z.number().int().min(5).max(240).default(30),
    bracketMatchMinutes: z.number().int().min(5).max(240).default(50),
    restMinutes: z.number().int().min(0).max(240).default(15),
    /** Entry seeds to store on `teams.seed` before drawing; null clears a stored seed. Teams left out keep theirs. */
    seeds: z.array(z.object({ teamId: z.string().min(1), seed: z.number().int().min(1).nullable() })).max(256).optional(),
    /** Reproduces a previewed draw; omitted means a fresh random draw. */
    rngSeed: z.number().int().min(0).max(0xffffffff).optional(),
  })
  .strict();
const bracketRequestSchema = z.object({ stage: z.literal("bracket") }).strict();

export const drawRequestSchema = z.union([bracketRequestSchema, poolsRequestSchema]);
export type DrawRequest = z.infer<typeof drawRequestSchema>;
export type PoolsDrawRequest = z.infer<typeof poolsRequestSchema>;

export interface DrawPreview {
  stage: "pools" | "bracket";
  /** The rng seed a pools-stage draw used; null for the bracket stage, which has no randomness. */
  rngSeed: number | null;
  plan: DrawPlan;
  /** Every entrant with the entry seed the draw saw. */
  teams: Record<string, { name: string; seed: number | null }>;
  /** Bracket stage: the advancing team ids in seed order. */
  advancing?: string[];
}

export interface DrawOutcome {
  preview: DrawPreview;
  detail: TournamentDetail | null;
}

function entryTeams(tournamentId: string, overrides: PoolsDrawRequest["seeds"]): { drawTeams: DrawTeam[]; names: Record<string, { name: string; seed: number | null }> } {
  const rows = getDb()
    .select()
    .from(teams)
    .where(and(eq(teams.tournamentId, tournamentId), inArray(teams.status, ["registered", "checked_in"])))
    .orderBy(asc(teams.createdAt))
    .all();
  const override = new Map((overrides ?? []).map((s) => [s.teamId, s.seed]));
  for (const teamId of override.keys()) {
    if (!rows.some((r) => r.id === teamId)) throw new ApiFailure("bad_request", `Seed override names team ${teamId}, which is not registered here.`);
  }
  const drawTeams: DrawTeam[] = rows.map((r) => ({ id: r.id, seed: override.has(r.id) ? (override.get(r.id) ?? null) : r.seed }));
  const names: Record<string, { name: string; seed: number | null }> = {};
  for (const r of rows) names[r.id] = { name: r.name, seed: override.has(r.id) ? (override.get(r.id) ?? null) : r.seed };
  return { drawTeams, names };
}

function assertDrawable(t: Tournament, existing: Match[]): void {
  if (!DRAWABLE_STATUSES.has(t.status)) {
    throw new ApiFailure("conflict", `The draw can only be generated while registration is closed; the tournament is ${t.status}.`);
  }
  const started = existing.filter((m) => m.status !== "scheduled" && m.status !== "bye");
  if (started.length > 0) {
    throw new ApiFailure("conflict", `${started.length} match(es) have already started; the draw can no longer be replaced.`);
  }
}

export function runDraw(tournamentId: string, request: DrawRequest, actor: TransitionActor, options: { preview: boolean; clock?: Clock }): DrawOutcome {
  if (request.stage === "bracket") return seedBracketFromPools(tournamentId, actor, options);
  const clock = options.clock ?? systemClock;
  const db = getDb();
  const t = requireTournamentById(tournamentId).tournament;
  const existing = db.select().from(matches).where(eq(matches.tournamentId, tournamentId)).all();
  assertDrawable(t, existing);

  const { drawTeams, names } = entryTeams(tournamentId, request.seeds);
  const config: DrawConfig = {
    courts: request.courts,
    poolSize: request.poolSize,
    advance: request.advance,
    poolBestOf: request.poolBestOf,
    bracketBestOf: request.bracketBestOf,
    schedule: {
      startsAt: request.startsAt ?? t.startsAt,
      poolMatchMinutes: request.poolMatchMinutes,
      bracketMatchMinutes: request.bracketMatchMinutes,
      restMinutes: request.restMinutes,
    },
    rngSeed: request.rngSeed ?? randomInt(0, 0x100000000),
  };
  const plan = draw({ ...config, format: t.format, teams: drawTeams, rng: createRng(config.rngSeed) });
  const preview: DrawPreview = { stage: "pools", rngSeed: config.rngSeed, plan, teams: names };
  if (options.preview) return { preview, detail: null };

  const now = clock.now();
  db.transaction((tx) => {
    clearDraw(tx, tournamentId, existing);
    // Entry seeds: clear the overridden teams first so two of them can swap seeds under the unique index.
    const overrides = request.seeds ?? [];
    if (overrides.length > 0) {
      tx.update(teams)
        .set({ seed: null })
        .where(
          inArray(
            teams.id,
            overrides.map((s) => s.teamId),
          ),
        )
        .run();
      for (const s of overrides) if (s.seed !== null) tx.update(teams).set({ seed: s.seed }).where(eq(teams.id, s.teamId)).run();
    }
    tx.update(tournaments).set({ drawConfigJson: JSON.stringify(config) }).where(eq(tournaments.id, tournamentId)).run();

    const poolIds = new Map<string, string>();
    for (const pool of plan.pools) {
      const id = uuidv7();
      poolIds.set(pool.key, id);
      tx.insert(pools).values({ id, tournamentId, label: pool.label, courtLabel: pool.courtLabel }).run();
      for (const teamId of pool.teamIds) tx.insert(poolTeams).values({ id: uuidv7(), poolId: id, teamId }).run();
    }

    const matchIds = new Map(plan.matches.map((m) => [m.key, uuidv7()]));
    const rows: NewMatch[] = plan.matches.map((m) => ({
      id: matchIds.get(m.key) ?? uuidv7(),
      tournamentId,
      poolId: m.poolKey === null ? null : (poolIds.get(m.poolKey) ?? null),
      round: m.round,
      bracketPosition: m.bracketPosition,
      courtLabel: m.courtLabel,
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      bestOf: m.bestOf,
      status: m.status,
      winnerTeamId: m.winnerTeamId,
      nextMatchId: m.nextMatchKey === null ? null : (matchIds.get(m.nextMatchKey) ?? null),
      nextMatchSlot: m.nextMatchSlot,
      scheduledAt: m.scheduledAt,
      startedAt: null,
      finalizedAt: m.status === "bye" ? now : null,
    }));
    // Self-referencing next_match_id: insert later rounds first so every target exists.
    for (const row of [...rows].sort((x, y) => y.round - x.round)) tx.insert(matches).values(row).run();

    for (const row of rows) {
      if (row.status !== "bye") continue;
      writeAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: "match.status_changed",
        subjectType: "match",
        subjectId: row.id,
        detail: { from: "scheduled", to: "bye", winnerTeamId: row.winnerTeamId },
        at: now,
      });
    }
    writeAudit(tx, {
      actor,
      action: existing.length > 0 ? "tournament.redrawn" : "tournament.draw_generated",
      subjectType: "tournament",
      subjectId: tournamentId,
      detail: {
        format: plan.format,
        rngSeed: config.rngSeed,
        courts: config.courts,
        poolSize: config.poolSize,
        advance: config.advance,
        pools: plan.pools.length,
        matches: plan.matches.length,
        bracket: plan.bracket,
      },
      at: now,
    });
  });
  return { preview, detail: getTournamentDetail(requireTournamentById(tournamentId)) };
}

/** Remove an unstarted draw. Refuses if any result rows exist, which a started match would have left. */
function clearDraw(tx: Tx, tournamentId: string, existing: Match[]): void {
  if (existing.length === 0) return;
  const ids = existing.map((m) => m.id);
  const count = (n: number | undefined) => n ?? 0;
  const resultRows =
    count(tx.select({ n: sql<number>`count(*)` }).from(sets).where(inArray(sets.matchId, ids)).get()?.n) +
    count(tx.select({ n: sql<number>`count(*)` }).from(scoreSubmissions).where(inArray(scoreSubmissions.matchId, ids)).get()?.n) +
    count(tx.select({ n: sql<number>`count(*)` }).from(matchConsensus).where(inArray(matchConsensus.matchId, ids)).get()?.n);
  if (resultRows > 0) throw new ApiFailure("conflict", "Result rows exist for this draw; it can no longer be replaced.");
  // Break the self-references first so no row is deleted while another points at it.
  tx.update(matches).set({ nextMatchId: null }).where(eq(matches.tournamentId, tournamentId)).run();
  tx.delete(matches).where(eq(matches.tournamentId, tournamentId)).run();
  const poolIds = tx.select({ id: pools.id }).from(pools).where(eq(pools.tournamentId, tournamentId)).all().map((p) => p.id);
  if (poolIds.length > 0) tx.delete(poolTeams).where(inArray(poolTeams.poolId, poolIds)).run();
  tx.delete(pools).where(eq(pools.tournamentId, tournamentId)).run();
}

// ---------------------------------------------------------------------------
// Bracket stage
// ---------------------------------------------------------------------------

/** The configuration the current draw was generated with; a draw without one cannot be carried into a bracket. */
function requireDrawConfig(t: Tournament): DrawConfig {
  const parsed = t.drawConfigJson === null ? null : drawConfigSchema.safeParse(JSON.parse(t.drawConfigJson));
  if (!parsed?.success) {
    throw new ApiFailure("conflict", "This draw has no stored configuration; generate the draw again before seeding the bracket.", { code: "draw_config_missing" });
  }
  return parsed.data;
}

export function seedBracketFromPools(tournamentId: string, actor: TransitionActor, options: { preview: boolean; clock?: Clock }): DrawOutcome {
  const clock = options.clock ?? systemClock;
  const db = getDb();
  const t = requireTournamentById(tournamentId).tournament;
  if (t.format !== "pool_to_bracket") throw new ApiFailure("conflict", `Only pool_to_bracket tournaments seed a bracket from pools; this one is ${t.format}.`);
  if (t.status !== "live") throw new ApiFailure("conflict", `The bracket is seeded during play; the tournament is ${t.status}.`);
  const rule = requireDrawConfig(t).advance;

  const poolMatches = db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), isNotNull(matches.poolId)))
    .all();
  if (poolMatches.length === 0) throw new ApiFailure("conflict", "No pool matches exist; generate the draw first.");
  const unfinished = poolMatches.filter((m) => !TERMINAL_MATCH_STATUSES.has(m.status));
  if (unfinished.length > 0) throw new ApiFailure("conflict", `${unfinished.length} pool match(es) are still unresolved.`, { matchIds: unfinished.map((m) => m.id) });

  const bracket = db
    .select()
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), isNull(matches.poolId)))
    .orderBy(asc(matches.bracketPosition))
    .all();
  if (bracket.length === 0) throw new ApiFailure("conflict", "This draw has no bracket to seed.");

  const standings = getPoolStandings(tournamentId);
  const advancing = selectAdvancing(
    standings.map((s) => ({ rows: s.rows })),
    rule,
  );
  const patches = seedBracketSlots(
    bracket.map((m) => ({
      key: m.id,
      round: m.round,
      bracketPosition: m.bracketPosition ?? 0,
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      status: m.status,
      nextMatchKey: m.nextMatchId,
      nextMatchSlot: m.nextMatchSlot,
    })),
    advancing,
  );

  const nameRows = db.select({ id: teams.id, name: teams.name, seed: teams.seed }).from(teams).where(eq(teams.tournamentId, tournamentId)).all();
  const names: Record<string, { name: string; seed: number | null }> = {};
  for (const r of nameRows) names[r.id] = { name: r.name, seed: r.seed };
  const plan: DrawPlan = {
    format: t.format,
    order: advancing,
    pools: [],
    matches: bracket.map((m) => {
      const patch = patches.find((p) => p.key === m.id);
      return {
        key: m.id,
        poolKey: null,
        round: m.round,
        bracketPosition: m.bracketPosition,
        courtLabel: m.courtLabel,
        teamAId: patch?.teamAId ?? m.teamAId,
        teamBId: patch?.teamBId ?? m.teamBId,
        bestOf: m.bestOf,
        status: patch?.status ?? (m.status === "bye" ? "bye" : "scheduled"),
        winnerTeamId: patch?.winnerTeamId ?? m.winnerTeamId,
        nextMatchKey: m.nextMatchId,
        nextMatchSlot: m.nextMatchSlot,
        scheduledAt: m.scheduledAt,
      };
    }),
    seeds: advancing.map((teamId, i) => ({ teamId, seed: i + 1 })),
    bracket: { size: bracket.filter((m) => m.round === 1).length * 2, rounds: Math.max(...bracket.map((m) => m.round)), advancing: advancing.length },
  };
  const preview: DrawPreview = { stage: "bracket", rngSeed: null, plan, teams: names, advancing };
  if (options.preview) return { preview, detail: null };

  const now = clock.now();
  db.transaction((tx) => {
    for (const patch of patches) {
      const current = bracket.find((m) => m.id === patch.key);
      if (!current) continue;
      if (patch.status === "bye") {
        const verdict = transitionMatch(current.status, "bye", SYSTEM_ACTOR);
        if (!verdict.ok) throw new ApiFailure("conflict", verdict.reason);
        tx.update(matches)
          .set({ teamAId: patch.teamAId, teamBId: patch.teamBId, status: "bye", winnerTeamId: patch.winnerTeamId, finalizedAt: now })
          .where(eq(matches.id, patch.key))
          .run();
        writeAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: "match.status_changed",
          subjectType: "match",
          subjectId: patch.key,
          detail: { from: current.status, to: "bye", winnerTeamId: patch.winnerTeamId },
          at: now,
        });
      } else {
        tx.update(matches).set({ teamAId: patch.teamAId, teamBId: patch.teamBId }).where(eq(matches.id, patch.key)).run();
      }
    }
    writeAudit(tx, {
      actor,
      action: "tournament.bracket_seeded",
      subjectType: "tournament",
      subjectId: tournamentId,
      detail: { advance: rule, seeds: advancing },
      at: now,
    });
  });
  return { preview, detail: getTournamentDetail(requireTournamentById(tournamentId)) };
}
