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

  it("parses the real-money flag, default off", () => {
    expect(parseServerEnv({}).FEATURE_REAL_MONEY).toBe(false);
    expect(parseServerEnv({ FEATURE_REAL_MONEY: "false" }).FEATURE_REAL_MONEY).toBe(false);
    expect(parseServerEnv({ FEATURE_REAL_MONEY: "true" }).FEATURE_REAL_MONEY).toBe(true);
    expect(parseServerEnv({ FEATURE_REAL_MONEY: "1" }).FEATURE_REAL_MONEY).toBe(true);
    expect(() => parseServerEnv({ FEATURE_REAL_MONEY: "yes" })).toThrow(/FEATURE_REAL_MONEY/);
  });

  it("carries the public values through", () => {
    const env = parseServerEnv({ NEXT_PUBLIC_LUCRA_TENANT_ID: "tenant", NEXT_PUBLIC_LUCRA_WEB_API_KEY: "web" });
    expect(env.NEXT_PUBLIC_LUCRA_TENANT_ID).toBe("tenant");
    expect(env.NEXT_PUBLIC_LUCRA_WEB_API_KEY).toBe("web");
  });
});

describe("session secret and dev login", () => {
  it("uses a fixed dev secret outside production and the env value when set", () => {
    const dev = parseServerEnv({ NODE_ENV: "development" });
    expect(dev.sessionSecretSource).toBe("dev-default");
    expect(dev.sessionSecret.length).toBeGreaterThan(16);
    const fromEnv = parseServerEnv({ NODE_ENV: "production", SESSION_SECRET: "a-real-secret-of-decent-length" });
    expect(fromEnv).toMatchObject({ sessionSecret: "a-real-secret-of-decent-length", sessionSecretSource: "env" });
    expect(() => parseServerEnv({ SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("never falls back to the dev secret in production: a missing secret is ephemeral and random", () => {
    const a = parseServerEnv({ NODE_ENV: "production" });
    const b = parseServerEnv({ NODE_ENV: "production" });
    expect(a.sessionSecretSource).toBe("ephemeral");
    expect(a.sessionSecret).not.toBe(b.sessionSecret);
    expect(a.sessionSecret).not.toBe(parseServerEnv({ NODE_ENV: "development" }).sessionSecret);
    expect(a.sessionSecret).toHaveLength(64);
  });

  it("compiles the dev login route in outside production, and in production only when opted in", () => {
    expect(parseServerEnv({ NODE_ENV: "development" }).devLoginEnabled).toBe(true);
    expect(parseServerEnv({ NODE_ENV: "test" }).devLoginEnabled).toBe(true);
    expect(parseServerEnv({ NODE_ENV: "production" }).devLoginEnabled).toBe(false);
    expect(parseServerEnv({ NODE_ENV: "production", SIDEOUT_DEV_LOGIN: "false" }).devLoginEnabled).toBe(false);
    expect(parseServerEnv({ NODE_ENV: "production", SIDEOUT_DEV_LOGIN: "true" }).devLoginEnabled).toBe(true);
  });
});

describe("parsePublicEnv", () => {
  it("only knows the WEB key and tenant id", () => {
    const pub = parsePublicEnv({ NEXT_PUBLIC_LUCRA_TENANT_ID: "t", NEXT_PUBLIC_LUCRA_WEB_API_KEY: "" });
    expect(pub).toEqual({ NEXT_PUBLIC_LUCRA_TENANT_ID: "t" });
    expect(Object.keys(pub)).not.toContain("LUCRA_BACKEND_API_KEY");
  });
});
