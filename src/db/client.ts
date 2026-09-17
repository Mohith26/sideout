import "server-only";
import { assertMigrated, openConnection, type Connection, type Db } from "@/db/connection";
import { env } from "@/env";

/**
 * Process-wide database handle for the Next.js server. One better-sqlite3
 * connection per process is the correct shape for SQLite; the global cache
 * keeps HMR in development from opening a new handle on every reload.
 *
 * Every route handler that imports this module must also declare
 * `export const runtime = "nodejs"`.
 */

declare global {
  var __sideoutDb: Connection | undefined;
}

function connect(): Connection {
  const conn = openConnection(env.DATABASE_PATH);
  assertMigrated(conn);
  return conn;
}

export function getConnection(): Connection {
  if (!globalThis.__sideoutDb) {
    globalThis.__sideoutDb = connect();
  }
  return globalThis.__sideoutDb;
}

export function getDb(): Db {
  return getConnection().db;
}
