import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

/**
 * Resolve the build sha once at build/dev start. `BUILD_SHA` (set by the deploy
 * platform or CI) wins; otherwise the git HEAD of the checkout; otherwise the
 * literal "unknown" so `/health` never lies about provenance.
 */
function resolveBuildSha(): string {
  const fromEnv = process.env.BUILD_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git checkout (e.g. a tarball deploy). Provenance is unknown, and
    // /health reports exactly that rather than inventing a value.
    return "unknown";
  }
}

/**
 * `POST /api/dev/login` lives in `route.dev.ts`. The `dev.ts` page extension is
 * registered only when dev login is enabled, so a normal production build does
 * not contain the route. Mirrors `isDevLoginEnabled` in `src/env.ts`, which
 * cannot be imported here (it is `server-only`).
 */
function devLoginEnabled(): boolean {
  const flag = (process.env.SIDEOUT_DEV_LOGIN ?? "").trim();
  return process.env.NODE_ENV !== "production" || flag === "true" || flag === "1";
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: devLoginEnabled() ? ["tsx", "ts", "jsx", "js", "dev.ts"] : ["tsx", "ts", "jsx", "js"],
  poweredByHeader: false,
  // Repo guidance for agents lives in AGENTS.md under our own control; keep
  // `next dev` from rewriting it on every start.
  agentRules: false,
  // better-sqlite3 is a native addon; it must be required by Node at runtime,
  // never bundled into the server build.
  serverExternalPackages: ["better-sqlite3"],
  env: {
    BUILD_SHA: resolveBuildSha(),
  },
};

export default nextConfig;
