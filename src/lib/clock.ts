/**
 * The wall clock for server rendering. Server components render once per
 * request, so reading the clock at the top of a page is idempotent for that
 * render; routing every read through this one function keeps the React purity
 * rule honest (no bare `Date.now()` in components) and gives tests one seam.
 */
export function requestNow(): number {
  return Date.now();
}
