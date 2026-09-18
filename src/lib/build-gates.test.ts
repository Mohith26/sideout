import { describe, expect, it } from "vitest";
import { devLoginRouteEnabled, mockRouteEnabled, pageExtensionsFor } from "@/lib/build-gates";

describe("build gates", () => {
  it("registers the mock state route only for a mock build", () => {
    expect(mockRouteEnabled({})).toBe(true);
    expect(mockRouteEnabled({ LUCRA_MODE: "mock" })).toBe(true);
    expect(mockRouteEnabled({ LUCRA_MODE: "sandbox" })).toBe(false);
    expect(mockRouteEnabled({ LUCRA_MODE: "production" })).toBe(false);
    expect(pageExtensionsFor({ NODE_ENV: "production", LUCRA_MODE: "sandbox" })).toEqual(["tsx", "ts", "jsx", "js"]);
    expect(pageExtensionsFor({ NODE_ENV: "production", LUCRA_MODE: "mock" })).toEqual(["tsx", "ts", "jsx", "js", "mock.ts"]);
  });

  it("registers the dev login route outside production or when opted in", () => {
    expect(devLoginRouteEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(devLoginRouteEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(devLoginRouteEnabled({ NODE_ENV: "production", SIDEOUT_DEV_LOGIN: "true" })).toBe(true);
    expect(pageExtensionsFor({ NODE_ENV: "development" })).toEqual(["tsx", "ts", "jsx", "js", "dev.ts", "mock.ts"]);
  });
});
