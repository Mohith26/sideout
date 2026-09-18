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
- The public demo is a Railway service built from `Dockerfile` + `railway.json` (start
  command: seed once, migrate every boot, `next start`; `docker-entrypoint.sh` drops to
  `node`); `docs/deploy.md` "Deployed" has the URL, the variables and the one redeploy
  command, and `src/docker.test.ts` pins the container contract. `tsx` is a production
  dependency because the start command's CLIs run on it.
- CI (`.github/workflows/ci.yml`) mirrors `.no-mistakes.yaml` in its `build-test` job; keep
  them in sync. Its separate `e2e` job runs `npm run test:e2e` (a browser download, so not a
  pipeline command); the §15 flows must stay green there.

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
  the browser. `npm run test:bundle` (`src/env.bundle-check.ts`) builds in sandbox mode
  with sentinel backend key and webhook secret and fails if either, or its variable
  name, appears under `.next/static`, or if `.next/server/app/api/dev` (dev login) or
  `.next/server/app/api/rest/%5Fmock` (mock state) exists. Route files gated by page
  extension (`route.dev.ts`, `route.mock.ts`) are registered by
  `src/lib/build-gates.ts`, which `next.config.ts` imports.
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
  round robin, bracket, advancement rule; byes are placed by `seedBracketSlots`),
  `bracket.ts` (advance/forfeit/slot fill),
  `standings.ts` (tiebreak order in `TIEBREAK_ORDER`; per-match `CROSS_POOL_ORDER`
  for ranking across pools of unequal size), `transitions.ts` (the two
  status matrices; `final` is only ever set by actor `system`, i.e. the consensus
  phase), `scoreline.ts` (legality rules; free of Node built-ins because the score
  sheet runs them in the browser), `scoreline-hash.ts` (the canonical form and
  sha256; needs `node:crypto`, so ESLint refuses it under `src/components` and
  `npm run test:bundle` fails if a crypto polyfill reaches `.next/static`),
  `team.ts`. Inject the clock (`src/lib/clock.ts`) and rng (`src/lib/rng.ts`);
  never read `Date.now()` in a domain module.
- Layering for anything that writes: route handler (`src/app/api/**`, Node runtime,
  zod at the boundary, envelope from `src/lib/api.ts`, errors through
  `src/server/http.ts`) → service (`src/server/*`, owns the transaction, calls the
  domain, writes `audit_log` through `src/server/audit.ts` in the same transaction)
  → `src/db/queries/*` for reads. Routes never touch the database directly. Route
  tests use `src/test/routes.ts` (a migrated temp SQLite file installed as the
  process connection) and cover every endpoint. Public routes serialize the
  `PublicTournament` projection (no `lucra_*`, `draw_config_json` or
  `close_preview_json` columns) and never see drafts; organizer routes return the
  full row; `/t/[slug]` applies the same rule and lets only an organizer session
  open a draft.
- `teams.seed` is the organizer's entry seed, written only from the draw request's
  `seeds` list; the pools stage stores its inputs as `tournaments.draw_config_json`
  and the bracket stage reads the advancement rule from there.
- Score consensus (spec §10): `src/domain/consensus.ts` is the pure machine
  (`CONSENSUS_TRANSITIONS`, canonicalization from the submitter's side via
  `canonicalizeSubmission`, `judgeSubmission` on team ids) and
  `src/server/consensus.ts` owns the transactions. A scoreline is judged by
  `judgeMatch` and refused with `illegal_scoreline` before any row is written; a
  team's resubmission supersedes its earlier row (`superseded_by_id`), never
  updates it; the first legal submission takes a `scheduled` match through
  `in_progress` to `awaiting_scores` as the player; `enterAgreed` is the only
  path to `agreed` and to `final` (actor `system`), and it mints
  `idempotency_key` only when null. **Every Lucra write must call
  `assertMayWriteToLucra` first** (exported from both modules): it throws unless
  the state is `agreed` with a minted key. An organizer's retry of a
  `rejected`/`partial` attempt calls `assertMayRetryLucraWrite` instead (same
  key; never the first-write gate). Audit vocabulary is `CONSENSUS_AUDIT`; the
  seed writes the same rows and entries the service would. Closing
  (`src/server/close.ts`) is preview → hash →
  confirm: `previewClose` names every blocker, `closeTournament` refuses
  `close_blocked`/`preview_stale`, freezes the preview on
  `tournaments.close_preview_json`, and ends at `lucraSettlementHook`, which runs
  `settleTournament` after the close commits. A forfeit settles a disputed match: its consensus row stays `disputed`
  but records `resolved_by_user_id` and `disputed_reason` "Settled by forfeit"
  (audit `consensus.settled_by_forfeit`); the queue, the close, the match page
  and the submission check all key on the match status.
