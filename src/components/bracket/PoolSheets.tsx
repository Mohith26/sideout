import { PoolTable, type PoolMatchRef, type PoolTeamRef } from "@/components/bracket/PoolTable";
import type { PoolDetail } from "@/db/queries/tournaments";
import { cx } from "@/lib/cx";

/**
 * Every pool of an event as a sheet, from the detail read model. Shared by the
 * public bracket tab and the organizer builder so both show the same thing.
 */
export function poolMatchRefs(pool: Pick<PoolDetail, "matches">): PoolMatchRef[] {
  return pool.matches.map((m) => ({
    id: m.match.id,
    teamAId: m.match.teamAId,
    teamBId: m.match.teamBId,
    status: m.match.status,
    winnerId: m.match.winnerTeamId,
    sets: m.match.status === "disputed" ? [] : m.sets.map((s) => ({ a: s.teamAPoints, b: s.teamBPoints })),
    round: m.match.round,
    scheduledAt: m.match.scheduledAt,
    href: `/m/${m.match.id}`,
  }));
}

export function poolTeamRefs(pool: Pick<PoolDetail, "teams">): PoolTeamRef[] {
  return pool.teams.map((t) => ({ id: t.id, name: t.name, seed: t.seed, members: t.members }));
}

export function PoolSheets({ pools, timeZone, highlightTeamId, className }: { pools: readonly PoolDetail[]; timeZone: string; highlightTeamId?: string | null; className?: string }) {
  return (
    <div className={cx("grid gap-4 xl:grid-cols-2", className)}>
      {pools.map((pool) => (
        <PoolTable
          key={pool.id}
          label={pool.label}
          courtLabel={pool.courtLabel}
          teams={poolTeamRefs(pool)}
          matches={poolMatchRefs(pool)}
          standings={pool.standings}
          timeZone={timeZone}
          highlightTeamId={highlightTeamId ?? null}
        />
      ))}
    </div>
  );
}
