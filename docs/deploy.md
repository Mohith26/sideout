# Deploying Sideout

What a host needs to run this, and how the public demo is deployed on Railway
("Deployed", below). The app is one Node process serving a Next.js production build with
a SQLite file next to it.

## The process

- **Node 22** (`.nvmrc`). `npm ci` installs everything, including `lucra-web-sdk` from
  its GitHub release tag over https (it is not on the npm registry), and
  `better-sqlite3`, which needs a prebuilt binary for the host's platform or a C++
  toolchain to build one.
- **Build and start:** `npm run build`, then `npm run start` (`next start`, `PORT`
  respected). The build reads `LUCRA_MODE` and bakes the browser's mode in; a build made
  for one mode must not be started in another (the server refuses to boot if they
  disagree).
- **Migrations:** `npm run db:migrate` applies the checked-in migrations under
  `drizzle/` to `DATABASE_PATH`; it is idempotent, so run it on every deploy before
  `start`. `npm run seed` resets the file to the demo dataset — for a demo host only,
  never on a database with real events.
- **One instance.** SQLite is a file: run one process against it. Horizontal scaling
  needs a different database, which is not built.
- **Health:** `GET /health` answers 200 with the build sha, the Lucra mode, the pinned
  and installed SDK versions, the migration state (every checked-in migration applied
  or not), where the session secret came from, and whether the dev sign-in route is
  compiled in. Point the host's health check at it.

## Persistent disk

`DATABASE_PATH` (default `./data/sideout.db`) must be on a disk that survives restarts
and deploys. The seed, every event, every score submission, the audit log and every
Lucra attempt row live in that one file (plus its `-wal` and `-shm` siblings while the
process runs). Back it up as a file; there is no export.

## Environment variables

`.env.example` documents every variable. The ones a public deploy has to think about:

| Variable | Set it to | Why |
|---|---|---|
| `LUCRA_MODE` | `mock` for a demo; `sandbox` or `production` with credentials | Which Lucra the server and the browser talk to. Mock is a complete in-process Lucra plus a browser stand-in for the Web SDK, so a demo needs no account. |
| `LUCRA_BASE_URL`, `LUCRA_BACKEND_API_KEY` | from your Lucra representative | Required outside mock mode; the process fails at boot without them. The backend key never reaches the browser (`npm run test:bundle` proves it). |
| `NEXT_PUBLIC_LUCRA_WEB_API_KEY`, `NEXT_PUBLIC_LUCRA_TENANT_ID` | from your Lucra representative | The only Lucra credentials that may reach the browser; the Web SDK initializes with them. Build-time values (`NEXT_PUBLIC_`), so set them before `npm run build`. Unused in mock mode. |
| `LUCRA_WEBHOOK_SECRET` | a shared secret agreed with Lucra | Verifies `X-Lucra-Signature` on `POST /api/webhooks/lucra`. Required in production in every mode: without it every delivery is refused with 401 and the boot log warns. A production build in mock mode needs one too, or the mock's own in-process deliveries (verification state after the identity flow, tournament entry) are refused and the linked rows never change. Any value works for mock; the mock signs with the same secret. |
| `SESSION_SECRET` | 16+ random characters | Signs the session cookie. Unset in production means a random per-process secret, a warning at boot, and every session dying on restart. |
| `TRUSTED_PROXY_HOPS` | `1` behind one proxy (any PaaS, a load balancer, nginx); the depth of the chain otherwise | The sign-in rate limit reads the client address from `x-forwarded-for` that many hops from the right. At the default `0` the header is ignored, only the per-phone and process-wide limits apply, and production warns at boot. |
| `AUTH_CODE_GLOBAL_CAP` | default `2000` | Sign-in codes issued per ten minutes across the process, the backstop when no address can be trusted. Raise it for an event whose crowd signs in at once. |
| `BUILD_SHA` | the deployed commit | `/health` provenance, and the service worker's cache version: a new build must carry a new sha or players' phones keep the previous build's pages. It falls back to `git rev-parse HEAD` at build time, so set it explicitly on a host that builds from a tarball rather than a checkout. |
| `DATABASE_PATH` | a path on the persistent disk | See above. |
| `FEATURE_REAL_MONEY` | `false` | Leave it. Real-money head-to-head is built behind this flag and is not to be enabled (spec §4.2). |
| `SIDEOUT_DEV_LOGIN` | unset | Compiles `POST /api/dev/login` (sign in as any seeded user) into a production build. Only the Playwright run sets it. Never on a public host. |
| `DEMO_ACCOUNTS` | unset, or `true` on the public demo only | The demo-accounts switch ("Public demo", below): `/sign-in` offers the curated seeded accounts, `POST /api/auth/demo` signs in as one (audited, rate-limited, the session marked "Demo"), `POST /api/admin/demo/reset` reseeds. Refused at boot unless `LUCRA_MODE=mock`. Build-time too: the Dockerfile bakes `NEXT_PUBLIC_DEMO_ACCOUNTS` from it and the runtime value must match. |
| `DEMO_RESET_TOKEN` | 32+ random characters, only with `DEMO_ACCOUNTS` | Bearer token for the reset route; the nightly job and `npm run demo:reset` present it. Without it the route answers 503. |
| `LUCRA_MATCHER_INTERPRETATION` | default `literal` | Which reading of Lucra's documented matcher the mock runs; irrelevant to Sideout's own writes. |
| `LUCRA_RESPONSIBLE_GAMING_URL`, `LUCRA_SELF_LIMIT_URL`, `LUCRA_SUPPORT_URL` | Lucra's defaults | The responsible-play links shown wherever a balance or reward is, and the support path for a restricted player. Override only if Lucra names tenant-specific pages. |

