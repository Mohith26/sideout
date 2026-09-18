import { randomBytes } from "node:crypto";
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

  it("trusts no proxy hop unless TRUSTED_PROXY_HOPS says how many there are", () => {
    expect(parseServerEnv({}).TRUSTED_PROXY_HOPS).toBe(0);
    expect(parseServerEnv({ TRUSTED_PROXY_HOPS: "" }).TRUSTED_PROXY_HOPS).toBe(0);
    expect(parseServerEnv({ TRUSTED_PROXY_HOPS: "2" }).TRUSTED_PROXY_HOPS).toBe(2);
    expect(() => parseServerEnv({ TRUSTED_PROXY_HOPS: "-1" })).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(() => parseServerEnv({ TRUSTED_PROXY_HOPS: "one" })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("caps sign-in codes process-wide at AUTH_CODE_GLOBAL_CAP, 2000 per ten minutes by default", () => {
    expect(parseServerEnv({}).AUTH_CODE_GLOBAL_CAP).toBe(2000);
    expect(parseServerEnv({ AUTH_CODE_GLOBAL_CAP: "500" }).AUTH_CODE_GLOBAL_CAP).toBe(500);
    expect(() => parseServerEnv({ AUTH_CODE_GLOBAL_CAP: "0" })).toThrow(/AUTH_CODE_GLOBAL_CAP/);
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

  it("reads the matcher interpretation, literal by default, and refuses anything else", () => {
    expect(parseServerEnv({ LUCRA_MODE: "mock" }).LUCRA_MATCHER_INTERPRETATION).toBe("literal");
    expect(parseServerEnv({ LUCRA_MODE: "mock", LUCRA_MATCHER_INTERPRETATION: "doc-examples" }).LUCRA_MATCHER_INTERPRETATION).toBe("doc-examples");
    expect(() => parseServerEnv({ LUCRA_MODE: "mock", LUCRA_MATCHER_INTERPRETATION: "lenient" })).toThrow(/LUCRA_MATCHER_INTERPRETATION/);
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
    const mint = () => randomBytes(32).toString("hex");
    const a = parseServerEnv({ NODE_ENV: "production" }, { mintEphemeralSecret: mint });
    const b = parseServerEnv({ NODE_ENV: "production" }, { mintEphemeralSecret: mint });
    expect(a.sessionSecretSource).toBe("ephemeral");
    expect(a.sessionSecret).not.toBe(b.sessionSecret);
    expect(a.sessionSecret).not.toBe(parseServerEnv({ NODE_ENV: "development" }).sessionSecret);
    expect(a.sessionSecret).toHaveLength(64);
  });

  it("shares one ephemeral secret across every module instance in the process", () => {
    // The server build evaluates env.ts once per route chunk; a cookie signed by the
    // sign-in route must verify in the page rendered next, so the default mint is process-wide.
    const a = parseServerEnv({ NODE_ENV: "production" });
    const b = parseServerEnv({ NODE_ENV: "production" });
    expect(a.sessionSecretSource).toBe("ephemeral");
    expect(a.sessionSecret).toBe(b.sessionSecret);
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
