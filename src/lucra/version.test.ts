import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LUCRA_SDK_PACKAGE, LUCRA_SDK_SOURCE, LUCRA_SDK_VERSION } from "@/lucra/version";

describe("Lucra SDK pin", () => {
  it("is a real semver and the install source names the same tag", () => {
    expect(LUCRA_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(LUCRA_SDK_SOURCE).toBe(`github:Lucra-Sports/${LUCRA_SDK_PACKAGE}#v${LUCRA_SDK_VERSION}`);
  });

  it("agrees with package.json whenever the package is listed there", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const pinned = pkg.dependencies?.[LUCRA_SDK_PACKAGE] ?? pkg.devDependencies?.[LUCRA_SDK_PACKAGE];
    // OPEN: (§17.1) not on the public npm registry, so it is not listed today; the moment it is, the pin must match.
    if (pinned !== undefined) expect(pinned.replace(/^[^\d]*/, "")).toBe(LUCRA_SDK_VERSION);
    else expect(pinned).toBeUndefined();
  });
});
