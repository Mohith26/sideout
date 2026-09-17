import { randomBytes } from "node:crypto";

/**
 * UUID v7 (RFC 9562): a 48-bit millisecond timestamp, version nibble 7, a
 * 12-bit monotonic counter in `rand_a`, the RFC variant bits, and 62 random
 * bits. Time-ordered ids sort correctly as strings and index well.
 *
 * The clock and randomness are injectable so the seed can mint reproducible,
 * still-well-formed ids from a fixed RNG and anchor time.
 */

export type RandomSource = (byteLength: number) => Uint8Array;

export interface UuidV7Options {
  /** Milliseconds since the Unix epoch. Defaults to `Date.now()`. */
  now?: () => number;
  /** Random byte source. Defaults to `crypto.randomBytes`. */
  random?: RandomSource;
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function bytesToUuid(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 16; i += 1) {
    const b = bytes[i];
    if (b === undefined) throw new Error("uuid: expected 16 bytes");
    s += HEX[b];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

/**
 * Create a generator. Each generator keeps its own (timestamp, counter) pair so
 * ids minted within the same millisecond stay strictly increasing.
 */
export function createUuidV7Generator(options: UuidV7Options = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? ((n) => new Uint8Array(randomBytes(n)));
  let lastMs = -1;
  let counter = 0;

  return function uuidv7(): string {
    let ms = now();
    if (!Number.isFinite(ms) || ms < 0 || ms > 0xffffffffffff) {
      throw new RangeError(`uuid: timestamp out of range: ${ms}`);
    }
    ms = Math.floor(ms);
    if (ms <= lastMs) {
      // Same or earlier millisecond (clock stall / regression): stay monotonic by
      // bumping the counter, and roll into the next ms if the counter is exhausted.
      ms = lastMs;
      counter += 1;
      if (counter > 0x0fff) {
        ms += 1;
        counter = 0;
      }
    } else {
      counter = 0;
    }
    lastMs = ms;

    const rnd = random(8);
    if (rnd.length < 8) throw new Error("uuid: random source returned too few bytes");
    const bytes = new Uint8Array(16);
    // 48-bit big-endian timestamp
    bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
    bytes[5] = ms & 0xff;
    // version 7 + 12-bit counter (rand_a)
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
    bytes[7] = counter & 0xff;
    // variant 10xx + 62 random bits (rand_b)
    bytes[8] = 0x80 | ((rnd[0] ?? 0) & 0x3f);
    for (let i = 1; i < 8; i += 1) bytes[8 + i] = rnd[i] ?? 0;
    return bytesToUuid(bytes);
  };
}

const defaultGenerator = createUuidV7Generator();

/** Mint a UUID v7 with the process clock and CSPRNG. */
export function uuidv7(): string {
  return defaultGenerator();
}

export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value);
}

/** First 8 hex chars, used for human-readable references like `lucra_external_id`. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
