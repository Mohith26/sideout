/**
 * The nightly demo reset, as a Railway Function (a single-file service with a
 * cron schedule; `docs/deploy.md`, "Public demo"). Deployed with the Railway
 * CLI from the repository root:
 *
 *   railway functions new --path railway/demo-reset.function.ts \
 *     --name sideout-demo-reset --cron "0 10 * * *"        # 10:00 UTC = 03:00 Pacific
 *   railway variable set --service sideout-demo-reset SIDEOUT_URL=https://<host> DEMO_RESET_TOKEN=<same token as the app> --skip-deploys
 *   railway functions push --path railway/demo-reset.function.ts
 *
 * Each run POSTs `/api/admin/demo/reset` with the bearer token and exits
 * non-zero when the reset was refused, so the run shows as failed in Railway.
 * Self-contained on purpose: a function is deployed on its own, without the
 * repository, so it must not import anything from `src/`. The same call from
 * a shell is `npm run demo:reset -- --url <base>`.
 */
const base = (process.env.SIDEOUT_URL ?? "").replace(/\/+$/, "");
const token = process.env.DEMO_RESET_TOKEN ?? "";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  if (!base || !token) {
    out("demo-reset: SIDEOUT_URL and DEMO_RESET_TOKEN must be set");
    return 2;
  }
  const response = await fetch(`${base}/api/admin/demo/reset`, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    out(`demo-reset: refused with ${response.status}: ${text.slice(0, 300)}`);
    return 1;
  }
  const body = JSON.parse(text) as { data?: { anchor?: string; durationMs?: number; counts?: Record<string, number> } };
  out(`demo-reset: done anchor=${body.data?.anchor ?? "?"} durationMs=${body.data?.durationMs ?? "?"} users=${body.data?.counts?.users ?? "?"} matches=${body.data?.counts?.matches ?? "?"}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    out(`demo-reset: failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
