# Sideout

Charity beach volleyball tournaments: organizers run events, teams play on the sand, both teams confirm every score, and the competition layer (rewards, settlement, compliance) is handled by Lucra. This is phase 1 of 5 — the foundation. The full build brief is [`docs/build-spec.md`](docs/build-spec.md); open questions with their fallbacks are in [`docs/open-questions.md`](docs/open-questions.md).

## 60-second quickstart

Needs Node 22+ (`.nvmrc`) and npm. No Lucra credentials are required.

```sh
npm i
npm run seed     # creates ./data/sideout.db, applies migrations, loads the demo dataset
npm run dev      # http://localhost:3000
```

`LUCRA_MODE=mock` is the default, so no `.env` file is needed; `.env.example` lists every variable for later phases. `GET /health` reports the build sha, Lucra mode, pinned SDK version, and migration state.

The seed is deterministic and idempotent. It loads one beneficiary, 48 players, and three events — one live (24 teams, pool play complete, quarterfinals under way with a disputed match, a match awaiting scores, and a bye), one open for registration, and one settled with rewards — and every number on screen is derived from those rows.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` (strict, no `any`) |
| `npm run lint` | ESLint, warnings are errors |
| `npm test` | Vitest unit and integration tests |
| `npm run test:bundle` | Production build with a sentinel backend key, then a scan of `.next/static` proving it never reaches the browser |
| `npm run test:e2e` | Playwright smoke test (`npx playwright install chromium` first) |
| `npm run seed` | Reset and populate the SQLite database |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` with drizzle-kit |
| `npm run db:migrate` | Apply checked-in migrations |
