import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parsePublicEnv, type PublicEnv } from "@/env.public";
import { log } from "@/lib/log";
import { MATCHER_INTERPRETATIONS } from "@/lucra/matcher";

/**
 * Server environment, parsed once at boot. Importing this module from client
 * code is a build error (`server-only`), and `npm run test:bundle` proves over
 * the built output that the BACKEND Lucra key reaches no client bundle
 * (spec §5, acceptance #12).
 */

export const LUCRA_MODES = ["mock", "sandbox", "production"] as const;
export type LucraMode = (typeof LUCRA_MODES)[number];

const booleanFromEnv = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0"), z.literal("")])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const serverSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LUCRA_MODE: z.enum(LUCRA_MODES).default("mock"),
    LUCRA_BASE_URL: z.url().optional(),
    LUCRA_BACKEND_API_KEY: z.string().min(1).optional(),
    LUCRA_WEBHOOK_SECRET: z.string().min(1).optional(),
    /**
     * Which reading of Lucra's documented metadata matcher the mock runs
     * (`src/lucra/matcher.ts`): `literal` follows the prose, `doc-examples`
     * the published worked examples where the two disagree. Reported by /health.
     */
    LUCRA_MATCHER_INTERPRETATION: z.enum(MATCHER_INTERPRETATIONS).default("literal"),
    FEATURE_REAL_MONEY: booleanFromEnv,
    DATABASE_PATH: z.string().trim().min(1).default("./data/sideout.db"),
    BUILD_SHA: z.string().trim().min(1).default("unknown"),
    /** Signs the session cookie. Required in production; see `resolveSessionSecret`. */
    SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters").optional(),
    /**
     * Compiles in `POST /api/dev/login` (sign in as a seeded user by id) for a
     * production build that is only ever a test target, e.g. Playwright.
     * Never set on a public deployment. Outside production the route always exists.
     */
    SIDEOUT_DEV_LOGIN: booleanFromEnv,
    /**
     * How many trusted reverse proxies sit in front of this process. Each one
     * appends the address it saw to `x-forwarded-for`, so the client address is
     * that many hops from the right. With 0 (the default) the header is
     * ignored: a Next.js route handler has no socket address of its own and a
     * client can write the header itself, so no per-address rate limit applies.
     */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),
    /**
     * Process-wide cap on sign-in codes issued per ten minutes: the backstop
     * that bounds rows, texts and log lines when no client address can be
     * trusted. Size it to the largest crowd expected to sign in at once.
     */
    AUTH_CODE_GLOBAL_CAP: z.coerce.number().int().min(1).max(1_000_000).default(2000),
    /**
     * Lucra's responsible gaming policy, linked wherever a wallet or reward is
     * shown (spec §4.7). Configuration rather than copy so the deployment can
     * point at the page Lucra names for the tenant.
     */
    LUCRA_RESPONSIBLE_GAMING_URL: z.url().default("https://lucrasports.com/pages/responsible-gaming.html"),
  })
  .superRefine((env, ctx) => {
    // OPEN: (§17.1) sandbox credentials are issued by a Lucra representative. The
    // fallback is mock mode, which needs nothing. Any live mode must be fully
    // configured or the process refuses to start rather than half-working.
    if (env.LUCRA_MODE !== "mock") {
      if (!env.LUCRA_BASE_URL) {
        ctx.addIssue({
          code: "custom",
          path: ["LUCRA_BASE_URL"],
          message: `LUCRA_BASE_URL is required when LUCRA_MODE=${env.LUCRA_MODE}`,
        });
      }
      if (!env.LUCRA_BACKEND_API_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["LUCRA_BACKEND_API_KEY"],
          message: `LUCRA_BACKEND_API_KEY is required when LUCRA_MODE=${env.LUCRA_MODE}`,
        });
      }
    }
  });

export type SessionSecretSource = "env" | "dev-default" | "ephemeral";

export interface DerivedEnv {
  /** The resolved signing secret and where it came from (reported by /health). */
  sessionSecret: string;
  sessionSecretSource: SessionSecretSource;
  /** `POST /api/dev/login` exists in this process. */
  devLoginEnabled: boolean;
}

export type ServerEnv = z.infer<typeof serverSchema> & PublicEnv & DerivedEnv;

const DEV_SESSION_SECRET = "sideout-dev-session-secret-never-in-production";

declare global {
  var __sideoutEphemeralSessionSecret: string | undefined;
}

/**
 * The random secret a production process without SESSION_SECRET signs with.
 * Kept on `globalThis` because the server build bundles this module into
 * every route's chunk: a module-level value would be minted once per chunk,
 * and a cookie issued by the sign-in route would fail to verify in the page
 * that renders next. One process, one secret.
 */
function ephemeralSessionSecret(): string {
  globalThis.__sideoutEphemeralSessionSecret ??= randomBytes(32).toString("hex");
  return globalThis.__sideoutEphemeralSessionSecret;
}

/**
 * Outside production a fixed dev secret keeps local sessions valid across
 * restarts. In production the secret must come from the environment; when it
 * is missing the process still boots (so `next build` and a smoke deploy work)
 * but signs with a random per-process secret and says so loudly — every
 * session dies on restart and a multi-instance deploy cannot share them.
 * `mint` exists so tests can prove the fallback is random; the app shares one
 * secret across every module instance in the process.
 */
