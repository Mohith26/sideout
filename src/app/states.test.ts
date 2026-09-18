import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every screen has a loading state whose skeleton matches its shape (spec
 * §14: no skeleton that does not match what loads) and sits under an error
 * boundary. Walks `src/app` for pages and checks the nearest `loading.tsx`
 * is the page's own or its segment's, composed from the Skeleton shapes.
 */
const APP = new URL("./", import.meta.url).pathname;

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "api") continue;
      out.push(...pages(full));
    } else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

/** The nearest loading.tsx at or above the page's directory, stopping at src/app. */
function nearestLoading(page: string): string | null {
  let dir = dirname(page);
  while (dir.startsWith(APP.replace(/\/$/, ""))) {
    const candidate = join(dir, "loading.tsx");
    if (existsSync(candidate)) return candidate;
    if (dir === APP.replace(/\/$/, "")) break;
    dir = dirname(dir);
  }
  return null;
}

/** Pages that render a redirect or a bare form before any data and need no skeleton of their own. */
const NO_LOADING = new Set(["organizer/page.tsx", "offline/page.tsx"]);

describe("route states", () => {
  const all = pages(APP).map((p) => relative(APP, p));

  it.each(all.filter((p) => !NO_LOADING.has(p)))("%s has a shape-matched loading state", (rel) => {
    const loading = nearestLoading(join(APP, rel));
    expect(loading, `loading.tsx for ${rel}`).not.toBeNull();
    // The skeleton belongs to this page's segment, not a distant ancestor: same directory, or the dynamic parent it shares a layout with.
    const distance = relative(dirname(loading ?? ""), dirname(join(APP, rel))).split("/").filter(Boolean).length;
    expect(distance, `${rel} uses ${relative(APP, loading ?? "")}`).toBeLessThanOrEqual(1);
    const source = readFileSync(loading ?? "", "utf8");
    expect(source).toMatch(/from "@\/components\/ui\/Skeleton"/);
  });

  it("every error boundary renders the shared RouteError and the root has a global one", () => {
    const boundaries = ["error.tsx", "t/[slug]/error.tsx", "m/[id]/error.tsx", "organizer/error.tsx"];
    for (const rel of boundaries) {
      const source = readFileSync(join(APP, rel), "utf8");
      expect(source, rel).toContain('"use client"');
      expect(source, rel).toContain("RouteError");
    }
    expect(existsSync(join(APP, "global-error.tsx"))).toBe(true);
    expect(existsSync(join(APP, "not-found.tsx"))).toBe(true);
  });
});
