import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, WCAG_AA_NORMAL_TEXT } from "@/lib/contrast";

/**
 * Reads the real token file so the assertion tracks whatever ships, not a copy
 * of the values pasted into the test.
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!m || !m[1]) throw new Error(`token --${name} not found in tokens.css`);
  return m[1];
}

const surfaces = ["bg-base", "bg-raised", "bg-overlay", "bg-inset"] as const;
const textTiers = ["text-primary", "text-secondary", "text-tertiary"] as const;
const semantic = ["ember", "surf", "fault"] as const;

describe("design tokens meet WCAG AA (spec §12.6)", () => {
  it("--volt on --bg-base and --on-volt on --volt", () => {
    expect(contrastRatio(token("volt"), token("bg-base"))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(token("on-volt"), token("volt"))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it.each(textTiers.flatMap((tier) => surfaces.map((surface) => [tier, surface] as const)))(
    "%s on %s is at least 4.5:1",
    (tier, surface) => {
      expect(contrastRatio(token(tier), token(surface))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );

  it.each(semantic.flatMap((color) => surfaces.map((surface) => [color, surface] as const)))(
    "%s used as text on %s is at least 4.5:1",
    (color, surface) => {
      expect(contrastRatio(token(color), token(surface))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );

  it("keeps the spec's hierarchy: primary lighter than secondary lighter than tertiary", () => {
    const base = token("bg-base");
    expect(contrastRatio(token("text-primary"), base)).toBeGreaterThan(contrastRatio(token("text-secondary"), base));
    expect(contrastRatio(token("text-secondary"), base)).toBeGreaterThan(contrastRatio(token("text-tertiary"), base));
  });

  it("defines the motion tokens and the reduced-motion wrapper once", () => {
    for (const name of ["ease-out-expo", "ease-in-out-quart", "d-micro", "d-base", "d-enter", "d-draw"]) {
      expect(css).toMatch(new RegExp(`--${name}:`));
    }
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-property: opacity !important");
  });

  it("radii follow §12.3 exactly", () => {
    expect(css).toMatch(/--r-xs:\s*4px/);
    expect(css).toMatch(/--r-sm:\s*6px/);
    expect(css).toMatch(/--r-md:\s*10px/);
    expect(css).toMatch(/--r-lg:\s*14px/);
    expect(css).toMatch(/--r-full:\s*999px/);
  });
});
