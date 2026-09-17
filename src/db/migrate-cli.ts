import { applyMigrations, openConnection } from "@/db/connection";
import { log } from "@/lib/log";

/**
 * `npm run db:migrate` — apply checked-in migrations to DATABASE_PATH,
 * creating the file if needed. Reads the same default as `src/env.ts` without
 * importing it, so the CLI works before any environment is configured.
 */
const databasePath = process.env.DATABASE_PATH?.trim() || "./data/sideout.db";

const conn = openConnection(databasePath, { create: true });
try {
  const state = applyMigrations(conn);
  log.info("migrations applied", {
    path: conn.path,
    applied: state.applied,
    available: state.available,
    pending: state.pending,
  });
} finally {
  conn.close();
}
