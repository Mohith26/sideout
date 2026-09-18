import { describe, expect, it } from "vitest";
import { fixedClock } from "@/lib/clock";
import { clientAddress, createRateLimiter } from "@/server/auth/rate-limit";

const MINUTE = 60_000;

describe("createRateLimiter", () => {
  it("bursts to capacity, refuses with a retry hint, and refills over time", () => {
    const clock = fixedClock(1_000_000);
    const limiter = createRateLimiter({ capacity: 3, refill: 3, perMs: 10 * MINUTE }, clock);
    expect([1, 2, 3].map(() => limiter.take("a").allowed)).toEqual([true, true, true]);
    const refused = limiter.take("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual((10 * MINUTE) / 3);
    clock.advance(refused.retryAfterMs);
    expect(limiter.take("a").allowed).toBe(true);
    // Another key has its own bucket.
    expect(limiter.take("b").allowed).toBe(true);
  });

  it("evicts buckets that have fully refilled, so a stream of fresh keys does not grow memory", () => {
    const clock = fixedClock(1_000_000);
    const limiter = createRateLimiter({ capacity: 2, refill: 2, perMs: 10 * MINUTE }, clock);
    for (let i = 0; i < 1_000; i += 1) limiter.take(`key-${i}`);
    expect(limiter.size()).toBe(1_000);

    // Half a window later nothing is full yet; the keys stay.
    clock.advance(5 * MINUTE);
    limiter.take("recent");
    limiter.take("recent");
    expect(limiter.size()).toBe(1_001);

    // A full window after the flood every flooded bucket is indistinguishable from a
    // missing one and is dropped; the recent key keeps its deficit (one token back
    // in five minutes, not a fresh bucket of two).
    clock.advance(5 * MINUTE);
    limiter.take("another");
    expect(limiter.size()).toBe(2);
    expect(limiter.take("recent").allowed).toBe(true);
    expect(limiter.take("recent").allowed).toBe(false);

    limiter.reset();
    expect(limiter.size()).toBe(0);
  });
});

describe("clientAddress", () => {
  const request = (forwarded?: string) => new Request("http://sideout.test/api/auth/request-code", { headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } });

  it("trusts no header at all when no proxy is declared", () => {
    expect(clientAddress(request("203.0.113.9"), 0)).toBeNull();
    expect(clientAddress(request("203.0.113.9, 10.0.0.1"), 0)).toBeNull();
    expect(clientAddress(request(), 0)).toBeNull();
  });

  it("takes the hop the trusted proxies appended, counting from the right", () => {
    // One proxy: the last entry is what it saw; anything the client wrote sits to the left.
    expect(clientAddress(request("1.1.1.1, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientAddress(request("203.0.113.9"), 1)).toBe("203.0.113.9");
    // Two proxies (e.g. CDN then load balancer): the client is second from the right.
    expect(clientAddress(request("spoofed, 203.0.113.9, 10.0.0.1"), 2)).toBe("203.0.113.9");
    expect(clientAddress(request(" 203.0.113.9 ,10.0.0.1 "), 2)).toBe("203.0.113.9");
  });

  it("yields no address when the chain is shorter than the declared proxies", () => {
    expect(clientAddress(request("10.0.0.1"), 2)).toBeNull();
    expect(clientAddress(request(), 1)).toBeNull();
    expect(clientAddress(request(""), 1)).toBeNull();
  });
});
