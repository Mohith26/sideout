import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { migrationsFolder, readMigrationState, type MigrationState } from "@/db/migrations";
import * as schema from "@/db/schema";

/**
 * Low-level connection factory shared by the app (`@/db/client`), the seed and
 * the migrate CLI. Nothing here reads `process.env`; callers pass the path so
 * the CLIs and tests can point at any file (or `:memory:`).
 */

export type Db = BetterSQLite3Database<typeof schema>;

export interface Connection {
  sqlite: Database.Database;
  db: Db;
  path: string;
  close(): void;
}

export class DatabaseNotReadyError extends Error {
  constructor(
    message: string,
    public readonly state: MigrationState | null,
  ) {
    super(message);
    this.name = "DatabaseNotReadyError";
  }
}

export interface OpenOptions {
  /** Create the file (and parent directory) if missing. CLIs only. */
  create?: boolean;
}

export function resolveDatabasePath(databasePath: string): string {
  // The path comes from configuration, so the bundler cannot scope it; the
  // ignore comment stops Turbopack from tracing the whole project into the build.
  return databasePath === ":memory:" ? databasePath : resolve(/* turbopackIgnore: true */ process.cwd(), databasePath);
}

export function openConnection(databasePath: string, options: OpenOptions = {}): Connection {
  const path = resolveDatabasePath(databasePath);
  const isMemory = path === ":memory:";

  if (!isMemory) {
    if (options.create) {
      mkdirSync(dirname(path), { recursive: true });
    } else if (!existsSync(path)) {
      throw new DatabaseNotReadyError(
        `No database at ${path}. Run \`npm run seed\` to create and populate it.`,
        null,
      );
    }
  }

  const sqlite = new Database(path, { fileMustExist: !isMemory && !options.create });
  if (!isMemory) sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    path,
    close() {
      sqlite.close();
    },
  };
}

/** Apply every pending checked-in migration. Idempotent. */
export function applyMigrations(conn: Connection): MigrationState {
  migrate(conn.db, { migrationsFolder: migrationsFolder() });
  return readMigrationState(conn.sqlite);
}

/** Throw a clear error if the database is missing tables the app expects. */
export function assertMigrated(conn: Connection): MigrationState {
  const state = readMigrationState(conn.sqlite);
  if (state.pending > 0) {
    throw new DatabaseNotReadyError(
      `Database at ${conn.path} has ${state.pending} pending migration(s). Run \`npm run db:migrate\` (or \`npm run seed\`).`,
      state,
    );
  }
  return state;
}
