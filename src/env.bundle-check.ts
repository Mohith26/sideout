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
 * The same is asserted for the webhook secret (`LUCRA_WEBHOOK_SECRET`, spec
 * §7.6): a second sentinel, the same scan.
 *
 * The build runs with `LUCRA_MODE=sandbox` (pointing at an unreachable host;
 * nothing is called at build time) so that it must also contain neither
 * `POST /api/dev/login` nor `GET /api/rest/_mock/state`: `next.config.ts`
 * registers their `dev.ts` and `mock.ts` page extensions only outside
 * production / in mock mode (`src/lib/build-gates.ts`), and this build is
 * neither.
 *
 * Nor may the client output carry Node's `crypto` polyfill: the score sheet
 * judges legality in the browser with `@/domain/scoreline`, and the hash that
 * needs `node:crypto` lives in `@/domain/scoreline-hash` so a client component
 * that reaches it would pull the whole `crypto-browserify` bundle down to a
 * phone on the sand.
 */
const VARIABLE_NAME = "LUCRA_BACKEND_API_KEY";
const SENTINEL = "sideout-backend-key-sentinel-4b1f9e2d";
const SECRET_VARIABLE_NAME = "LUCRA_WEBHOOK_SECRET";
const SECRET_SENTINEL = "sideout-webhook-secret-sentinel-9c7e21aa";
const CRYPTO_POLYFILL = "/crypto-browserify/";
const CLIENT_OUTPUT = resolve(process.cwd(), ".next", "static");
const DEV_LOGIN_OUTPUT = resolve(process.cwd(), ".next", "server", "app", "api", "dev");
/** The `%5Fmock` folder (a URL-encoded underscore segment) may be emitted under either spelling. */
const MOCK_STATE_OUTPUTS = ["%5Fmock", "_mock"].map((name) => resolve(process.cwd(), ".next", "server", "app", "api", "rest", name));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const nextBin = resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const buildEnv: NodeJS.ProcessEnv = {
  ...process.env,
  LUCRA_MODE: "sandbox",
  LUCRA_BASE_URL: "https://lucra.invalid",
  [VARIABLE_NAME]: SENTINEL,
  [SECRET_VARIABLE_NAME]: SECRET_SENTINEL,
};
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
const secretLeaks: string[] = [];
const polyfilled: string[] = [];
for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes.includes(SENTINEL) || bytes.includes(VARIABLE_NAME)) leaks.push(file);
  if (bytes.includes(SECRET_SENTINEL) || bytes.includes(SECRET_VARIABLE_NAME)) secretLeaks.push(file);
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

if (secretLeaks.length > 0) {
  for (const file of secretLeaks) {
    log.error("webhook secret reached a client bundle", { file: relative(process.cwd(), file) });
  }
  process.exitCode = 1;
} else {
  log.info("client bundle has no webhook secret", { variable: SECRET_VARIABLE_NAME });
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

const mockOutput = MOCK_STATE_OUTPUTS.find((dir) => existsSync(dir));
if (mockOutput) {
  log.error("mock state route exists in a non-mock build", { dir: relative(process.cwd(), mockOutput) });
  process.exitCode = 1;
} else {
  log.info("sandbox build has no mock state route");
}
