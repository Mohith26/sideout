import { existsSync, rmSync } from "node:fs";
import { applyMigrations, openConnection, resolveDatabasePath } from "@/db/connection";
import { log } from "@/lib/log";
import { buildSeed, DEFAULT_RNG_SEED, startOfTodayIn, VENUE_TIMEZONE } from "@/seed/build";
import { writeSeed } from "@/seed/write";

/**
 * `npm run seed` — reset the database file, apply migrations, and write the
 * section 13 dataset. Deterministic for a given day: the flagship event is
 * "live" on the calendar day the seed runs, in the venue's time zone.
 *
 * Reads DATABASE_PATH directly (same default as `src/env.ts`) so the seed works
 * before any other environment is configured.
 */
const databasePath = process.env.DATABASE_PATH?.trim() || "./data/sideout.db";
const resolved = resolveDatabasePath(databasePath);

if (resolved !== ":memory:") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${resolved}${suffix}`;
    if (existsSync(file)) rmSync(file);
  }
}

const conn = openConnection(databasePath, { create: true });
try {
  const migrations = applyMigrations(conn);
  const anchorMs = startOfTodayIn(VENUE_TIMEZONE);
  const dataset = buildSeed({ anchorMs, rngSeed: DEFAULT_RNG_SEED });
  const summary = writeSeed(conn, dataset);
  log.info("seeded", { path: conn.path, anchor: new Date(anchorMs).toISOString(), migrations: migrations.applied });
  for (const [table, count] of Object.entries(summary.counts)) {
    log.info(`  ${table.padEnd(18)} ${String(count).padStart(5)}`);
  }
} finally {
  conn.close();
}
