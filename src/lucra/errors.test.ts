import { describe, expect, it } from "vitest";
import { isLucraError, LUCRA_ERROR_CODES, LucraError } from "@/lucra/errors";

describe("isLucraError", () => {
  it("recognizes its own class and any error with the same name and a sealed code, not by identity", () => {
    expect(isLucraError(new LucraError("matchup_not_found", "none", { body: { count: 0 } }))).toBe(true);
    // A production server bundles errors.ts once per route while the adapter is one process-wide instance:
    // an error thrown through it arrives in another route as a distinct class with the same shape.
    class OtherBundleLucraError extends Error {
      constructor(
        readonly code: string,
        readonly detail: Record<string, unknown>,
      ) {
        super("from another bundle");
        this.name = "LucraError";
      }
    }
    for (const code of LUCRA_ERROR_CODES) expect(isLucraError(new OtherBundleLucraError(code, {})), code).toBe(true);
    expect(isLucraError(new OtherBundleLucraError("not_a_code", {}))).toBe(false);
    const nameless = new Error("x") as Error & { code: string; detail: object };
    nameless.code = "timeout";
    nameless.detail = {};
    expect(isLucraError(nameless)).toBe(false);
    expect(isLucraError({ name: "LucraError", code: "timeout", detail: {} })).toBe(false);
    expect(isLucraError(null)).toBe(false);
  });
});