`NEXT_PUBLIC_LUCRA_MODE` is derived from `LUCRA_MODE` by `next.config.ts`, and
`NEXT_PUBLIC_DEMO_ACCOUNTS` from `DEMO_ACCOUNTS`; the server refuses to boot when either
pair disagrees. Set the server variable at build time and at runtime; a separate
`NEXT_PUBLIC_*` value is only needed on a host that builds and runs from different
variable sets (Railway passes the same service variables to both).

## Sign-in needs an SMS provider

Sideout's own session is phone number plus a one-time code. No SMS provider is chosen
yet: outside production the code is written to the log and returned by
`POST /api/auth/request-code` as `devCode`, which is fine for a demo host that is not
production (`NODE_ENV` unset or `development`), and unacceptable for a public one. In
production the sender is `null`, so a code request answers `503` with
`detail.code = "sms_unavailable"` and nobody can sign in. To turn sign-in on, implement
`SmsSender` in `src/server/auth/sms.ts` against a provider (Twilio, or whatever the host
already has) and return it from `getSmsSender()` in production. Partner invites go out
through the same seam.

## A demo host, concretely

For a public demo with no Lucra account: a production build (`NODE_ENV=production`)
with `LUCRA_MODE=mock`, a persistent disk for `DATABASE_PATH`, `SESSION_SECRET`,
`LUCRA_WEBHOOK_SECRET` (any value), `TRUSTED_PROXY_HOPS=1`, `BUILD_SHA`, then
`npm run seed` once and `npm run db:migrate` on every later deploy. Sign-in through a
phone still needs the SMS provider above; the demo-accounts switch ("Public demo",
below) is how visitors sign in without one.

## Caching in front of the app

