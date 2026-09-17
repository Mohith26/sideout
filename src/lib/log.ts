/**
 * The single console boundary. `no-console` is an error everywhere else in the
 * repo (see eslint.config.mjs), so every diagnostic line in the codebase is
 * greppable from this one module and can be redirected or redacted in one place.
 *
 * Levels are deliberately narrow: `warn` and `error` map to the console channels
 * of the same name; `info` is operator output for CLIs (seed, migrate) and goes
 * to stdout in Node, and is silent in the browser.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const PREFIX = "[sideout]";

function formatFields(fields: LogFields | undefined): string {
  if (!fields) return "";
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function stdoutWrite(line: string): void {
  if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function") {
    process.stdout.write(`${line}\n`);
  }
}

export const log = {
  info(message: string, fields?: LogFields): void {
    stdoutWrite(`${PREFIX} ${message}${formatFields(fields)}`);
  },
  warn(message: string, fields?: LogFields): void {
    console.warn(`${PREFIX} ${message}${formatFields(fields)}`);
  },
  error(message: string, fields?: LogFields, cause?: unknown): void {
    if (cause === undefined) {
      console.error(`${PREFIX} ${message}${formatFields(fields)}`);
    } else {
      console.error(`${PREFIX} ${message}${formatFields(fields)}`, cause);
    }
  },
};

/** Normalize an unknown thrown value into a message without leaking stack internals. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}
