/**
 * Build-time route gates, shared by `next.config.ts` and the tests that prove
 * them. A route file whose extension is not registered is not part of the
 * build at all — the only way to make a route provably absent.
 *
 * - `route.dev.ts`  (`POST /api/dev/login`) exists outside production, or in
 *   production only with `SIDEOUT_DEV_LOGIN=true`. Mirrors `isDevLoginEnabled`
 *   in `src/env.ts`, which is `server-only` and cannot be imported here.
 * - `route.mock.ts` (`GET /api/rest/_mock/state`) exists only when
 *   `LUCRA_MODE` is `mock` (the default) at build time.
 *
 * `npm run test:bundle` builds in sandbox mode and asserts neither route
 * directory exists under `.next/server`.
 */

export interface BuildGateEnv {
  NODE_ENV?: string | undefined;
  SIDEOUT_DEV_LOGIN?: string | undefined;
  LUCRA_MODE?: string | undefined;
}

const BASE_EXTENSIONS = ["tsx", "ts", "jsx", "js"] as const;

export function devLoginRouteEnabled(env: BuildGateEnv): boolean {
  const flag = (env.SIDEOUT_DEV_LOGIN ?? "").trim();
  return env.NODE_ENV !== "production" || flag === "true" || flag === "1";
}

export function mockRouteEnabled(env: BuildGateEnv): boolean {
  const mode = (env.LUCRA_MODE ?? "").trim();
  return mode === "" || mode === "mock";
}

export function pageExtensionsFor(env: BuildGateEnv): string[] {
  const extensions: string[] = [...BASE_EXTENSIONS];
  if (devLoginRouteEnabled(env)) extensions.push("dev.ts");
  if (mockRouteEnabled(env)) extensions.push("mock.ts");
  return extensions;
}
