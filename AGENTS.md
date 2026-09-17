# Sideout — agent notes

Charity beach volleyball tournament platform with a Lucra integration. The
acceptance contract is `docs/build-spec.md` (verbatim brief, five build phases);
`docs/open-questions.md` lists every spec `OPEN` item, its implemented fallback, and
the phase that owns it. Never resolve an OPEN by guessing: implement the fallback,
mark it `// OPEN:` in code, and add a row there.

## Working here

- Node 22+ (`.nvmrc`), npm. `npm i && npm run seed && npm run dev` boots with no
  env file; `LUCRA_MODE=mock` is the default. `.env.example` documents the rest.
- Before finishing, run what CI runs (`.no-mistakes.yaml` is the source):
  `npm run typecheck && npm run lint && npm test && npm run test:bundle && npm run build`.
  `npm run test:e2e` (Playwright, needs `npx playwright install chromium`) seeds its
  own database at `data/sideout.e2e.db` and builds a production server.
- Next.js 16 differs from older training data: read `node_modules/next/dist/docs/`
  before touching routing, caching, fonts, or config. `params` is a Promise;
  `PageProps`/`LayoutProps` come from `next typegen` (run by `npm run typecheck`).
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
  backend key and fails if it, or the variable name, appears under `.next/static`.
- Database: Drizzle + better-sqlite3, schema in `src/db/schema.ts`, migrations checked
  in under `drizzle/` (`npm run db:generate` after schema edits). Enums are text +
  CHECK, ids are UUID v7 (`src/lib/uuid.ts`), timestamps epoch ms, money integer
  cents + currency. `donations` and `rewards`/`sponsors` never share a foreign key.
- Every number on screen is derived from rows in `src/db/queries/*`; nothing is typed
  into a component. The seed (`src/seed/build.ts`) is pure and deterministic for a
  given anchor day and RNG seed; `src/seed/build.test.ts` holds the invariants.
- Pure rules live under `src/domain/` (scoreline legality and canonical hash, pool
  standings, team roster) and are unit-tested; later phases extend them.

## Phase status

Phase 1 (Foundation) is complete: shell, primitives, schema, seed, `/health`, Home,
and `/t/[slug]` with real Overview and Impact tabs. Bracket and Standings tabs are
honest placeholders until the phase 2 draw engine. No Lucra code exists yet
(phase 4); `src/lucra/version.ts` is the only file in that directory.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
