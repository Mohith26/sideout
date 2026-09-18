import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex, WCAG_AA_NORMAL_TEXT } from "@/lib/contrast";

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

/** `color` at `alpha` over `surface`, as the browser composites a `bg-<color>/10` tint. */
function tint(color: string, surface: string, alpha: number): string {
  const c = parseHex(color);
  const s = parseHex(surface);
  const mix = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha)).toString(16).padStart(2, "0");
  return `#${mix(c.r, s.r)}${mix(c.g, s.g)}${mix(c.b, s.b)}`;
}
/** The strongest tint a semantic colour is laid on as a background under its own text: `bg-<color>/10` (pills, notices, badges). */
const MAX_TINT_ALPHA = 0.1;
const textTiers = ["text-primary", "text-secondary", "text-tertiary"] as const;
const semantic = ["ember", "surf", "fault"] as const;
const art = ["art-sky", "art-ocean", "art-palm", "art-sun", "art-sand"] as const;

describe("design tokens meet WCAG AA (spec §12.6)", () => {
  it("--volt on every surface, and --on-volt on --volt and on --volt-dim", () => {
    for (const surface of surfaces) expect(contrastRatio(token("volt"), token(surface)), `volt on ${surface}`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(token("on-volt"), token("volt"))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    expect(contrastRatio(token("on-volt"), token("volt-dim"))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
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

  it.each(semantic.flatMap((color) => surfaces.map((surface) => [color, surface] as const)))(
    "%s as text on its own tint over %s is at least 4.5:1",
    (color, surface) => {
      expect(contrastRatio(token(color), tint(token(color), token(surface), MAX_TINT_ALPHA))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );

  it("keeps the spec's hierarchy: primary stronger than secondary stronger than tertiary", () => {
    const base = token("bg-base");
    expect(contrastRatio(token("text-primary"), base)).toBeGreaterThan(contrastRatio(token("text-secondary"), base));
    expect(contrastRatio(token("text-secondary"), base)).toBeGreaterThan(contrastRatio(token("text-tertiary"), base));
  });

  it("is a light theme: every surface is lighter than every text tier", () => {
    expect(css).toMatch(/color-scheme:\s*light;/);
    for (const surface of surfaces) expect(contrastRatio("#ffffff", token(surface)), surface).toBeLessThan(1.3);
  });

  it("declares the illustration colours for the SVG art and keeps them out of the text tiers", () => {
    for (const name of art) expect(token(name)).toMatch(/^#[0-9a-f]{6}$/i);
    // Illustration colours are never text: none of them is one of the tiers or semantic colours.
    const reserved = new Set([...textTiers, ...semantic, "volt"].map(token));
    for (const name of art) expect(reserved.has(token(name)), name).toBe(false);
  });
});
