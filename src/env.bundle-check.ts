import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { log } from "@/lib/log";

/**
 * `npm run test:bundle` — spec §5 and acceptance #12: the BACKEND Lucra key
 * never reaches a client bundle. Builds the app with a sentinel value in
 * `LUCRA_BACKEND_API_KEY`, then scans everything Next emits for the browser
 * (`.next/static`, the only folder a CDN ever serves) for the sentinel and for
 * the variable name itself. Either string in that output means a client module
 * reached the server env. `server-only` on `src/env.ts` is the build-time guard;
 * this is the proof over the artifact.
 *
 * The same build must not contain `POST /api/dev/login`: `next.config.ts`
 * registers its `dev.ts` page extension only outside production or with
 * `SIDEOUT_DEV_LOGIN=true`, and this build sets neither.
 *
 * Nor may the client output carry Node's `crypto` polyfill: the score sheet
 * judges legality in the browser with `@/domain/scoreline`, and the hash that
 * needs `node:crypto` lives in `@/domain/scoreline-hash` so a client component
 * that reaches it would pull the whole `crypto-browserify` bundle down to a
 * phone on the sand.
 */
const VARIABLE_NAME = "LUCRA_BACKEND_API_KEY";
const SENTINEL = "sideout-backend-key-sentinel-4b1f9e2d";
const CRYPTO_POLYFILL = "/crypto-browserify/";
const CLIENT_OUTPUT = resolve(process.cwd(), ".next", "static");
const DEV_LOGIN_OUTPUT = resolve(process.cwd(), ".next", "server", "app", "api", "dev");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const nextBin = resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const buildEnv: NodeJS.ProcessEnv = { ...process.env, LUCRA_MODE: "mock", [VARIABLE_NAME]: SENTINEL };
delete buildEnv.SIDEOUT_DEV_LOGIN;
execFileSync(process.execPath, [nextBin, "build"], {
  stdio: "inherit",
  env: buildEnv,
});

const files = walk(CLIENT_OUTPUT);
if (files.length === 0) {
  throw new Error(`No client output under ${CLIENT_OUTPUT}; did the build run?`);
}

const leaks: string[] = [];
const polyfilled: string[] = [];
for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes.includes(SENTINEL) || bytes.includes(VARIABLE_NAME)) leaks.push(file);
  if (bytes.includes(CRYPTO_POLYFILL)) polyfilled.push(file);
}

if (leaks.length > 0) {
  for (const file of leaks) {
    log.error("backend key reached a client bundle", { file: relative(process.cwd(), file) });
  }
  process.exitCode = 1;
} else {
  log.info("client bundle is clean", { scanned: files.length, variable: VARIABLE_NAME });
}

if (polyfilled.length > 0) {
  for (const file of polyfilled) {
    log.error("node crypto polyfill reached a client bundle", { file: relative(process.cwd(), file) });
  }
  process.exitCode = 1;
} else {
  log.info("client bundle has no node crypto polyfill");
}

if (existsSync(DEV_LOGIN_OUTPUT)) {
  log.error("dev login route exists in a production build", { dir: relative(process.cwd(), DEV_LOGIN_OUTPUT) });
  process.exitCode = 1;
} else {
  log.info("production build has no dev login route");
}
