/**
 * Sideout's palette expressed as Lucra's web theming configuration (spec
 * §7.5: the SDK iframe "must be themed to Sideout's palette via Lucra's web
 * theming configuration").
 *
 * Lucra's Web Theming Guide (`readme/whats-included/branding-and-theming/
 * web-theming-guide`) publishes exactly ten options, colors in HSL, and no
 * runtime API for them: the web SDK's `LucraClient.initialize` takes only the
 * credentials, and the mobile guides say colors "are used for primary and
 * secondary call-to-actions, other colors in the experience are owned by
 * Lucra". The values below are therefore what Sideout hands to its Lucra
 * representative for the tenant, computed from the same tokens the app
 * renders with; `theme.test.ts` asserts each source hex against
 * `src/styles/tokens.css` so the two cannot drift. `/admin/lucra` shows them
 * so an engineer can copy them without reading source. The mock stand-in
 * (`sdk-mock.ts`) renders on the design system directly, which is what the
 * themed iframe looks like once Lucra applies these.
 *
 * Client-safe: no Node built-ins, no server env.
 */

export const LUCRA_WEB_THEME_OPTIONS = ["bg-landing-image", "bg-landing-image-color", "bg-menu-img", "bg-select-game-img", "bg-splash-img", "bg-splash-img-color", "primary", "secondary", "on-primary", "on-secondary"] as const;
export type LucraWebThemeOption = (typeof LUCRA_WEB_THEME_OPTIONS)[number];

/** The tokens the theme is built from, as `tokens.css` defines them (asserted by the test). */
export const LUCRA_THEME_SOURCE_TOKENS = {
  "bg-base": "#08090b",
  "bg-overlay": "#171a1f",
  "text-primary": "#f4f5f7",
  volt: "#d7ff3e",
  "on-volt": "#08090b",
} as const;

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** `#rrggbb` → HSL with the hue in degrees and saturation/lightness in percent, each rounded to one decimal. */
export function hexToHsl(hex: string): Hsl {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) throw new Error(`hexToHsl: not a 6-digit hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return { h: round1(h), s: round1(s * 100), l: round1(l * 100) };
}

/** The `H S% L%` form the guide's converter produces (space-separated, no commas). */
export function formatHsl({ h, s, l }: Hsl): string {
  return `${h} ${s}% ${l}%`;
}

export type LucraWebTheme = Record<LucraWebThemeOption, string | null>;

/**
 * The ten documented options. Images are `null`: Sideout ships no splash,
 * landing or menu art (spec §14 allows one editorial image and it must carry
 * information; a Lucra backdrop would not). `primary` is volt with `on-volt`
 * text, the one action color; `secondary` is the overlay surface with primary
 * text, which is what Sideout's own secondary buttons are.
 */
export function buildLucraWebTheme(tokens: typeof LUCRA_THEME_SOURCE_TOKENS = LUCRA_THEME_SOURCE_TOKENS): LucraWebTheme {
  const hsl = (hex: string) => formatHsl(hexToHsl(hex));
  return {
    "bg-landing-image": null,
    "bg-landing-image-color": hsl(tokens["bg-base"]),
    "bg-menu-img": null,
    "bg-select-game-img": null,
    "bg-splash-img": null,
    "bg-splash-img-color": hsl(tokens["bg-base"]),
    primary: hsl(tokens.volt),
    "on-primary": hsl(tokens["on-volt"]),
    secondary: hsl(tokens["bg-overlay"]),
    "on-secondary": hsl(tokens["text-primary"]),
  };
}

export const LUCRA_WEB_THEME: LucraWebTheme = buildLucraWebTheme();