Pages are `force-dynamic` (they read the session cookie for draft previews and the
viewer's own-team highlight), so the app answers `private, no-cache`. The standings API
sends `Cache-Control: public, max-age=10`. A CDN in front of anonymous `/t/[slug]/*`
needs a `Vary: Cookie`-aware policy; nothing else expects one.

## The container

`Dockerfile` builds the image the demo runs from, in two stages:

- **build** (`node:22-bookworm-slim` plus `python3 make g++`, the toolchain
  `better-sqlite3` compiles with when no prebuilt binary matches): `npm ci` with every
  dependency, then `next build` under `NODE_ENV=production` (which keeps `route.dev.ts`
  out of the build, `src/lib/build-gates.ts`), then `npm prune --omit=dev`. Two build
  arguments come from the host's variables of the same name: `LUCRA_MODE` (baked into
  the browser bundle; the runtime value must match) and `BUILD_SHA`.
- **runtime** (`node:22-bookworm-slim`, no toolchain): the pruned `node_modules`, the
  built `.next`, `public/`, and what the start command's CLIs read — `src/`, `drizzle/`,
  `tsconfig.json`, `next.config.ts`. `tsx` is a production dependency for that reason.
  `HEALTHCHECK` polls `/health`. `docker-entrypoint.sh` is the entrypoint: it starts as
  root only to make the database directory writable and runs everything else as the
  unprivileged `node` user (Railway mounts a volume owned by root, so a `USER` switch at
  build time cannot open the file on it).
- **start command** (the Dockerfile `CMD` and `railway.json` `deploy.startCommand`,
  asserted equal by `src/docker.test.ts`):
  `(test -f "$DATABASE_PATH" || npm run seed) && npm run db:migrate && npm run start`.
  The seed runs once, when no database file exists on the volume; migrations run on
  every start; the existence test comes first because `npm run db:migrate` creates an
  empty file and would otherwise skip the seed for good.

`.dockerignore` keeps `.env*` (except `.env.example`), `data/`, `.next/`, `node_modules/`,
the tests, tooling and docs out of the build context. `src/docker.test.ts` asserts
those entries, the pruned runtime stage, the entrypoint's privilege drop and the start
command.

## Deployed

The public demo runs on Railway, project `sideout`, service `sideout`, environment
`production`, in the captain's workspace:

- **URL:** https://sideout-production-7db6.up.railway.app (the Railway-provided domain,
  from `railway domain`).
- **Deployed commit:** `3695c6c22a0bb9c8cde8be3e7062485744e9b9e3` on `fm/sideout-deploy`
  (the `buildSha` `/health` reports; `railway up` uploads the working tree without `.git`,
  so `BUILD_SHA` is set as a service variable before each deploy).
- **Health check:** `GET /health` answers 200 with `lucraMode: "mock"`, `session: "env"`,
  `devLogin: false`, `demoAccounts: true`, `migrations: { applied: 6, available: 6, pending: 0 }`.
  Railway's own health check (`railway.json`) and the image `HEALTHCHECK` both point at it.
- **Volume:** `sideout-volume`, mounted at `/data`; `DATABASE_PATH=/data/sideout.db`.
  The seed ran on the first boot; every later deploy migrates the same file.
