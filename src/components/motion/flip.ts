/**
 * FLIP (first, last, invert, play) for a list of keyed elements, written
 * in-repo per spec §12.4 rather than pulled in as a dependency. Take a
 * snapshot of where each row sits, let the DOM change, take another, and
 * `flipMoves` says which rows moved and by how much; `playFlip` slides each
 * one from its old position with the Web Animations API. Under reduced motion
 * the same rows cross-fade instead: opacity is the only property animated.
 */

export interface FlipRect {
  top: number;
  left: number;
  /** The row's rank as rendered, so a rank change can flash even when the row did not move. */
  rank: string | null;
}
export type FlipSnapshot = Map<string, FlipRect>;

export interface FlipMove {
  key: string;
  dx: number;
  dy: number;
  rankFrom: string | null;
  rankTo: string | null;
}

export interface FlipOptions {
  durationMs: number;
  easing: string;
  reducedMotion: boolean;
}

export function snapshotRows(rows: Iterable<HTMLElement>, keyOf: (el: HTMLElement) => string | null): FlipSnapshot {
  const out: FlipSnapshot = new Map();
  for (const el of rows) {
    const key = keyOf(el);
    if (key === null) continue;
    const rect = el.getBoundingClientRect();
    out.set(key, { top: rect.top, left: rect.left, rank: el.dataset.rank ?? null });
  }
  return out;
}

/** Rows present in both snapshots that moved or changed rank; a new row has nowhere to move from. */
export function flipMoves(before: FlipSnapshot, after: FlipSnapshot): FlipMove[] {
  const moves: FlipMove[] = [];
  for (const [key, last] of after) {
    const first = before.get(key);
    if (!first) continue;
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0 && first.rank === last.rank) continue;
    moves.push({ key, dx, dy, rankFrom: first.rank, rankTo: last.rank });
  }
  return moves;
}

/** The keyframes one moved row plays: a slide from its old spot, or a cross-fade when motion is reduced. */
export function flipKeyframes(move: Pick<FlipMove, "dx" | "dy">, reducedMotion: boolean): Keyframe[] {
  if (reducedMotion) return [{ opacity: 0.35 }, { opacity: 1 }];
  return [{ transform: `translate(${move.dx}px, ${move.dy}px)` }, { transform: "none" }];
}

export function playFlip(rows: ReadonlyMap<string, HTMLElement>, moves: readonly FlipMove[], options: FlipOptions): void {
  for (const move of moves) {
    const el = rows.get(move.key);
    if (!el) continue;
    if ((move.dx !== 0 || move.dy !== 0) && typeof el.animate === "function") {
      el.animate(flipKeyframes(move, options.reducedMotion), { duration: options.durationMs, easing: options.easing });
    }
    if (move.rankFrom !== move.rankTo) flashRank(el, move);
  }
}

/** The rank delta as shown beside the rank: places climbed are positive. */
export function rankDelta(move: Pick<FlipMove, "rankFrom" | "rankTo">): number {
  const from = Number(move.rankFrom);
  const to = Number(move.rankTo);
  return Number.isFinite(from) && Number.isFinite(to) && move.rankFrom !== null && move.rankTo !== null ? from - to : 0;
}

/** A brief --surf flash on a row whose rank changed, with the delta in the row's slot (rank-flash in motion.css). */
function flashRank(el: HTMLElement, move: FlipMove): void {
  const delta = rankDelta(move);
  const slot = el.querySelector<HTMLElement>("[data-rank-delta-slot]");
  el.dataset.rankDelta = delta > 0 ? `+${delta}` : String(delta);
  if (slot) slot.textContent = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : "";
  el.classList.remove("rank-flash");
  void el.offsetWidth; // restart the animation when a row flashes twice in a row
  el.classList.add("rank-flash");
  el.addEventListener(
    "animationend",
    () => {
      el.classList.remove("rank-flash");
      delete el.dataset.rankDelta;
      if (slot) slot.textContent = "";
    },
    { once: true },
  );
}
