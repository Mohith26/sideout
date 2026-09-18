import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLucraWebTheme, formatHsl, hexToHsl, LUCRA_THEME_SOURCE_TOKENS, LUCRA_WEB_THEME, LUCRA_WEB_THEME_OPTIONS } from "@/lucra/theme";

const css = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!m || !m[1]) throw new Error(`token --${name} not found in tokens.css`);
  return m[1].toLowerCase();
}

describe("Lucra web theme", () => {
  it("is built from the tokens the app renders with", () => {
    for (const [name, hex] of Object.entries(LUCRA_THEME_SOURCE_TOKENS)) expect(hex, `--${name}`).toBe(token(name));
  });

  it("converts hex to the HSL form Lucra's guide asks for", () => {
    expect(hexToHsl("#ffffff")).toEqual({ h: 0, s: 0, l: 100 });
    expect(hexToHsl("#000000")).toEqual({ h: 0, s: 0, l: 0 });
    expect(hexToHsl("#ff0000")).toEqual({ h: 0, s: 100, l: 50 });
    expect(hexToHsl("#00ff00")).toEqual({ h: 120, s: 100, l: 50 });
    expect(hexToHsl("#0000ff")).toEqual({ h: 240, s: 100, l: 50 });
    // Volt: a yellow-green at full lightness contrast, as any online converter reports it.
    expect(hexToHsl("#d7ff3e")).toEqual({ h: 72.4, s: 100, l: 62.2 });
    expect(formatHsl(hexToHsl("#d7ff3e"))).toBe("72.4 100% 62.2%");
    expect(() => hexToHsl("#abc")).toThrow(/6-digit/);
  });

  it("names every documented option exactly once, with volt as primary and on-volt on it", () => {
    expect(Object.keys(LUCRA_WEB_THEME).sort()).toEqual([...LUCRA_WEB_THEME_OPTIONS].sort());
    expect(LUCRA_WEB_THEME.primary).toBe(formatHsl(hexToHsl(token("volt"))));
    expect(LUCRA_WEB_THEME["on-primary"]).toBe(formatHsl(hexToHsl(token("on-volt"))));
    expect(LUCRA_WEB_THEME.secondary).toBe(formatHsl(hexToHsl(token("bg-overlay"))));
    expect(LUCRA_WEB_THEME["on-secondary"]).toBe(formatHsl(hexToHsl(token("text-primary"))));
    expect(LUCRA_WEB_THEME["bg-splash-img-color"]).toBe(formatHsl(hexToHsl(token("bg-base"))));
    // No decorative imagery (spec §14).
    expect(LUCRA_WEB_THEME["bg-landing-image"]).toBeNull();
    expect(LUCRA_WEB_THEME["bg-splash-img"]).toBeNull();
    expect(buildLucraWebTheme()).toEqual(LUCRA_WEB_THEME);
  });
});
