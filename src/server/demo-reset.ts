import "server-only";
import { timingSafeEqual } from "node:crypto";
import { getConnection } from "@/db/client";
import { env } from "@/env";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import { installLucraAdapter } from "@/lucra";
import { resetLucraProcessState } from "@/server/lucra";
import { buildSeed, DEFAULT_RNG_SEED, startOfTodayIn, VENUE_TIMEZONE } from "@/seed/build";
import { writeSeed, type SeedSummary } from "@/seed/write";

/**
 * Put the public demo's database back to the seed (`DEMO_ACCOUNTS`,
 * `POST /api/admin/demo/reset`; `docs/deploy.md` "Public demo"). The same
 * dataset `npm run seed` writes, written through the app's own connection so
 * the file the server holds open is the one that changes: one transaction
 * empties every table and re-inserts the seed, so a request that overlaps the
 * reset sees either the old rows or the new ones, never a half-empty
 * database. The Lucra mock is then rebuilt from the new rows on its next use.
 *
 * One reset at a time per process (`reset_in_progress` otherwise), and only
 * with the bearer token from `DEMO_RESET_TOKEN`.
 */

declare global {
  var __sideoutDemoResetting: boolean | undefined;
}

export interface DemoResetResult {
  /** Midnight of the day the seed anchors on, in the venue's time zone (ISO). */
  anchor: string;
  counts: SeedSummary["counts"];
  durationMs: number;
}

/** Refuse anything but the configured token, compared in constant time. The route exists only with the switch on. */
export function assertDemoResetAuthorized(authorization: string | null): void {
  if (!env.demoAccountsEnabled) throw new ApiFailure("not_found", "Not found.");
  const token = env.DEMO_RESET_TOKEN;
  if (!token) throw new ApiFailure("unavailable", "The demo reset is not configured on this deployment.", { code: "demo_reset_unconfigured" });
  const presented = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(presented);
  if (actual.length === 0 || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApiFailure("unauthorized", "A valid reset token is required.");
  }
}

export function resetDemoDatabase(clock: Clock = systemClock): DemoResetResult {
  if (!env.demoAccountsEnabled) throw new ApiFailure("not_found", "Not found.");
  if (globalThis.__sideoutDemoResetting) throw new ApiFailure("conflict", "A reset is already running.", { code: "reset_in_progress" });
  globalThis.__sideoutDemoResetting = true;
  const startedAt = clock.now();
  try {
    const anchorMs = startOfTodayIn(VENUE_TIMEZONE, startedAt);
    const dataset = buildSeed({ anchorMs, rngSeed: DEFAULT_RNG_SEED });
    const summary = writeSeed(getConnection(), dataset);
    // The mock Lucra and the stale-attempt sweep follow the rows: rebuild both on next use.
    resetLucraProcessState();
    installLucraAdapter(undefined);
    const durationMs = clock.now() - startedAt;
    log.warn("demo: database reset to the seed", { anchor: new Date(anchorMs).toISOString(), durationMs, users: summary.counts.users, matches: summary.counts.matches });
    return { anchor: new Date(anchorMs).toISOString(), counts: summary.counts, durationMs };
  } finally {
    globalThis.__sideoutDemoResetting = false;
  }
}