- **Variables:** `NODE_ENV=production`, `LUCRA_MODE=mock`, `NEXT_PUBLIC_LUCRA_MODE=mock`,
  `DATABASE_PATH=/data/sideout.db`, `TRUSTED_PROXY_HOPS=1`, `FEATURE_REAL_MONEY=false`,
  `BUILD_SHA=<commit>`, `NEXT_TELEMETRY_DISABLED=1`, `RAILWAY_RUN_UID=0` (the container
  must start as root for the entrypoint's ownership fix; the app itself runs as `node`),
  `DEMO_ACCOUNTS=true`, `NEXT_PUBLIC_DEMO_ACCOUNTS=true` ("Public demo", below), and the
  secrets `SESSION_SECRET`, `LUCRA_WEBHOOK_SECRET` and `DEMO_RESET_TOKEN` (48 random
  bytes each, generated locally and piped straight into `railway variable set --stdin`;
  never written down — the Railway dashboard's Variables tab for the service is the
  only place to read them). `PORT` is Railway's.
- **Build:** the Dockerfile, declared in `railway.json` (`build.builder: DOCKERFILE`),
  restart policy `ON_FAILURE` with 10 retries, one replica (SQLite: see "One instance").

How it was deployed, with the Railway CLI (`railway`, signed in) from the repository
root:

```sh
railway init --name sideout --workspace <workspace-id>          # project; links the directory
railway add --service sideout --variables NODE_ENV=production \
  --variables LUCRA_MODE=mock --variables NEXT_PUBLIC_LUCRA_MODE=mock \
  --variables DATABASE_PATH=/data/sideout.db --variables TRUSTED_PROXY_HOPS=1 \
  --variables FEATURE_REAL_MONEY=false --variables NEXT_TELEMETRY_DISABLED=1
railway service link sideout
railway volume add --mount-path /data
openssl rand -base64 48 | tr -d '\n' | railway variable set SESSION_SECRET --stdin --skip-deploys
openssl rand -base64 48 | tr -d '\n' | railway variable set LUCRA_WEBHOOK_SECRET --stdin --skip-deploys
railway variable set RAILWAY_RUN_UID=0 --skip-deploys
railway variable set "BUILD_SHA=$(git rev-parse HEAD)" --skip-deploys
railway up --ci --service sideout                                # build + deploy the working tree
railway domain                                                  # the Railway-provided domain
```

**To redeploy** a new commit (from a clean checkout of the commit to deploy, linked to
the project with `railway link` if this directory is not):

```sh
railway variable set "BUILD_SHA=$(git rev-parse HEAD)" --skip-deploys && railway up --ci --service sideout
```

Then `curl https://sideout-production-7db6.up.railway.app/health` and check `buildSha`
is the commit and `migrations.pending` is 0. `railway logs -d` shows the boot (the
entrypoint line, the migrate summary, `next start`); `railway deployment list` the
history. Update the "Deployed commit" line above when the deployed commit changes.

## Public demo

Everything a visitor can reach without signing in works from the seeded dataset: the
Home page with the three seeded events, every `/t/[slug]` tab (Overview, Bracket with
pool sheets, Standings, Impact), `/events`, `/impact`, every `/m/[id]` match page, the
installable PWA and its offline page. `/admin/lucra` and every `/organizer/**` page are
gated (organizer access required, or 404), and `/api/admin/*` answers 401.

Signing in on the public demo goes through the **demo-accounts switch** (`DEMO_ACCOUNTS`),
because the process is production and no SMS provider is configured
(`POST /api/auth/request-code` answers 503 `sms_unavailable`; `POST /api/dev/login` is
compiled out, `devLogin: false` on `/health`). With the switch on, `/sign-in` shows a
"Demo accounts" section above the unchanged phone form. Picking a card calls
`POST /api/auth/demo`, which issues the normal session cookie marked `via: "demo"` (the
shell shows a red "Demo · name" pill on every screen until sign-out), writes an
`auth.demo_sign_in` audit row on the user, and is rate-limited per address (30 per ten
minutes) and process-wide (600). The accounts are named by seeded phone number in
`src/seed/demo.ts` and resolved against the live rows by `src/db/queries/demo.ts`, so
each card also shows the account's current state:

| Card | Seeded user | What it can do |
|---|---|---|
| Captain A | Nadia Haddad (Haddad / Delgado) | Captain of team A in the Sandbar Classic quarterfinal at bracket position 12, `awaiting_scores`. Their scoreline is already in: the match page shows "Waiting on Nogueira / El-Amin" and offers "Change your scoreline". Lands on `/m/<match>`. |
| Captain B | Beatriz Nogueira (Nogueira / El-Amin) | Captain of team B in the same match. Offered "Confirm the result": typing the same result makes the match `final` and writes it to the (mock) Lucra; a different one opens a dispute for the organizer. Lands on `/m/<match>`. |
| Registering captain | Priya Raman (Raman / Mensah) | Captain of a complete pair (partner accepted) that has not entered Pier 9 Open (`registration_open`). Lands on `/t/pier-9-open-2026/register` with the entry donation step, then the Lucra entry step. |
| Organizer | Carmen Ibarra | Runs the events: `/organizer/events`, the court board, the dispute queue (Sandbar Classic has one open dispute), `/organizer/events/<id>/lucra`, the two-step close, `/admin/lucra`. Lands on `/organizer/events`. |
| Restricted player | Marcus Bell | Lucra state `not_allowed`: `/me` shows the support path and no retry. |
| Player with details to add | Elijah Brooks | Lucra state `demographics_missing`: `/me` walks the identity flow through the (mock) Lucra sheet. |

Two phones, one match: sign in as Captain A on one and Captain B on the other, and the
second scoreline settles the quarterfinal live on both, on the bracket and on the court
board. The switch is off by default, cannot be enabled outside mock mode (`src/env.ts`
refuses `DEMO_ACCOUNTS=true` with any other `LUCRA_MODE`), and needs the same value at
build and at runtime (`NEXT_PUBLIC_DEMO_ACCOUNTS` is derived from it; a disagreement
refuses to boot). The phone-code sign-in is untouched.

### Resetting the demo

`POST /api/admin/demo/reset` with `Authorization: Bearer $DEMO_RESET_TOKEN` writes the
seed dataset back over the live database in one transaction (every table emptied and
re-inserted, anchored on the current day in the venue's time zone, exactly what
`npm run seed` writes), then rebuilds the mock Lucra from the new rows on its next use.
Overlapping requests see the old rows or the new ones, never a half-empty database; a
second reset while one runs answers 409 `reset_in_progress`. The route exists only with
the switch on (404 otherwise), answers 503 while no token is configured, and 401 for any
other token. The response carries the anchor day and the row counts per table. Because the
audit log is part of the seed, a reset also clears the `auth.demo_sign_in` rows written
since the last one; the server log (`railway logs`) keeps the `auth: demo sign-in` lines.

**Before a recording**, from the repository root with the token in the shell (read it from
the Railway dashboard, service `sideout`, Variables, `DEMO_RESET_TOKEN`):

```sh
DEMO_RESET_TOKEN=<token> npm run demo:reset -- --url https://sideout-production-7db6.up.railway.app
```

`--token-env NAME` reads a differently named variable; the token is never printed. Exit
status 0 means the reset happened and the anchor and counts were logged.

**Nightly**, the same call runs from a Railway Function (a single-file service with a
cron schedule, no repository and no volume): `railway/demo-reset.function.ts`, service
`sideout-demo-reset`, schedule `0 10 * * *` (10:00 UTC, 03:00 Pacific), with the
variables `SIDEOUT_URL` (the public URL) and `DEMO_RESET_TOKEN` (the same token as the
app). Created and updated with the CLI from the repository root:

```sh
railway functions new --path railway/demo-reset.function.ts --name sideout-demo-reset --cron "0 10 * * *"
railway variable set --service sideout-demo-reset SIDEOUT_URL=https://sideout-production-7db6.up.railway.app --skip-deploys
<token> | railway variable set --service sideout-demo-reset DEMO_RESET_TOKEN --stdin --skip-deploys
railway functions push --path railway/demo-reset.function.ts       # after editing the file
```

Each run's output (`demo-reset: done anchor=… users=… matches=…`, or the refusal) is in
that service's logs, and a refused reset exits non-zero so the run shows as failed.

Custom domains, Lucra sandbox credentials and a second database engine are not part of
the deployment; neither is an SMS provider (`getSmsSender()` in `src/server/auth/sms.ts`
is where one goes, and the seeded players keep their seeded numbers).

## What is not covered here

Real SMS and Lucra credentials and a second database engine are follow-ups
(`open-questions.md`, "Follow-ups").