- Lucra (spec §7, §8; `docs/lucra-integration.md` has the write-path diagram and the
  strictness table): `src/lucra/` is `endpoints.ts` (every path, header and error string;
  the legacy-to-Forge migration is this file plus `types.ts`), `types.ts` (zod for every
  request and response, `StrictMatchupTarget`), `errors.ts` (the sealed `LucraError`
  union the app branches on), `client.ts` (5s/10s timeouts, three jittered retries on 5xx
  and transport only, zod on every response, key redacted), `mock.ts` (the in-process
  Lucra), `matcher.ts` (the ported similarity algorithm, `literal` | `doc-examples`;
  `matcher.test.ts` is the table of which published examples reproduce),
  `webhook-signature.ts`, `adapter.ts` (the only public surface, re-exported by
  `index.ts` as `@/lucra`). **ESLint refuses `@/lucra/client`, `@/lucra/mock` and any
  `fetch` naming a Lucra host outside `src/lucra/`** (`import-boundary.test.ts` proves it).
  `src/domain/lucra-score.ts` is the pure match → request mapping shared by the service
  and the seed. `src/server/lucra.ts` owns the write path: `submitConsensusScores`
  (gate → `ensureMatchupTarget` (§7.3.4, cached on `tournaments.lucra_matchup_id`; a
  count other than one is a blocking `LucraAlert` in `lucra_alert_json` and a live event
  moved to `awaiting_settlement` with no close preview — the organizer's forced verify
  takes the `awaiting_settlement → live` edge back, and `closeTournament` also runs from
  that frozen state; a query that did not answer only raises a non-blocking alert) →
  pending row + `submitting` → adapter → row updated → `accepted | partial | rejected`),
  `retryConsensusScores`, `sweepStaleSubmissions` (a `pending` row older than
  `STALE_SUBMISSION_MS` with its consensus `submitting` becomes `transport_error`/`rejected`;
  runs on the layer's first use per process and before settlement), `settleTournament`
  (the close's `lucraSettlementHook`; sweeps unwritten agreed matches, reads participants
  back to learn Lucra ids, sends the documented complete call,
  `awaiting_settlement → settled`), `reconcileParticipants`, `linkLucraAccount` (mints
  `external_id` only; Lucra user ids come from the read-back and webhooks, never the
  client). The score and resolve routes call `writeAgreedConsensus` after the consensus
  commits (inline; it never throws; player-facing messages come from `LUCRA_ERROR_MESSAGE`).
  `bindLucraAccount` (`POST /api/me/lucra/bind`) records a Lucra user id only from
  Lucra's side (the mock's account, or the participant read-back); the SDK's id is a
  checked hint. `lucraEntryStatus` is the registration step's truth (verified matchup +
  who Lucra lists), served by `GET /api/tournaments/:slug/lucra/entry`.
  In mock mode outside production the webhook secret is a random per-process value
  shared by the mock signer and the receiver (`resolveWebhookSecret`); production never
  falls back. A frozen event (`awaiting_settlement`, no close preview) still takes
  organizer forfeits, so it can be ended without Lucra. Settlement reads the matchup
  back before and after a refused complete: `CLOSED` on read-back is the settlement.
  `src/server/lucra-webhooks.ts` is the receiver (capped raw body → signature → derived
  event id → dedupe → persist → transaction; an unverified delivery is never persisted,
  and no webhook changes a tournament status or a reward) and `deliverPendingMockWebhooks` hands the mock's
  signed emissions to it in process. `getLucra()` seeds the mock from the database once
  per process (`buildMockSeedFromDb`: one matchup per tournament plus the overlapping and
  recreational ones, accepted rows replayed); tests get a fresh one per `createTestApp()`.
  `/admin/lucra` and `GET /api/admin/lucra/submissions` show every attempt row verbatim.
- Browser SDK (spec §7.5, §12.5; `docs/lucra-integration.md` "The browser"):
  `lucra-web-sdk` is pinned in `package.json` from the GitHub tag (not npm; `npm ci`
  fetches the tarball over https) and repeated in `src/lucra/version.ts` for `/health`,
  which also reports the installed manifest's version. **Only
  `src/components/lucra/LucraGate.tsx` imports `lucra-web-sdk` or `@/lucra/sdk-mock`**
  (ESLint; `src/test/lucra-sdk.ts` is the test helper); everything else uses
  `useLucra()`. `src/lucra/sdk-surface.ts` types the slice both modules satisfy and holds
  `classifySdkFailure`, the one mapping from the SDK's classes and codes to the spec's
  seven UI states (`instanceof` + `code`, never message text; `NotAllowed` comes from
  `accountStatus`). The gate branches on the inlined `process.env.NEXT_PUBLIC_LUCRA_MODE`
  (derived from `LUCRA_MODE` by `next.config.ts`; `src/env.ts` refuses a disagreement):
  `mock` loads `src/lucra/sdk-mock.ts`, a stand-in with the SDK's surface that renders
  sheets on the tokens into the same host and resolves flows against the server mock
  through `POST /api/rest/_mock/sdk` (`route.mock.ts`, `src/server/lucra-sdk-mock.ts`;
  the Sideout session stands in for Lucra's; every change goes out as the mock's signed
  webhook, so a production build in mock mode needs `LUCRA_WEBHOOK_SECRET` for rows to
  change — `playwright.config.ts` sets one). `npm run test:bundle` asserts a sandbox
  build ships the real SDK and none of the stand-in. The SDK is initialized with
  `autoJoin: false`: entry is `joinTournament` from `LucraEntryStep`, shown from the
  read-back only. Lucra's web theme is tenant-side; `src/lucra/theme.ts` computes the ten
  options from `tokens.css` and `/admin/lucra` shows them. The stand-in's login sheet
  closes before it emits `loginSuccess` (the gate restores the host after that event).
