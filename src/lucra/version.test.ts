import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LUCRA_SDK_PACKAGE, LUCRA_SDK_SOURCE, LUCRA_SDK_VERSION } from "@/lucra/version";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Record<string, unknown>;

describe("Lucra SDK pin", () => {
  it("is a real semver and the install source names the same tag", () => {
    expect(LUCRA_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(LUCRA_SDK_SOURCE).toBe(`github:Lucra-Sports/${LUCRA_SDK_PACKAGE}#v${LUCRA_SDK_VERSION}`);
  });

  it("is what package.json pins, from the GitHub release tag", () => {
    const pkg = read("../../package.json") as { dependencies?: Record<string, string> };
    // OPEN: (§17.1) not on the public npm registry; the dependency is the GitHub tag, which is the version.
    expect(pkg.dependencies?.[LUCRA_SDK_PACKAGE]).toBe(LUCRA_SDK_SOURCE);
  });

  it("is what the lockfile resolved and what is installed", () => {
    const lock = read("../../package-lock.json") as { packages?: Record<string, { version?: string; resolved?: string }> };
    const entry = lock.packages?.[`node_modules/${LUCRA_SDK_PACKAGE}`];
    expect(entry?.version).toBe(LUCRA_SDK_VERSION);
    // A commit sha, not a floating ref: `npm ci` fetches exactly this tree.
    expect(entry?.resolved).toMatch(/^git\+.*Lucra-Sports\/lucra-web-sdk\.git#[0-9a-f]{40}$/);
    const installed = read(`../../node_modules/${LUCRA_SDK_PACKAGE}/package.json`) as { version?: string };
    expect(installed.version).toBe(LUCRA_SDK_VERSION);
  });
});
