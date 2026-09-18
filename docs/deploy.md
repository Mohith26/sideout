# Deploying Sideout

What a host needs to run this. Nothing here has been deployed yet; this is the list to
pick a host against. The app is one Node process serving a Next.js production build with
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

## What is not covered here

Deployment itself, real SMS and Lucra credentials, and a second database engine are
follow-ups (`open-questions.md`, "Follow-ups"). Nothing in this file has been exercised
against a real host.
