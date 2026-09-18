import { DatabaseNotReadyError, openConnection } from "@/db/connection";
import { readMigrationState, type MigrationState } from "@/db/migrations";
import { env } from "@/env";
import { fail, ok } from "@/lib/api";
import { errorMessage, log } from "@/lib/log";
import { LUCRA_SDK_PACKAGE, LUCRA_SDK_SOURCE, LUCRA_SDK_VERSION } from "@/lucra/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /health — build provenance, Lucra mode, the pinned and installed SDK
 * versions, the active matcher interpretation, and migration state (spec §9).
 * Never includes a secret: only the mode is reported, never a key, URL, or path.
 */
export interface HealthData {
  buildSha: string;
  lucraMode: typeof env.LUCRA_MODE;
  /** The pin in `src/lucra/version.ts`, the version the browser initializes. */
  lucraSdkVersion: string;
  /**
   * Package name, the pin, its install source, and the version actually
   * installed (read from the package manifest at build time; "unknown" when
   * the build could not read it). The two versions must agree.
   */
  lucraSdk: { package: string; version: string; source: string; installed: string };
  lucraMatcherInterpretation: typeof env.LUCRA_MATCHER_INTERPRETATION;
  /** Where the session signing key came from; "ephemeral" means SESSION_SECRET is unset in production. */
  session: typeof env.sessionSecretSource;
  devLogin: boolean;
  /** The demo-accounts picker and the reset route exist (`DEMO_ACCOUNTS`, mock mode only). */
  demoAccounts: boolean;
  migrations: MigrationState;
}

export async function GET() {
  const base = {
    buildSha: env.BUILD_SHA,
    lucraMode: env.LUCRA_MODE,
    lucraSdkVersion: LUCRA_SDK_VERSION,
    lucraSdk: { package: LUCRA_SDK_PACKAGE, version: LUCRA_SDK_VERSION, source: LUCRA_SDK_SOURCE, installed: env.LUCRA_SDK_INSTALLED_VERSION ?? "unknown" },
    lucraMatcherInterpretation: env.LUCRA_MATCHER_INTERPRETATION,
    session: env.sessionSecretSource,
    devLogin: env.devLoginEnabled,
    demoAccounts: env.demoAccountsEnabled,
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