export function resolveSessionSecret(
  env: { NODE_ENV: string; SESSION_SECRET?: string | undefined },
  mint: () => string = ephemeralSessionSecret,
): {
  sessionSecret: string;
  sessionSecretSource: SessionSecretSource;
} {
  if (env.SESSION_SECRET) return { sessionSecret: env.SESSION_SECRET, sessionSecretSource: "env" };
  if (env.NODE_ENV !== "production") return { sessionSecret: DEV_SESSION_SECRET, sessionSecretSource: "dev-default" };
  return { sessionSecret: mint(), sessionSecretSource: "ephemeral" };
}

/** The dev-login route is compiled in outside production, or in production only when explicitly opted in. */
export function isDevLoginEnabled(env: { NODE_ENV: string; SIDEOUT_DEV_LOGIN: boolean }): boolean {
  return env.NODE_ENV !== "production" || env.SIDEOUT_DEV_LOGIN;
}

type RawEnv = Record<string, string | undefined>;

function emptyToUndefined(raw: RawEnv): RawEnv {
  const out: RawEnv = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v === undefined || v.trim() === "" ? undefined : v;
  }
  return out;
}

/** Parse a raw environment. Exposed for tests; the app uses the `env` singleton. */
export function parseServerEnv(raw: RawEnv, options: { mintEphemeralSecret?: () => string } = {}): ServerEnv {
  const cleaned = emptyToUndefined(raw);
  const parsed = serverSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid server environment:\n${lines.join("\n")}`);
  }
  const pub = parsePublicEnv({
    NEXT_PUBLIC_LUCRA_WEB_API_KEY: cleaned.NEXT_PUBLIC_LUCRA_WEB_API_KEY,
    NEXT_PUBLIC_LUCRA_TENANT_ID: cleaned.NEXT_PUBLIC_LUCRA_TENANT_ID,
  });
  return {
    ...parsed.data,
    ...pub,
    ...resolveSessionSecret(parsed.data, options.mintEphemeralSecret),
    devLoginEnabled: isDevLoginEnabled(parsed.data),
  };
}

// Literal `process.env.X` reads so Next.js can inline build-time values (BUILD_SHA
// comes from next.config's `env` block); a bare `process.env` pass-through would
// miss them at runtime under `next start`.
export const env: ServerEnv = parseServerEnv({
  NODE_ENV: process.env.NODE_ENV,
  LUCRA_MODE: process.env.LUCRA_MODE,
  LUCRA_BASE_URL: process.env.LUCRA_BASE_URL,
  LUCRA_BACKEND_API_KEY: process.env.LUCRA_BACKEND_API_KEY,
  LUCRA_WEBHOOK_SECRET: process.env.LUCRA_WEBHOOK_SECRET,
  LUCRA_MATCHER_INTERPRETATION: process.env.LUCRA_MATCHER_INTERPRETATION,
  FEATURE_REAL_MONEY: process.env.FEATURE_REAL_MONEY,
  DATABASE_PATH: process.env.DATABASE_PATH,
  BUILD_SHA: process.env.BUILD_SHA,
  NEXT_PUBLIC_LUCRA_WEB_API_KEY: process.env.NEXT_PUBLIC_LUCRA_WEB_API_KEY,
  NEXT_PUBLIC_LUCRA_TENANT_ID: process.env.NEXT_PUBLIC_LUCRA_TENANT_ID,
  SESSION_SECRET: process.env.SESSION_SECRET,
  SIDEOUT_DEV_LOGIN: process.env.SIDEOUT_DEV_LOGIN,
  TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS,
  AUTH_CODE_GLOBAL_CAP: process.env.AUTH_CODE_GLOBAL_CAP,
  LUCRA_RESPONSIBLE_GAMING_URL: process.env.LUCRA_RESPONSIBLE_GAMING_URL,
});

if (env.sessionSecretSource === "ephemeral") {
  log.warn("SESSION_SECRET is not set: signing sessions with a random per-process secret; every session ends when this process does");
}
if (env.NODE_ENV === "production" && env.devLoginEnabled) {
  log.warn("SIDEOUT_DEV_LOGIN is set: POST /api/dev/login is compiled into this production build; never do this on a public deployment");
}
if (!env.LUCRA_WEBHOOK_SECRET && (env.LUCRA_MODE !== "mock" || env.NODE_ENV === "production")) {
  // OPEN: (§17.3) without a shared secret no delivery can be verified; the receiver refuses every event until one is configured.
  // In mock mode outside production a per-process random secret stands in (`resolveWebhookSecret`); production never falls back.
  log.warn("LUCRA_WEBHOOK_SECRET is not set: POST /api/webhooks/lucra cannot verify any signature and will answer 401 to every delivery until it is", { lucraMode: env.LUCRA_MODE, nodeEnv: env.NODE_ENV });
}
if (env.NODE_ENV === "production" && env.TRUSTED_PROXY_HOPS === 0) {
  log.warn("TRUSTED_PROXY_HOPS is 0: no client address is trusted, so sign-in is rate-limited per phone and process-wide only; set it to the number of proxies in front of this server (1 behind a single proxy)");
}
