import type { MetadataRoute } from "next";

/**
 * The web app manifest (spec §11: installable PWA). Colors are the two
 * background tokens from `src/styles/tokens.css` as literals, because the
 * manifest cannot read CSS; `src/app/manifest.test.ts` pins them to the
 * tokens. The icons are rendered from `public/icon.svg` by
 * `scripts/render-icons.ts`.
 */
export const MANIFEST_THEME = "#fbf2df";
export const MANIFEST_BACKGROUND = "#fbf2df";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sideout",
    short_name: "Sideout",
    description: "Charity beach volleyball tournaments: live play, standings, and what every event raises.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: MANIFEST_BACKGROUND,
    theme_color: MANIFEST_THEME,
    categories: ["sports"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
