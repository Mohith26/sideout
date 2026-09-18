import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Connection } from "@/db/connection";
import * as schema from "@/db/schema";
import type { SeedDataset } from "@/seed/build";

/**
 * Persist a built dataset. Clears every table first (children before parents,
 * so foreign keys stay satisfied), then inserts parents before children inside
 * one transaction. Re-running produces the same rows: the seed is idempotent.
 */

/** Insert order. Reversed for deletion. */
const TABLE_ORDER = [
  ["charities", schema.charities],
  ["users", schema.users],
  ["lucraLinks", schema.lucraLinks],
  ["tournaments", schema.tournaments],
  ["teams", schema.teams],
  ["teamMembers", schema.teamMembers],
  ["teamInvites", schema.teamInvites],
  ["pools", schema.pools],
  ["poolTeams", schema.poolTeams],
  ["matches", schema.matches],
  ["sets", schema.sets],
  ["scoreSubmissions", schema.scoreSubmissions],
  ["matchConsensus", schema.matchConsensus],
  ["lucraScoreSubmissions", schema.lucraScoreSubmissions],
  ["donations", schema.donations],
  ["sponsors", schema.sponsors],
  ["rewards", schema.rewards],
  ["auditLog", schema.auditLog],
] as const satisfies ReadonlyArray<readonly [keyof SeedDataset, SQLiteTable]>;

/** Tables the seed never populates but must still be emptied on reset. */
const RESET_ONLY_TABLES: readonly SQLiteTable[] = [schema.webhookEvents, schema.authCodes];

const CHUNK = 200;

function chunked<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

export interface SeedSummary {
  counts: Record<keyof SeedDataset, number>;
}

export function writeSeed(conn: Connection, dataset: SeedDataset): SeedSummary {
  const counts = {} as Record<keyof SeedDataset, number>;
  conn.db.transaction((tx) => {
    for (const table of RESET_ONLY_TABLES) tx.delete(table).run();
    for (const [, table] of [...TABLE_ORDER].reverse()) tx.delete(table).run();

    // Self-referencing columns (matches.next_match_id, score_submissions.superseded_by_id)
    // point at rows in the same table that may not be inserted yet; defer FK checks
    // to commit. Postgres has the same knob (`SET CONSTRAINTS ALL DEFERRED`).
    conn.sqlite.pragma("defer_foreign_keys = ON");

    for (const [key, table] of TABLE_ORDER) {
      const rows = dataset[key] as unknown as Array<typeof table.$inferInsert>;
      counts[key] = rows.length;
      for (const part of chunked(rows)) {
        if (part.length) tx.insert(table).values(part).run();
      }
    }
  });
  return { counts };
}
