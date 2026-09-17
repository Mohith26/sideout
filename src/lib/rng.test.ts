import { describe, expect, it } from "vitest";
import { createRng } from "@/lib/rng";

describe("createRng", () => {
  it("is deterministic for a seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const sa = Array.from({ length: 50 }, () => a.next());
    const sb = Array.from({ length: 50 }, () => b.next());
    expect(sa).toEqual(sb);
  });

  it("stays inside requested bounds", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i += 1) {
      const v = rng.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
      const f = rng.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it("shuffles without losing elements and refuses empty picks", () => {
    const rng = createRng(1);
    const items = [1, 2, 3, 4, 5, 6];
    expect([...rng.shuffle(items)].sort()).toEqual(items);
    expect(() => rng.pick([])).toThrow();
  });
});
