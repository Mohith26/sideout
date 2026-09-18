/**
 * The wall clock, behind one seam.
 *
 * `requestNow()` is for server rendering: server components render once per
 * request, so reading the clock at the top of a page is idempotent for that
 * render, and routing every read through this one function keeps the React
 * purity rule honest (no bare `Date.now()` in components).
 *
 * `Clock` is the injectable form for services (`@/server/*`) and anything that
 * must be deterministic under test: pass `systemClock` in production and a
 * fixed clock in tests.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock frozen at `ms`, optionally advanced by tests. */
export function fixedClock(ms: number): Clock & { advance(deltaMs: number): void; set(ms: number): void } {
  let current = ms;
  return {
    now: () => current,
    advance(deltaMs) {
      current += deltaMs;
    },
    set(next) {
      current = next;
    },
  };
}

export function requestNow(): number {
  return systemClock.now();
}
