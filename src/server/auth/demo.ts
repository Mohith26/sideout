import "server-only";
import { getDb } from "@/db/client";
import { findDemoAccount, type DemoAccount } from "@/db/queries/demo";
import { env } from "@/env";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import { writeAudit } from "@/server/audit";
import { createRateLimiter, type RateLimiter } from "@/server/auth/rate-limit";
import { type DemoAccountKey } from "@/seed/demo";

/**
 * Demo sign-in (`DEMO_ACCOUNTS`, `docs/deploy.md` "Public demo"): a visitor
 * to the public demo picks one of the curated seeded users and gets a normal
 * session marked `via: "demo"`. Nothing here touches the phone-code sign-in.
 *
 * The switch is checked on every call (the route also 404s), the account must
 * be one the roster names (never an arbitrary user id), every sign-in writes
 * `auth.demo_sign_in` on the user, and the per-address and process-wide
 * buckets keep a script from churning sessions.
 */

export const DEMO_AUDIT_ACTION = "auth.demo_sign_in";

const TEN_MINUTES = 10 * 60 * 1000;
export const DEMO_SIGN_IN_LIMITS = {
  perAddress: createRateLimiter({ capacity: 30, refill: 30, perMs: TEN_MINUTES }),
  global: createRateLimiter({ capacity: 600, refill: 600, perMs: TEN_MINUTES }),
};
const GLOBAL_KEY = "*";

function takeOrThrow(limiter: RateLimiter, key: string): void {
  const verdict = limiter.take(key);
  if (!verdict.allowed) throw new ApiFailure("rate_limited", "Too many demo sign-ins; try again in a moment.", { retryAfterMs: verdict.retryAfterMs });
}

/** The switch is off: the demo routes do not exist. */
export function assertDemoAccountsEnabled(): void {
  if (!env.demoAccountsEnabled) throw new ApiFailure("not_found", "Not found.");
}

export interface DemoSignInInput {
  account: DemoAccountKey;
  /** Trusted client address, or null when none can be (see `clientAddress`). */
  address: string | null;
  clock?: Clock;
}

export function demoSignIn(input: DemoSignInInput): DemoAccount {
  assertDemoAccountsEnabled();
  const clock = input.clock ?? systemClock;
  if (input.address !== null) takeOrThrow(DEMO_SIGN_IN_LIMITS.perAddress, input.address);
  takeOrThrow(DEMO_SIGN_IN_LIMITS.global, GLOBAL_KEY);

  const account = findDemoAccount(input.account);
  if (!account) throw new ApiFailure("not_found", "That demo account is not available on this database.");
  const now = clock.now();
  writeAudit(getDb(), {
    actor: { kind: account.role, userId: account.userId },
    action: DEMO_AUDIT_ACTION,
    subjectType: "user",
    subjectId: account.userId,
    detail: { account: account.key, method: "demo_accounts" },
    at: now,
  });
  log.info("auth: demo sign-in", { account: account.key, role: account.role });
  return account;
}
