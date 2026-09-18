import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { pageExtensionsFor } from "./src/lib/build-gates";
import { LUCRA_SDK_PACKAGE } from "./src/lucra/version";

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
 * The `lucra-web-sdk` version actually installed, from its manifest. The
 * package's `exports` map hides `package.json` from `require.resolve`, so the
 * top-level install path is read directly. Reported by `/health` beside the
 * pin in `src/lucra/version.ts`; "unknown" when the package is absent, so
 * the health check can say so.
 */
function installedLucraSdkVersion(): string {
  try {
    const manifest = join(process.cwd(), "node_modules", LUCRA_SDK_PACKAGE, "package.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() !== "" ? parsed.version : "unknown";
  } catch {
    // Not installed (or a manifest that cannot be read): /health reports "unknown".
    return "unknown";
  }
}

/**
 * `POST /api/dev/login` (`route.dev.ts`) and `GET /api/rest/_mock/*`
 * (`route.mock.ts`) are registered by page extension, so a build that must
 * not contain them does not (`src/lib/build-gates.ts`; asserted by
 * `npm run test:bundle`).
 *
 * `NEXT_PUBLIC_LUCRA_MODE` is derived from `LUCRA_MODE` here so the browser
 * SDK (`src/components/lucra/LucraGate.tsx`) runs in the mode the server was
 * built for; `src/env.ts` refuses to boot when the two disagree.
 */
const lucraMode = (process.env.LUCRA_MODE ?? "").trim() || "mock";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: pageExtensionsFor(process.env),
  poweredByHeader: false,
  // Repo guidance for agents lives in AGENTS.md under our own control; keep
  // `next dev` from rewriting it on every start.
  agentRules: false,
  // better-sqlite3 is a native addon; it must be required by Node at runtime,
  // never bundled into the server build.
  serverExternalPackages: ["better-sqlite3"],
  env: {
    BUILD_SHA: resolveBuildSha(),
    NEXT_PUBLIC_LUCRA_MODE: lucraMode,
    LUCRA_SDK_INSTALLED_VERSION: installedLucraSdkVersion(),
  },
};

export default nextConfig;
