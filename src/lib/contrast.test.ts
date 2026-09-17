import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex, relativeLuminance } from "@/lib/contrast";

describe("contrast", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(relativeLuminance(parseHex("#FFFFFF"))).toBeCloseTo(1, 5);
  });

  it("rejects malformed colors", () => {
    expect(() => parseHex("#fff")).toThrow();
    expect(() => parseHex("red")).toThrow();
  });
});
