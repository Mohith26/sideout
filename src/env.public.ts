import { z } from "zod";

/**
 * Environment values that are allowed to reach the browser. Only the Lucra WEB
 * key and tenant id may ever be public (spec §5, §7.1), plus the mode the
 * browser SDK should run in. Each variable is read with a literal
 * `process.env.NEXT_PUBLIC_*` access so Next.js can inline it at build time; a
 * dynamic lookup would silently produce `undefined`.
 *
 * `NEXT_PUBLIC_LUCRA_MODE` is derived from `LUCRA_MODE` by `next.config.ts` so
 * the two cannot disagree by accident; `src/env.ts` refuses to boot when they
 * do. In `mock` the browser loads `src/lucra/sdk-mock.ts` instead of the real
 * SDK and needs no credentials; `sandbox` and `production` need both.
 *
 * This module is importable from client components. `src/env.ts` (server-only)
 * is not; `npm run test:bundle` proves it over the built output.
 */
export const PUBLIC_LUCRA_MODES = ["mock", "sandbox", "production"] as const;
export type PublicLucraMode = (typeof PUBLIC_LUCRA_MODES)[number];

const booleanFromEnv = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const publicSchema = z.object({
  NEXT_PUBLIC_LUCRA_MODE: z.enum(PUBLIC_LUCRA_MODES).default("mock"),
  /**
   * The browser's copy of `DEMO_ACCOUNTS` (`src/env.ts`), derived by
   * `next.config.ts` so the two cannot disagree by accident; the server refuses
   * to boot when they do. Only ever `true` on a public demo host in mock mode.
   */
  NEXT_PUBLIC_DEMO_ACCOUNTS: booleanFromEnv,
  NEXT_PUBLIC_LUCRA_WEB_API_KEY: z.string().trim().min(1).optional(),
  NEXT_PUBLIC_LUCRA_TENANT_ID: z.string().trim().min(1).optional(),
});

export type PublicEnv = z.infer<typeof publicSchema>;

export interface RawPublicEnv {
  NEXT_PUBLIC_LUCRA_MODE?: string | undefined;
  NEXT_PUBLIC_LUCRA_WEB_API_KEY?: string | undefined;
  NEXT_PUBLIC_LUCRA_TENANT_ID?: string | undefined;
  NEXT_PUBLIC_DEMO_ACCOUNTS?: string | undefined;
}

export function parsePublicEnv(raw: RawPublicEnv): PublicEnv {
  return publicSchema.parse({
    NEXT_PUBLIC_LUCRA_MODE: emptyToUndefined(raw.NEXT_PUBLIC_LUCRA_MODE),
    NEXT_PUBLIC_LUCRA_WEB_API_KEY: emptyToUndefined(raw.NEXT_PUBLIC_LUCRA_WEB_API_KEY),
    NEXT_PUBLIC_LUCRA_TENANT_ID: emptyToUndefined(raw.NEXT_PUBLIC_LUCRA_TENANT_ID),
    NEXT_PUBLIC_DEMO_ACCOUNTS: emptyToUndefined(raw.NEXT_PUBLIC_DEMO_ACCOUNTS),
  });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * The browser SDK's credentials for a live mode, or `null` while either is
 * missing (the gate then renders its "not configured" state rather than
 * initializing with a half-set pair, which the SDK refuses anyway).
 */
export function publicLucraCredentials(env: Pick<PublicEnv, "NEXT_PUBLIC_LUCRA_WEB_API_KEY" | "NEXT_PUBLIC_LUCRA_TENANT_ID">): { apiKey: string; tenantId: string } | null {
  if (!env.NEXT_PUBLIC_LUCRA_WEB_API_KEY || !env.NEXT_PUBLIC_LUCRA_TENANT_ID) return null;
  return { apiKey: env.NEXT_PUBLIC_LUCRA_WEB_API_KEY, tenantId: env.NEXT_PUBLIC_LUCRA_TENANT_ID };
}

export const publicEnv: PublicEnv = parsePublicEnv({
  NEXT_PUBLIC_LUCRA_MODE: process.env.NEXT_PUBLIC_LUCRA_MODE,
  NEXT_PUBLIC_LUCRA_WEB_API_KEY: process.env.NEXT_PUBLIC_LUCRA_WEB_API_KEY,
  NEXT_PUBLIC_LUCRA_TENANT_ID: process.env.NEXT_PUBLIC_LUCRA_TENANT_ID,
  NEXT_PUBLIC_DEMO_ACCOUNTS: process.env.NEXT_PUBLIC_DEMO_ACCOUNTS,
});
