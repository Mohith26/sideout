import { DatabaseNotReadyError, openConnection } from "@/db/connection";
import { readMigrationState, type MigrationState } from "@/db/migrations";
import { env } from "@/env";
import { fail, ok } from "@/lib/api";
import { errorMessage, log } from "@/lib/log";
import { LUCRA_SDK_VERSION } from "@/lucra/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /health — build provenance, Lucra mode, pinned SDK version, and
 * migration state (spec §9). Never includes a secret: only the mode is
 * reported, never a key, URL, or path.
 */
export interface HealthData {
  buildSha: string;
  lucraMode: typeof env.LUCRA_MODE;
  lucraSdkVersion: string;
  /** Where the session signing key came from; "ephemeral" means SESSION_SECRET is unset in production. */
  session: typeof env.sessionSecretSource;
  devLogin: boolean;
  migrations: MigrationState;
}

export async function GET() {
  const base = {
    buildSha: env.BUILD_SHA,
    lucraMode: env.LUCRA_MODE,
    lucraSdkVersion: LUCRA_SDK_VERSION,
    session: env.sessionSecretSource,
    devLogin: env.devLoginEnabled,
  };

  let migrations: MigrationState;
  try {
    // A short-lived connection so /health reports the truth even when the
    // app's own singleton has not been opened yet.
    const conn = openConnection(env.DATABASE_PATH);
    try {
      migrations = readMigrationState(conn.sqlite);
    } finally {
      conn.close();
    }
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) {
      const available = tryReadAvailable();
      return fail(
        "unavailable",
        "Database is not ready; run `npm run seed`.",
        { ...base, migrations: { applied: 0, available, pending: available } satisfies MigrationState },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    log.error("health: database check failed", { message: errorMessage(err) });
    return fail("internal", "Database check failed.", base, { headers: { "Cache-Control": "no-store" } });
  }

  if (migrations.pending > 0) {
    return fail(
      "unavailable",
      `${migrations.pending} migration(s) pending; run \`npm run db:migrate\`.`,
      { ...base, migrations } satisfies HealthData,
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return ok<HealthData>({ ...base, migrations }, { headers: { "Cache-Control": "no-store" } });
}

function tryReadAvailable(): number {
  try {
    const memory = openConnection(":memory:", { create: true });
    try {
      return readMigrationState(memory.sqlite).available;
    } finally {
      memory.close();
    }
  } catch (err) {
    log.warn("health: could not read migration journal", { message: errorMessage(err) });
    return 0;
  }
}