- Session and roles: a signed HttpOnly SameSite=Lax cookie (`src/server/auth/session.ts`,
  secret `SESSION_SECRET`, dev default only outside production, ephemeral + warned in
  production when unset — `/health` reports which; the ephemeral value lives on
  `globalThis` because a production server evaluates `src/env.ts` once per route bundle).
  `users.role` gates `/api/admin/*` via `requireOrganizer`; server components read the
  same cookie through `src/server/auth/viewer.ts`. Every page under `/organizer` gates
  itself before reading any data (a layout's check does not keep a page segment out of
  the RSC payload): the console pages and `src/app/organizer/layout.tsx` through
  `src/app/organizer/_lib.ts` (`requireOrganizerViewer`: players and anonymous get
  404), the dispute queue and the close flow through `organizerViewer()`.
  `POST /api/dev/login` lives in `route.dev.ts`, an extension
  `next.config.ts` registers only outside production or with `SIDEOUT_DEV_LOGIN=true`.
  Sign-in rate limits key on `x-forwarded-for` only when `TRUSTED_PROXY_HOPS` says how
  many proxies vouch for it: a public deploy behind a proxy must set `1` (production
  warns at boot while it is 0); `AUTH_CODE_GLOBAL_CAP` is the process-wide backstop.
- Outbound SMS (sign-in codes, invites) only through `src/server/auth/sms.ts`
  (`getSmsSender()` is the log sender outside production and null in production until
  a provider exists, so request-code answers 503 `sms_unavailable` there); the
  charitable donation provider only through `src/server/donations/stub-provider.ts`
  (pending → succeeded after `STUB_SETTLE_DELAY_MS` on the injected clock, swept on
  read). Lucra entry at registration is the player's SDK action: `lucraEntryHook` in
  `src/server/registration.ts` reports the roster's link state at registration time,
  `entryStatusFor` the live read-back for the step.

## Polish (phase 5 conventions)

- Motion: the six named transitions (§12.4) are `src/styles/motion.css` (keyframes on the
  motion tokens, every one with an opacity-only `prefers-reduced-motion` branch that
  `src/components/motion/motion.test.ts` asserts) plus `src/components/motion/`:
  `ScoreDisplay` (count-up), `flip.ts`/`FlipRows` (the ~40-line FLIP helper keyed on
  `data-team-id`, WAAPI, `--surf` rank flash), `LiveDot` (the pulse), `reduced-motion.ts`
  (the one media-query read). Bracket paths draw through `data-advanced`; the sheet, the
  backdrop and the confirm check are `@utility` classes in `motion.css`. Never add a motion
  dependency.
- Offline: `public/sw.js` is plain JS, registered by
  `src/components/offline/ServiceWorkerRegistration.tsx` with the build sha as `?v=` (a new
  sha rotates every cache) in production only; `src/lib/offline/sw.test.ts` runs it under a
  fake worker scope. The score outbox is `src/lib/offline/outbox.ts` (IndexedDB, pure replay
  over an injected `send`) and `client.ts` (the browser singleton); the sheet queues through
  it when the send is transient and the server never sees a difference. Copy says "saved on
  this phone", never "sent".
- Every page segment has a `loading.tsx` whose `Skeleton`s match the shape of the page (the
  static `/offline` page excepted); error boundaries sit at the root, `/t/[slug]`, `/m/[id]`
  and `/organizer`; `EmptyState` for nothing-to-show. `e2e/a11y.spec.ts` runs axe at 390 and
  1280 (serious/critical fail), the heading outline, 44px targets, the focus ring, the
  sheet's focus trap and the live regions; keep new screens inside its route list.
- `src/copy-audit.test.ts` greps the source of every screen and component for
  legal-clearance, casino, blame and emoji language and the §14 treatments; a new phrase
  that trips it is wrong until proven otherwise, and an allowance needs the exact line.
