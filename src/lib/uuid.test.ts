import { describe, expect, it } from "vitest";
import { createUuidV7Generator, isUuidV7, shortId, uuidv7, uuidV7Timestamp } from "@/lib/uuid";

describe("uuidv7", () => {
  it("produces RFC 9562 v7 formatted ids", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = uuidv7();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isUuidV7(id)).toBe(true);
    }
  });

  it("embeds the millisecond timestamp in the first 48 bits", () => {
    const at = 1_800_000_000_000;
    const gen = createUuidV7Generator({ now: () => at, random: (n) => new Uint8Array(n) });
    expect(uuidV7Timestamp(gen())).toBe(at);
  });

  it("is strictly increasing within one millisecond and across time", () => {
    let t = 1_700_000_000_000;
    const gen = createUuidV7Generator({ now: () => t, random: (n) => new Uint8Array(n).fill(0xff) });
    const ids: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      if (i % 700 === 0) t += 1;
      ids.push(gen());
    }
    for (let i = 1; i < ids.length; i += 1) {
      const prev = ids[i - 1];
      const cur = ids[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      expect(cur! > prev!).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not go backwards if the clock regresses", () => {
    const times = [1000, 999, 998, 1000, 1001];
    let i = 0;
    const gen = createUuidV7Generator({ now: () => times[i++] ?? 1001, random: (n) => new Uint8Array(n) });
    const ids = times.map(() => gen());
    for (let k = 1; k < ids.length; k += 1) expect(ids[k]! > ids[k - 1]!).toBe(true);
  });

  it("rejects non-v7 values and exposes a short id", () => {
    expect(isUuidV7("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(() => uuidV7Timestamp("nope")).toThrow();
    const id = uuidv7();
    expect(shortId(id)).toBe(id.slice(0, 8));
  });
});
