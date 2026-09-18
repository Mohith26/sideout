import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { authCodes, users, type User } from "@/db/schema";
import { env } from "@/env";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import { maskPhone } from "@/lib/phone";
import { uuidv7 } from "@/lib/uuid";
import { writeAudit } from "@/server/audit";
import { createRateLimiter, type RateLimiter } from "@/server/auth/rate-limit";
import { requireSmsSender } from "@/server/auth/sms";

/**
 * Phone sign-in with a one-time code.
 *
 * `requestCode` mints a six-digit code, stores only its HMAC, and hands the
 * plaintext to the SMS seam. `verifyCode` checks the newest unconsumed code
 * for the phone, consumes it, and finds or creates the user. The response to
 * a wrong code never says whether the phone is known.
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_AUTH_CODE_ATTEMPTS = 5;
const CODE_DIGITS = 6;
const TEN_MINUTES = 10 * 60 * 1000;

/**
 * Requests per phone and per address, refilled slowly: brute force is not an
 * option. The per-address bucket only applies when a proxy vouches for the
 * address (`TRUSTED_PROXY_HOPS`); the process-wide bucket
 * (`AUTH_CODE_GLOBAL_CAP` per ten minutes) bounds how many codes, rows and
 * texts an attacker with fresh phones can cause regardless. It is charged
 * last, only for a code that is actually issued, so a client the narrower
 * limits already refuse cannot drain it for everyone else.
 */
export const REQUEST_CODE_LIMITS = {
  perPhone: createRateLimiter({ capacity: 3, refill: 3, perMs: TEN_MINUTES }),
  perAddress: createRateLimiter({ capacity: 20, refill: 20, perMs: TEN_MINUTES }),
  global: createRateLimiter({ capacity: env.AUTH_CODE_GLOBAL_CAP, refill: env.AUTH_CODE_GLOBAL_CAP, perMs: TEN_MINUTES }),
};
export const VERIFY_CODE_LIMITS = {
  perPhone: createRateLimiter({ capacity: 10, refill: 10, perMs: TEN_MINUTES }),
  perAddress: createRateLimiter({ capacity: 60, refill: 60, perMs: TEN_MINUTES }),
};
const GLOBAL_KEY = "*";

function hashCode(phone: string, code: string): string {
  return createHmac("sha256", env.sessionSecret).update(`${phone}:${code}`).digest("hex");
}

function takeOrThrow(limiter: RateLimiter, key: string): void {
  const verdict = limiter.take(key);
  if (!verdict.allowed) {
    throw new ApiFailure("rate_limited", "Too many attempts; try again in a moment.", { retryAfterMs: verdict.retryAfterMs });
  }
}

export interface RequestCodeInput {
  phone: string;
  /** Trusted client address, or null when none can be (see `clientAddress`). */
  address: string | null;
  clock?: Clock;
}

export interface RequestCodeResult {
  expiresAt: number;
  /** Only outside production, so tests and local development can finish the flow. */
  devCode?: string;
}

export function requestCode(input: RequestCodeInput): RequestCodeResult {
  const clock = input.clock ?? systemClock;
  const sms = requireSmsSender();
  if (input.address !== null) takeOrThrow(REQUEST_CODE_LIMITS.perAddress, input.address);
  takeOrThrow(REQUEST_CODE_LIMITS.perPhone, input.phone);
  takeOrThrow(REQUEST_CODE_LIMITS.global, GLOBAL_KEY);

  const db = getDb();
  const now = clock.now();
  const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  const expiresAt = now + CODE_TTL_MS;
  db.transaction((tx) => {
    // Spent and expired codes are dead weight; the table only ever holds live ones.
    tx.delete(authCodes)
      .where(or(isNotNull(authCodes.consumedAt), lte(authCodes.expiresAt, now)))
      .run();
    tx.insert(authCodes)
      .values({ id: uuidv7(), phoneE164: input.phone, codeHash: hashCode(input.phone, code), attempts: 0, expiresAt, consumedAt: null, createdAt: now })
      .run();
  });

  sms.send(input.phone, `Your Sideout sign-in code is ${code}. It expires in ${CODE_TTL_MS / 60_000} minutes.`);
  log.info("auth: code issued", { to: maskPhone(input.phone) });

  const result: RequestCodeResult = { expiresAt };
  if (env.NODE_ENV !== "production") result.devCode = code;
  return result;
}

export interface VerifyCodeInput {
  phone: string;
  code: string;
  /** Required only when the phone has no account yet. */
  displayName?: string | undefined;
  /** Trusted client address, or null when none can be (see `clientAddress`). */
  address: string | null;
  clock?: Clock;
}

export interface VerifyCodeResult {
  user: User;
  created: boolean;
}

const WRONG = () => new ApiFailure("unauthorized", "That code is not valid. Request a new one if it has expired.");

export function verifyCode(input: VerifyCodeInput): VerifyCodeResult {
  const clock = input.clock ?? systemClock;
  if (input.address !== null) takeOrThrow(VERIFY_CODE_LIMITS.perAddress, input.address);
  takeOrThrow(VERIFY_CODE_LIMITS.perPhone, input.phone);
  const db = getDb();
  const now = clock.now();

  const pending = db
    .select()
    .from(authCodes)
    .where(and(eq(authCodes.phoneE164, input.phone), isNull(authCodes.consumedAt)))
    .orderBy(desc(authCodes.createdAt))
    .limit(1)
    .get();
  if (!pending || pending.expiresAt <= now || pending.attempts >= MAX_AUTH_CODE_ATTEMPTS) throw WRONG();

  const expected = Buffer.from(pending.codeHash);
  const actual = Buffer.from(hashCode(input.phone, input.code.trim()));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    db.update(authCodes)
      .set({ attempts: pending.attempts + 1 })
      .where(eq(authCodes.id, pending.id))
      .run();
    throw WRONG();
  }

  return db.transaction((tx) => {
    let user = tx.select().from(users).where(eq(users.phoneE164, input.phone)).get() ?? null;
    let created = false;
    if (!user) {
      const displayName = input.displayName?.trim();
      if (!displayName) {
        // The code matched; leave it usable so the client can retry with a name.
        throw new ApiFailure("bad_request", "Choose a display name to create your account.", { code: "display_name_required" });
      }
      const row = {
        id: uuidv7(),
        displayName,
        phoneE164: input.phone,
        email: null,
        avatarUrl: null,
        role: "player" as const,
        createdAt: now,
      };
      tx.insert(users).values(row).run();
      user = { ...row };
      created = true;
      writeAudit(tx, { actor: { kind: "player", userId: user.id }, action: "user.created", subjectType: "user", subjectId: user.id, at: now });
    }
    tx.update(authCodes).set({ consumedAt: now }).where(eq(authCodes.id, pending.id)).run();
    writeAudit(tx, { actor: { kind: user.role, userId: user.id }, action: "user.signed_in", subjectType: "user", subjectId: user.id, detail: { method: "phone_code" }, at: now });
    return { user, created };
  });
}
