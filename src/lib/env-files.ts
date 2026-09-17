import { loadEnvConfig } from "@next/env";
import { log } from "@/lib/log";

/**
 * Load `.env*` files for the CLIs (`npm run seed`, `npm run db:migrate`) with
 * the loader Next itself uses, so `DATABASE_PATH` resolves to the same file for
 * the CLIs and for `next dev` / `next start`. Precedence is Next's: values
 * already in the shell environment win over the files, which is what
 * `playwright.config.ts` relies on to keep the e2e database separate.
 *
 * Next picks the file set by command: `next dev` reads the development set
 * (`.env.development.local`, `.env.local`, `.env.development`, `.env`) and
 * `next build` / `next start` the production set. The CLIs follow NODE_ENV so
 * an unset shell matches the `npm run seed && npm run dev` quickstart and a
 * deploy that exports NODE_ENV=production before `npm run db:migrate` matches
 * `next start`. Under NODE_ENV=test `.env.local` is skipped, as in Next.
 *
 * `src/env.ts` is `server-only` and cannot be imported from a tsx process, so
 * the CLIs read `process.env` directly after this call.
 */
export function loadEnvFiles(): void {
  const dev = process.env.NODE_ENV !== "production";
  const { loadedEnvFiles } = loadEnvConfig(process.cwd(), dev, {
    info: (message: unknown) => log.info(String(message)),
    error: (message: unknown, cause?: unknown) => log.error(String(message), undefined, cause),
  });
  if (loadedEnvFiles.length > 0) {
    log.info("env files", { loaded: loadedEnvFiles.map((f) => f.path).join(", ") });
  }
}
