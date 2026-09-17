import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/env";
import { parsePublicEnv } from "@/env.public";

describe("parseServerEnv", () => {
  it("boots with only LUCRA_MODE=mock", () => {
    const env = parseServerEnv({ LUCRA_MODE: "mock" });
    expect(env.LUCRA_MODE).toBe("mock");
    expect(env.FEATURE_REAL_MONEY).toBe(false);
    expect(env.DATABASE_PATH).toBe("./data/sideout.db");
    expect(env.BUILD_SHA).toBe("unknown");
    expect(env.LUCRA_BACKEND_API_KEY).toBeUndefined();
  });

  it("defaults LUCRA_MODE to mock and treats empty strings as unset", () => {
    const env = parseServerEnv({ LUCRA_MODE: "", LUCRA_BACKEND_API_KEY: "   ", DATABASE_PATH: "" });
    expect(env.LUCRA_MODE).toBe("mock");
    expect(env.LUCRA_BACKEND_API_KEY).toBeUndefined();
    expect(env.DATABASE_PATH).toBe("./data/sideout.db");
  });

  it("refuses sandbox or production without a base URL and backend key", () => {
    expect(() => parseServerEnv({ LUCRA_MODE: "sandbox" })).toThrow(/LUCRA_BASE_URL is required/);
    expect(() => parseServerEnv({ LUCRA_MODE: "production", LUCRA_BASE_URL: "https://api.lucrasports.com" })).toThrow(
      /LUCRA_BACKEND_API_KEY is required/,
    );
    const ok = parseServerEnv({
      LUCRA_MODE: "sandbox",
      LUCRA_BASE_URL: "https://api.sandbox.lucrasports.com",
      LUCRA_BACKEND_API_KEY: "sk_test",
    });
    expect(ok.LUCRA_MODE).toBe("sandbox");
  });

  it("rejects unknown modes and malformed URLs", () => {
    expect(() => parseServerEnv({ LUCRA_MODE: "staging" })).toThrow(/LUCRA_MODE/);
    expect(() => parseServerEnv({ LUCRA_MODE: "sandbox", LUCRA_BASE_URL: "not a url", LUCRA_BACKEND_API_KEY: "k" })).toThrow(
      /LUCRA_BASE_URL/,
    );
  });

  it("parses the real-money flag and refuses it in mock mode", () => {
    expect(parseServerEnv({ FEATURE_REAL_MONEY: "false" }).FEATURE_REAL_MONEY).toBe(false);
    expect(() => parseServerEnv({ FEATURE_REAL_MONEY: "true" })).toThrow(/FEATURE_REAL_MONEY cannot be enabled/);
    expect(() => parseServerEnv({ FEATURE_REAL_MONEY: "yes" })).toThrow(/FEATURE_REAL_MONEY/);
    const live = parseServerEnv({
      LUCRA_MODE: "sandbox",
      LUCRA_BASE_URL: "https://api.sandbox.lucrasports.com",
      LUCRA_BACKEND_API_KEY: "k",
      FEATURE_REAL_MONEY: "true",
    });
    expect(live.FEATURE_REAL_MONEY).toBe(true);
  });

  it("carries the public values through", () => {
    const env = parseServerEnv({ NEXT_PUBLIC_LUCRA_TENANT_ID: "tenant", NEXT_PUBLIC_LUCRA_WEB_API_KEY: "web" });
    expect(env.NEXT_PUBLIC_LUCRA_TENANT_ID).toBe("tenant");
    expect(env.NEXT_PUBLIC_LUCRA_WEB_API_KEY).toBe("web");
  });
});

describe("parsePublicEnv", () => {
  it("only knows the WEB key and tenant id", () => {
    const pub = parsePublicEnv({ NEXT_PUBLIC_LUCRA_TENANT_ID: "t", NEXT_PUBLIC_LUCRA_WEB_API_KEY: "" });
    expect(pub).toEqual({ NEXT_PUBLIC_LUCRA_TENANT_ID: "t" });
    expect(Object.keys(pub)).not.toContain("LUCRA_BACKEND_API_KEY");
  });
});
