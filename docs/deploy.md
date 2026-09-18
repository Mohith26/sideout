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
| `LUCRA_MATCHER_INTERPRETATION` | default `literal` | Which reading of Lucra's documented matcher the mock runs; irrelevant to Sideout's own writes. |
| `LUCRA_RESPONSIBLE_GAMING_URL`, `LUCRA_SELF_LIMIT_URL`, `LUCRA_SUPPORT_URL` | Lucra's defaults | The responsible-play links shown wherever a balance or reward is, and the support path for a restricted player. Override only if Lucra names tenant-specific pages. |

`NEXT_PUBLIC_LUCRA_MODE` is derived from `LUCRA_MODE` by `next.config.ts`; do not set it
separately.

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
`npm run seed` once and `npm run db:migrate` on every later deploy. Sign-in still needs
the SMS provider above; until then the demo is read-only for visitors, and a private
demo can run with `NODE_ENV` unset so the code comes back in the response.

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
- **Deployed commit:** `25f83b2a089b0a82d993cf0771e4d0da108d1016` on `fm/sideout-deploy`
  (the `buildSha` `/health` reports; `railway up` uploads the working tree without `.git`,
  so `BUILD_SHA` is set as a service variable before each deploy).
- **Health check:** `GET /health` answers 200 with `lucraMode: "mock"`, `session: "env"`,
  `devLogin: false`, `migrations: { applied: 6, available: 6, pending: 0 }`. Railway's
  own health check (`railway.json`) and the image `HEALTHCHECK` both point at it.
- **Volume:** `sideout-volume`, mounted at `/data`; `DATABASE_PATH=/data/sideout.db`.
  The seed ran on the first boot; every later deploy migrates the same file.
- **Variables:** `NODE_ENV=production`, `LUCRA_MODE=mock`, `NEXT_PUBLIC_LUCRA_MODE=mock`,
  `DATABASE_PATH=/data/sideout.db`, `TRUSTED_PROXY_HOPS=1`, `FEATURE_REAL_MONEY=false`,
  `BUILD_SHA=<commit>`, `NEXT_TELEMETRY_DISABLED=1`, `RAILWAY_RUN_UID=0` (the container
  must start as root for the entrypoint's ownership fix; the app itself runs as `node`),
  and the secrets `SESSION_SECRET` and `LUCRA_WEBHOOK_SECRET` (48 random bytes each,
  generated locally and piped straight into `railway variable set --stdin`; never
  written down). `PORT` is Railway's.
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

## What the public demo can and cannot do

Everything a visitor can reach without signing in works from the seeded dataset: the
Home page with the three seeded events, every `/t/[slug]` tab (Overview, Bracket with
pool sheets, Standings, Impact), `/events`, `/impact`, every `/m/[id]` match page, the
installable PWA and its offline page. `/admin/lucra` and every `/organizer/**` page are
gated (organizer access required, or 404), and `/api/admin/*` answers 401.

The demo is **read-only for visitors**. Sign-in issues no codes: the process is
production and no SMS provider is configured, so `POST /api/auth/request-code` answers
503 `sms_unavailable` ("Sign-in needs an SMS provider", above), and `POST /api/dev/login`
is compiled out (`devLogin: false` on `/health`). The profile (`/me`), team creation,
registration and its Lucra entry step, score submission, the dispute queue, the close
flow and the organizer console are therefore only reachable through the seeded data —
as pages a visitor cannot sign in to — until one of these follow-ups lands:

1. **Configure an SMS provider:** implement `SmsSender` in `src/server/auth/sms.ts`
   against a provider and return it from `getSmsSender()` in production. Real phones can
   then sign in; the seeded players and organizers keep their seeded numbers.
2. **A demo-accounts switch** (needs the captain's approval before it is built): a
   production-safe way to sign in as a seeded user on the demo host only, distinct from
   `SIDEOUT_DEV_LOGIN`, which stays off on a public deployment.

Neither is built. Custom domains, Lucra sandbox credentials and a second database engine
are also not part of the deployment.

## What is not covered here

Real SMS and Lucra credentials and a second database engine are follow-ups
(`open-questions.md`, "Follow-ups").
