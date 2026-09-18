import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest, { MANIFEST_BACKGROUND, MANIFEST_THEME } from "@/app/manifest";

const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
const bgBase = /--bg-base:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1]?.toLowerCase();

describe("web app manifest", () => {
  it("is installable: name, standalone display, a start url, and icons at 192 and 512 with a maskable variant", () => {
    const m = manifest();
    expect(m.name).toBe("Sideout");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    const sizes = (m.icons ?? []).map((i) => `${i.purpose ?? "any"}:${i.sizes}`);
    expect(sizes).toEqual(expect.arrayContaining(["any:192x192", "any:512x512", "maskable:192x192", "maskable:512x512"]));
  });

  it("colors are the --bg-base token, and every icon file exists under public/", () => {
    expect(bgBase).toBeDefined();
    expect(MANIFEST_THEME).toBe(bgBase);
    expect(MANIFEST_BACKGROUND).toBe(bgBase);
    for (const icon of manifest().icons ?? []) {
      expect(existsSync(new URL(`../../public${icon.src}`, import.meta.url)), icon.src).toBe(true);
    }
  });
});
