import { z } from "zod";

/**
 * Environment values that are allowed to reach the browser. Only the Lucra WEB
 * key and tenant id may ever be public (spec §5, §7.1). Each variable is read
 * with a literal `process.env.NEXT_PUBLIC_*` access so Next.js can inline it
 * at build time; a dynamic lookup would silently produce `undefined`.
 *
 * This module is importable from client components. `src/env.ts` (server-only)
 * is not; see `src/env.boundary.test.ts`.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_LUCRA_WEB_API_KEY: z.string().trim().min(1).optional(),
  NEXT_PUBLIC_LUCRA_TENANT_ID: z.string().trim().min(1).optional(),
});

export type PublicEnv = z.infer<typeof publicSchema>;

export function parsePublicEnv(raw: {
  NEXT_PUBLIC_LUCRA_WEB_API_KEY?: string | undefined;
  NEXT_PUBLIC_LUCRA_TENANT_ID?: string | undefined;
}): PublicEnv {
  return publicSchema.parse({
    NEXT_PUBLIC_LUCRA_WEB_API_KEY: emptyToUndefined(raw.NEXT_PUBLIC_LUCRA_WEB_API_KEY),
    NEXT_PUBLIC_LUCRA_TENANT_ID: emptyToUndefined(raw.NEXT_PUBLIC_LUCRA_TENANT_ID),
  });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export const publicEnv: PublicEnv = parsePublicEnv({
  NEXT_PUBLIC_LUCRA_WEB_API_KEY: process.env.NEXT_PUBLIC_LUCRA_WEB_API_KEY,
  NEXT_PUBLIC_LUCRA_TENANT_ID: process.env.NEXT_PUBLIC_LUCRA_TENANT_ID,
});
