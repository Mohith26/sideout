import "server-only";
import { env } from "@/env";
import { systemClock, type Clock } from "@/lib/clock";

/**
 * Minimal token-bucket rate limiter for the auth endpoints.
 *
 * SINGLE-INSTANCE ONLY: buckets live in this process's memory. Every instance
 * of the server enforces its own quota, and a restart empties them. That is
 * acceptable for a single-node deployment and for the demo; a multi-instance
 * deployment swaps this for a shared store behind the same `RateLimiter`
 * interface.
 *
 * Memory is bounded: a bucket that has had time to refill completely is
 * indistinguishable from a missing one, so every `take` sweeps such buckets
 * once per refill window.
 */

export interface RateLimitRule {
  /** Bucket capacity: how many requests can burst. */
  capacity: number;
  /** Sustained rate, tokens refilled per `perMs`. */
  refill: number;
  perMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Milliseconds until a token is available when refused. */
  retryAfterMs: number;
}

export interface RateLimiter {
  take(key: string): RateLimitVerdict;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function createRateLimiter(rule: RateLimitRule, clock: Clock = systemClock): RateLimiter & { reset(): void; size(): number } {
  const buckets = new Map<string, Bucket>();
  const ratePerMs = rule.refill / rule.perMs;
  /** Time for an empty bucket to fill: after this long untouched, a bucket carries no information. */
  const fullAfterMs = rule.capacity / ratePerMs;
  let sweptAt = Number.NEGATIVE_INFINITY;

  const refill = (bucket: Bucket, now: number) => {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsed * ratePerMs);
    bucket.updatedAt = now;
  };

  const sweep = (now: number) => {
    if (now - sweptAt < fullAfterMs) return;
    sweptAt = now;
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) buckets.delete(key);
    }
  };

  return {
    take(key) {
      const now = clock.now();
      sweep(now);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: rule.capacity, updatedAt: now };
        buckets.set(key, bucket);
      }
      refill(bucket, now);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / ratePerMs) };
    },
    reset() {
      buckets.clear();
      sweptAt = Number.NEGATIVE_INFINITY;
    },
    size() {
      return buckets.size;
    },
  };
}

/**
 * The client address to key a limiter on, or null when none can be trusted.
 *
 * Each trusted reverse proxy appends the address it accepted the connection
 * from to `x-forwarded-for`, so with `hops` trusted proxies the client is the
 * `hops`-th entry from the right; everything left of it was written by the
 * client or by someone upstream and is not evidence of anything. A route
 * handler never sees the socket itself, so with no trusted proxy there is no
 * address to key on at all.
 */
export function clientAddress(request: Request, hops: number = env.TRUSTED_PROXY_HOPS): string | null {
  if (hops < 1) return null;
  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return forwarded[forwarded.length - hops] ?? null;
}
