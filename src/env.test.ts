import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/env";
import { parsePublicEnv, publicLucraCredentials } from "@/env.public";

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
  it("only knows the mode, the WEB key and the tenant id", () => {
    const pub = parsePublicEnv({ NEXT_PUBLIC_LUCRA_TENANT_ID: "t", NEXT_PUBLIC_LUCRA_WEB_API_KEY: "" });
    expect(pub).toEqual({ NEXT_PUBLIC_LUCRA_MODE: "mock", NEXT_PUBLIC_LUCRA_TENANT_ID: "t", NEXT_PUBLIC_DEMO_ACCOUNTS: false });
    expect(Object.keys(pub)).not.toContain("LUCRA_BACKEND_API_KEY");
    expect(publicLucraCredentials(pub)).toBeNull();
    expect(publicLucraCredentials(parsePublicEnv({ NEXT_PUBLIC_LUCRA_TENANT_ID: "t", NEXT_PUBLIC_LUCRA_WEB_API_KEY: "web" }))).toEqual({ apiKey: "web", tenantId: "t" });
    expect(() => parsePublicEnv({ NEXT_PUBLIC_LUCRA_MODE: "staging" })).toThrow(/NEXT_PUBLIC_LUCRA_MODE/);
  });

  it("must agree with the server's LUCRA_MODE, and follows it when unset", () => {
    expect(parseServerEnv({ LUCRA_MODE: "mock" }).NEXT_PUBLIC_LUCRA_MODE).toBe("mock");
    const live = { LUCRA_MODE: "sandbox", LUCRA_BASE_URL: "https://api.sandbox.lucrasports.com", LUCRA_BACKEND_API_KEY: "sk_test" };
    expect(parseServerEnv(live).NEXT_PUBLIC_LUCRA_MODE).toBe("sandbox");
    expect(parseServerEnv({ ...live, NEXT_PUBLIC_LUCRA_MODE: "sandbox" }).NEXT_PUBLIC_LUCRA_MODE).toBe("sandbox");
    expect(() => parseServerEnv({ ...live, NEXT_PUBLIC_LUCRA_MODE: "mock" })).toThrow(/NEXT_PUBLIC_LUCRA_MODE: is mock but LUCRA_MODE is sandbox/);
    expect(() => parseServerEnv({ LUCRA_MODE: "mock", NEXT_PUBLIC_LUCRA_MODE: "production" })).toThrow(/NEXT_PUBLIC_LUCRA_MODE/);
  });

  it("demo accounts: off by default, only with the mock Lucra, and the browser's copy must agree", () => {
    expect(parseServerEnv({}).demoAccountsEnabled).toBe(false);
    expect(parseServerEnv({}).NEXT_PUBLIC_DEMO_ACCOUNTS).toBe(false);
    expect(parseServerEnv({ DEMO_ACCOUNTS: "false" }).demoAccountsEnabled).toBe(false);
    const on = parseServerEnv({ LUCRA_MODE: "mock", DEMO_ACCOUNTS: "true", DEMO_RESET_TOKEN: "x".repeat(32) });
    expect(on.demoAccountsEnabled).toBe(true);
    expect(on.NEXT_PUBLIC_DEMO_ACCOUNTS).toBe(true);
    expect(parseServerEnv({ DEMO_ACCOUNTS: "1", NEXT_PUBLIC_DEMO_ACCOUNTS: "true" }).demoAccountsEnabled).toBe(true);
    // Never beside real Lucra credentials, in any live mode.
    const live = { LUCRA_MODE: "sandbox", LUCRA_BASE_URL: "https://api.sandbox.lucrasports.com", LUCRA_BACKEND_API_KEY: "sk_test" };
    expect(() => parseServerEnv({ ...live, DEMO_ACCOUNTS: "true" })).toThrow(/DEMO_ACCOUNTS=true requires LUCRA_MODE=mock/);
    expect(() => parseServerEnv({ ...live, LUCRA_MODE: "production", DEMO_ACCOUNTS: "true" })).toThrow(/DEMO_ACCOUNTS/);
    // A build made one way and started the other.
    expect(() => parseServerEnv({ DEMO_ACCOUNTS: "true", NEXT_PUBLIC_DEMO_ACCOUNTS: "false" })).toThrow(/NEXT_PUBLIC_DEMO_ACCOUNTS: is false but DEMO_ACCOUNTS is true/);
    expect(() => parseServerEnv({ NEXT_PUBLIC_DEMO_ACCOUNTS: "true" })).toThrow(/NEXT_PUBLIC_DEMO_ACCOUNTS/);
    expect(() => parseServerEnv({ DEMO_ACCOUNTS: "true", DEMO_RESET_TOKEN: "short" })).toThrow(/DEMO_RESET_TOKEN/);
  });

  it("carries the installed SDK version and the responsible-play URLs", () => {
    const env = parseServerEnv({ LUCRA_MODE: "mock", LUCRA_SDK_INSTALLED_VERSION: " 1.12.0 " });
    expect(env.LUCRA_SDK_INSTALLED_VERSION).toBe("1.12.0");
    expect(parseServerEnv({ LUCRA_MODE: "mock" }).LUCRA_SDK_INSTALLED_VERSION).toBeUndefined();
    expect(env.LUCRA_SELF_LIMIT_URL).toMatch(/^https:\/\//);
    expect(() => parseServerEnv({ LUCRA_MODE: "mock", LUCRA_SELF_LIMIT_URL: "nope" })).toThrow(/LUCRA_SELF_LIMIT_URL/);
  });
});
