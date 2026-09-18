# Sideout — agent notes

Charity beach volleyball tournament platform with a Lucra integration. The
acceptance contract is `docs/build-spec.md` (verbatim brief, five build phases);
`docs/open-questions.md` lists every spec `OPEN` item, its implemented fallback, the
phase that owns it, plus follow-ups and every stated deviation. Never resolve an OPEN
by guessing: implement the fallback, mark it `// OPEN:` in code, and add a row there.

## Working here

- Node 22+ (`.nvmrc`), npm. `npm i && npm run seed && npm run dev` boots with no
  env file; `LUCRA_MODE=mock` is the default. `.env.example` documents the rest.
- Before finishing, run what CI runs (`.no-mistakes.yaml` is the source):
  `npm run typecheck && npm run lint && npm test && npm run test:bundle && npm run build`.
  `npm run test:e2e` (Playwright, needs `npx playwright install chromium`) seeds its
  own database at `data/sideout.e2e.db` and builds a production server with
  `SIDEOUT_DEV_LOGIN=true` so its flows can sign in through `POST /api/dev/login`.
- Next.js 16 differs from older training data: read `node_modules/next/dist/docs/`
  before touching routing, caching, fonts, or config. `params` is a Promise;
  `PageProps`/`LayoutProps`/`RouteContext` come from `next typegen` (run by
  `npm run typecheck`, as a production build, so it never lists the dev-login route).
- CI (`.github/workflows/ci.yml`) mirrors `.no-mistakes.yaml`; keep them in sync.

## Conventions that are enforced, not advisory

- Design tokens live once in `src/styles/tokens.css` and are mapped into Tailwind in
  `src/app/globals.css`. Tailwind's default palette and radii are removed on purpose:
  only spec colors and `rounded-xs|sm|md|lg|full` exist. `src/styles/tokens.test.ts`
  asserts WCAG AA for every text tier on every surface.
- `--volt` is the single primary action color (one per screen); `--ember` is charity
  and impact only; `--surf` is live/agreed; `--fault` is errors/disputes.
- Icons come from `src/components/ui/icons.ts` (lucide, 1.5px stroke), never from
  `lucide-react` directly. No emoji as iconography.
- Console output only through `src/lib/log.ts`; ESLint makes `console`, `any`, and
  empty `catch` errors everywhere else.
- `src/env.ts` is `server-only`; `src/env.public.ts` holds the only values allowed in
  the browser. `npm run test:bundle` (`src/env.bundle-check.ts`) builds with a sentinel
  backend key and fails if it, or the variable name, appears under `.next/static`, or
  if `.next/server/app/api/dev` exists.
- Database: Drizzle + better-sqlite3, schema in `src/db/schema.ts`, migrations checked
  in under `drizzle/` (`npm run db:generate` after schema edits, then read the SQL:
  drizzle-kit's SQLite table rebuilds can select columns that do not exist yet, and
  `0001` was hand-fixed). `applyMigrations` runs with foreign keys off and a
  `foreign_key_check` after, per SQLite's ALTER TABLE procedure; `src/db/migrations.test.ts`
  replays a populated phase-1 database through every later migration. Enums are text +
  CHECK, ids are UUID v7 (`src/lib/uuid.ts`), timestamps epoch ms, money integer
  cents + currency. `donations` and `rewards`/`sponsors` never share a foreign key.
- Every number on screen is derived from rows in `src/db/queries/*`; nothing is typed
  into a component. The seed (`src/seed/build.ts`) is pure and deterministic for a
  given anchor day and RNG seed; `src/seed/build.test.ts` holds the invariants and
  asserts the seeded draws equal `draw()` for the same inputs (`SEED_DRAWS`).
- Pure rules live under `src/domain/` and are unit-tested, no I/O: `draw.ts` (pools,
  round robin, bracket, advancement rule), `bracket.ts` (advance/forfeit/bye),
  `standings.ts` (tiebreak order in `TIEBREAK_ORDER`), `transitions.ts` (the two
  status matrices; `final` is only ever set by actor `system`, i.e. the consensus
  phase), `scoreline.ts`, `team.ts`. Inject the clock (`src/lib/clock.ts`) and rng
  (`src/lib/rng.ts`); never read `Date.now()` in a domain module.
- Layering for anything that writes: route handler (`src/app/api/**`, Node runtime,
  zod at the boundary, envelope from `src/lib/api.ts`, errors through
  `src/server/http.ts`) → service (`src/server/*`, owns the transaction, calls the
  domain, writes `audit_log` through `src/server/audit.ts` in the same transaction)
  → `src/db/queries/*` for reads. Routes never touch the database directly. Route
  tests use `src/test/routes.ts` (a migrated temp SQLite file installed as the
  process connection) and cover every endpoint. Public routes serialize the
  `PublicTournament` projection (no `lucra_*` columns) and never see drafts;
  organizer routes return the full row.
- `teams.seed` is the organizer's entry seed, written only from the draw request's
  `seeds` list; the pools stage stores its inputs as `tournaments.draw_config_json`
  and the bracket stage reads the advancement rule from there.
- Session and roles: a signed HttpOnly SameSite=Lax cookie (`src/server/auth/session.ts`,
  secret `SESSION_SECRET`, dev default only outside production, ephemeral + warned in
  production when unset — `/health` reports which). `users.role` gates `/api/admin/*`
  via `requireOrganizer`. `POST /api/dev/login` lives in `route.dev.ts`, an extension
  `next.config.ts` registers only outside production or with `SIDEOUT_DEV_LOGIN=true`.
- Outbound SMS (sign-in codes, invites) only through `src/server/auth/sms.ts`
  (`getSmsSender()` is the log sender outside production and null in production until
  a provider exists, so request-code answers 503 `sms_unavailable` there); the
  charitable donation provider only through `src/server/donations/stub-provider.ts`
  (pending → succeeded after `STUB_SETTLE_DELAY_MS` on the injected clock, swept on
  read). Lucra entry at registration is `lucraEntryHook` in
  `src/server/registration.ts`, which returns `not_available` until phase 4.

## Phase status

Phase 1 (Foundation) and phase 2a (Domain + application API) are complete: shell,
primitives, schema, seed, `/health`, Home, `/t/[slug]` Overview and Impact, the draw
engine, bracket advancement, standings tiebreaks, status machines, phone sign-in,
and every §9 public, player and organizer route except score submission, the close
and dispute routes, and the Lucra routes. Bracket and Standings tabs, registration,
sign-in and the organizer console screens are the phase-2b task and consume the API
here; the consensus state machine is the phase-3 task and calls `advanceWinner` /
`seedBracketFromPools`. `double_elim` is in the enum but refused by `draw()`. No
Lucra code exists yet (phase 4); `src/lucra/version.ts` is the only file there.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
