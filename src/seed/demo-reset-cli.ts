import { parseArgs } from "node:util";
import { loadEnvFiles } from "@/lib/env-files";
import { errorMessage, log } from "@/lib/log";

/**
 * `npm run demo:reset -- --url <base> [--token-env DEMO_RESET_TOKEN]` — put the
 * public demo's database back to the seed through `POST /api/admin/demo/reset`
 * (`docs/deploy.md`, "Public demo"). The base URL falls back to `SIDEOUT_URL`
 * (the cron service's start command runs with no shell, so it cannot expand
 * a variable into the argument). The token is read from the named environment
 * variable (a `.env.local` works too) and never printed; the response's anchor
 * day and row counts are. Exit status 0 only when the reset happened. Lives
 * under `src/` (beside `cli.ts`) because the nightly Railway cron service runs
 * it inside the production image, where only `src/` and the pruned
 * dependencies exist (`railway/reset.railway.json`).
 */
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "token-env": { type: "string", default: "DEMO_RESET_TOKEN" },
    help: { type: "boolean", default: false },
  },
});

function usage(): never {
  log.error("usage: npm run demo:reset -- --url https://<host> [--token-env DEMO_RESET_TOKEN]   (or SIDEOUT_URL in the environment)");
  process.exit(2);
}

if (values.help) usage();
loadEnvFiles();
const baseUrl = (values.url ?? process.env.SIDEOUT_URL ?? "").trim().replace(/\/+$/, "");
if (!baseUrl) usage();
const tokenEnv = values["token-env"] ?? "DEMO_RESET_TOKEN";
const token = process.env[tokenEnv]?.trim();
if (!token) {
  log.error(`demo reset: ${tokenEnv} is not set`);
  process.exit(2);
}

/** The route's success envelope, as the CLI reads it back. */
interface ResetData {
  anchor: string;
  counts: Record<string, number>;
  durationMs: number;
}

async function main(): Promise<void> {
  const endpoint = `${baseUrl}/api/admin/demo/reset`;
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const text = await response.text();
  let body: { ok?: boolean; data?: ResetData; error?: { code?: string; message?: string } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // Not an envelope (a proxy error page, say); the status and the text are reported below.
  }
  if (!response.ok || body.ok !== true || !body.data) {
    log.error("demo reset: refused", { status: response.status, code: body.error?.code ?? "none", message: body.error?.message ?? text.slice(0, 200) });
    process.exit(1);
  }
  log.info("demo reset: done", { url: endpoint, anchor: body.data.anchor, durationMs: body.data.durationMs });
  for (const [table, count] of Object.entries(body.data.counts)) log.info(`  ${table.padEnd(22)} ${String(count).padStart(5)}`);
}

main().catch((err: unknown) => {
  log.error("demo reset: failed", { message: errorMessage(err) });
  process.exit(1);
});
