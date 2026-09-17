import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";

/**
 * Migration bookkeeping shared by `npm run db:migrate`, the seed, and `/health`.
 * Drizzle's migrator records each applied migration in `__drizzle_migrations`
 * with `created_at` = the journal entry's `when`; comparing the two sides gives
 * applied / available / pending without reimplementing the migrator.
 */

const journalSchema = z.object({
  version: z.string(),
  dialect: z.literal("sqlite"),
  entries: z.array(
    z.object({
      idx: z.number().int().nonnegative(),
      version: z.string(),
      when: z.number().int().positive(),
      tag: z.string(),
      breakpoints: z.boolean(),
    }),
  ),
});

export type MigrationJournal = z.infer<typeof journalSchema>;

export interface MigrationState {
  applied: number;
  available: number;
  pending: number;
}

const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Absolute path to the checked-in `drizzle/` folder. Resolved from the process
 * working directory because `next start`, `next dev`, and every npm script run
 * from the repository root, and a bundled `import.meta.url` would not point back
 * at the source tree.
 */
export function migrationsFolder(): string {
  return resolve(process.cwd(), "drizzle");
}

export function readJournal(folder: string = migrationsFolder()): MigrationJournal {
  const path = join(folder, "meta", "_journal.json");
  const raw = readFileSync(path, "utf8");
  return journalSchema.parse(JSON.parse(raw));
}

const appliedRowSchema = z.object({ created_at: z.coerce.number() });

/**
 * Read applied-vs-available state for an open connection. Safe on a brand new
 * database (no migrations table yet) — everything is pending.
 */
export function readMigrationState(sqlite: Database.Database, folder: string = migrationsFolder()): MigrationState {
  const journal = readJournal(folder);
  const available = journal.entries.length;

  const table = sqlite
    .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (!table) {
    return { applied: 0, available, pending: available };
  }

  const rows = sqlite.prepare(`SELECT created_at FROM ${MIGRATIONS_TABLE}`).all();
  const appliedStamps = new Set(rows.map((r) => appliedRowSchema.parse(r).created_at));
  const applied = journal.entries.filter((e) => appliedStamps.has(e.when)).length;
  return { applied, available, pending: Math.max(0, available - applied) };
}
