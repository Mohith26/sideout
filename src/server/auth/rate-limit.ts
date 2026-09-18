import "server-only";
import { systemClock, type Clock } from "@/lib/clock";

/**
 * Minimal token-bucket rate limiter for the auth endpoints.
 *
 * SINGLE-INSTANCE ONLY: buckets live in this process's memory. Every instance
 * of the server enforces its own quota, and a restart empties them. That is
 * acceptable for a single-node deployment and for the demo; a multi-instance
 * deployment swaps this for a shared store behind the same `RateLimiter`
 * interface.
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

export function createRateLimiter(rule: RateLimitRule, clock: Clock = systemClock): RateLimiter & { reset(): void } {
  const buckets = new Map<string, Bucket>();
  const ratePerMs = rule.refill / rule.perMs;

  const refill = (bucket: Bucket, now: number) => {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsed * ratePerMs);
    bucket.updatedAt = now;
  };

  return {
    take(key) {
      const now = clock.now();
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
    },
  };
}

/** Best-effort client address for keying; behind a proxy this is the first forwarded hop. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
