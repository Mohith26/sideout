/**
 * Small deterministic PRNG (SplitMix32) for reproducible seed data. Not for
 * anything security-related; ids and secrets use `node:crypto` in production.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Pick one element; throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Random bytes for the UUID generator. */
  bytes(length: number): Uint8Array;
  /** True with probability `p`. */
  chance(p: number): boolean;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const nextU32 = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  };

  const next = (): number => nextU32() / 4294967296;

  return {
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`rng.int: max ${max} < min ${min}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError("rng.pick: empty list");
      const idx = Math.floor(next() * items.length);
      const item = items[idx];
      if (item === undefined) throw new RangeError("rng.pick: index out of range");
      return item;
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i];
        const b = out[j];
        if (a === undefined || b === undefined) continue;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) out[i] = nextU32() & 0xff;
      return out;
    },
    chance(p) {
      return next() < p;
    },
  };
}
