import "server-only";
import { z } from "zod";
import { parsePublicEnv, type PublicEnv } from "@/env.public";

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
    FEATURE_REAL_MONEY: booleanFromEnv,
    DATABASE_PATH: z.string().trim().min(1).default("./data/sideout.db"),
    BUILD_SHA: z.string().trim().min(1).default("unknown"),
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

export type ServerEnv = z.infer<typeof serverSchema> & PublicEnv;

type RawEnv = Record<string, string | undefined>;

function emptyToUndefined(raw: RawEnv): RawEnv {
  const out: RawEnv = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v === undefined || v.trim() === "" ? undefined : v;
  }
  return out;
}

/** Parse a raw environment. Exposed for tests; the app uses the `env` singleton. */
export function parseServerEnv(raw: RawEnv): ServerEnv {
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
  return { ...parsed.data, ...pub };
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
  FEATURE_REAL_MONEY: process.env.FEATURE_REAL_MONEY,
  DATABASE_PATH: process.env.DATABASE_PATH,
  BUILD_SHA: process.env.BUILD_SHA,
  NEXT_PUBLIC_LUCRA_WEB_API_KEY: process.env.NEXT_PUBLIC_LUCRA_WEB_API_KEY,
  NEXT_PUBLIC_LUCRA_TENANT_ID: process.env.NEXT_PUBLIC_LUCRA_TENANT_ID,
});
