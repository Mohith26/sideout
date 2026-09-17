import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs the real `npm run db:migrate` entrypoint under tsx with a temporary
 * working directory, so the assertion is over the CLI's actual env-file
 * loading (`@/lib/env-files`) and not over source text. The migrator resolves
 * `drizzle/` from the working directory, so the checked-in folder is copied in.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsxBin = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const migrateCli = join(repoRoot, "src", "db", "migrate-cli.ts");

function runMigrate(cwd: string, extraEnv: Record<string, string> = {}): string {
  // Vitest sets NODE_ENV=test, under which Next (and so the CLI) skips
  // `.env.local`; a developer's shell may also carry DATABASE_PATH. Neither
  // belongs to the scenario being exercised.
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  delete env.NODE_ENV;
  if (!("DATABASE_PATH" in extraEnv)) delete env.DATABASE_PATH;
  return execFileSync(process.execPath, [tsxBin, "--tsconfig", join(repoRoot, "tsconfig.json"), migrateCli], {
    cwd,
    // Next's `ProcessEnv` augmentation declares NODE_ENV required; the child
    // must start without it, like a developer's shell.
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("db:migrate env loading", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sideout-migrate-"));
    cpSync(join(repoRoot, "drizzle"), join(dir, "drizzle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads DATABASE_PATH from .env.local in the working directory", () => {
    writeFileSync(join(dir, ".env.local"), "DATABASE_PATH=./from-env-local/sideout.db\n");

    const out = runMigrate(dir);

    expect(existsSync(join(dir, "from-env-local", "sideout.db"))).toBe(true);
    expect(existsSync(join(dir, "data", "sideout.db"))).toBe(false);
    expect(out).toContain(".env.local");
  });

  it("lets the shell environment win over .env.local, as Next does", () => {
    writeFileSync(join(dir, ".env.local"), "DATABASE_PATH=./from-env-local/sideout.db\n");

    runMigrate(dir, { DATABASE_PATH: "./from-shell/sideout.db" });

    expect(existsSync(join(dir, "from-shell", "sideout.db"))).toBe(true);
    expect(existsSync(join(dir, "from-env-local", "sideout.db"))).toBe(false);
  });
});