- `scripts/screenshots.ts` re-captures `docs/screenshots/` from the e2e server;
  `docs/deploy.md` is what a host needs.

## Screens (phase 2b conventions)

- Client components never import a server module (type-only imports are fine):
  `Container` is `src/components/shell/Container.tsx` (client-safe), `AppShell` reads
  the viewer for the nav. Pages that launch Lucra flows (`/me`, `/t/[slug]/register`)
  wrap their content in `<LucraGate>` and pass the responsible-play, self-limit and
  support URLs from `env` as props. Enum labels live in
  `src/components/tournament/labels.ts`; pure round names in `src/lib/rounds.ts`. Pass
  enum vocabularies from a server page as props rather than importing `src/db/schema`
  values into a client component.
- Browser writes go through `src/lib/api-client.ts` to the existing route handlers (the
  tested write path), with the same zod rules mirrored on the form; there are no server
  actions. Pages that need a session `redirect(signInHref(path))`
  (`src/lib/redirects.ts` only honours same-origin paths).
- Live figures re-render through `src/components/ui/LiveRefresh.tsx` (`router.refresh`
  on a cadence, 10s for standings/bracket/board, while the tab is visible); pages stay
  `force-dynamic`, and the standings API keeps its 10s `Cache-Control`.
- Bracket: `src/components/bracket/model.ts` is the pure layout/keyboard model used by
  the public tab, the organizer preview (`DrawPanel`) and the tests; `Bracket.tsx` is
  the SVG. Connectors are one `<path data-from data-to data-advanced>` per feeder for
  the phase-5 draw animation; standings rows carry `data-team-id` for the FLIP.
- The console (`src/app/organizer/**`, `layout.tsx` + `ConsoleNav`) links to
  `/organizer/disputes`, `/organizer/events/[id]/close`, `/organizer/events/[id]/lucra`,
  `/admin/lucra` and `/m/[id]`; every console page renders under this layout and gates
  itself.
  `e2e/screens.spec.ts` screenshots every screen at 390/768/1280 into
  `test-results/screens/` and asserts no sideways scroll at 390.
- Testing Library does not auto-cleanup here (no vitest globals): component tests add
  `afterEach(cleanup)`. In `next dev`, open `http://localhost:<port>` (not `127.0.0.1`)
  or client components never hydrate.

## Phase status

All five phases are complete — 1 (Foundation), 2a (Domain + application API), 2b (Screens),
3 (Consensus), 4a (Lucra integration layer), 4b (the browser SDK) and 5 (Polish): shell, primitives,
schema, seed, `/health`, Home, every `/t/[slug]` tab (Overview, Bracket with pool sheets, Standings, Impact), the
draw engine, bracket advancement, standings tiebreaks, status machines, phone sign-in
(`/sign-in`), teams and registration (`/teams/new`, `/t/[slug]/register`, `/me`), the
organizer console (`/organizer/events`, the builder with its live draw preview, the
court board), every §9 route, the score consensus machine with `/m/[id]` and its score
sheet, the dispute queue (`/organizer/disputes`), the two-step close
(`/organizer/events/[id]/close`) that now settles through Lucra, the
adapter/client/mock/matcher, the consensus-time write, the organizer retry, the webhook
receiver, `POST /api/me/lucra/link`, participant reconciliation and `/admin/lucra`. The
last pool match to become terminal — agreed, resolved or forfeited — seeds the bracket
through `seedBracketIfPoolsComplete` (`src/server/matches.ts`, after the resolving
transaction commits). `double_elim` is in the enum but refused by `draw()`. Phase 4b
added `LucraGate` and `useLucra()`, the SDK stand-in for mock mode, the registration entry step
(`LucraEntryStep`, with `GET /api/tournaments/:slug/lucra/entry`), the profile's
`VerificationRow`, `WalletChip`, `ResponsiblePlayLinks` and `RewardsAction`,
`POST /api/me/lucra/bind`, the organizer's `/organizer/events/[id]/lucra`
reconciliation page (console nav: Events, Disputes, Lucra) and the installed SDK
version on `/health`. Phase 5 added the six transitions, the installable PWA with the
service worker and the score outbox, shape-matched loading/error/empty states, the axe and
keyboard pass, the §15.25–26 Playwright flows (`e2e/flows.spec.ts`) and the offline flow
(`e2e/offline.spec.ts`) in CI, the copy audit, the README and `docs/deploy.md`. Real money
stays behind `FEATURE_REAL_MONEY=false`. Deployed on Railway (`docs/deploy.md`,
"Deployed"), read-only for visitors until sign-in has an SMS provider. Not built, on
purpose: a real SMS provider, sandbox/production Lucra credentials, `double_elim` (see
`docs/open-questions.md`, "Follow-ups").

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
