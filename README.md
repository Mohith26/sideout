# Sideout

Charity beach volleyball tournaments: organizers run events, teams play on the sand, both teams confirm every score, and the competition layer (rewards, settlement, compliance) is handled by Lucra. Phases 1 (foundation) and 2 (domain logic and the application API) of 5 are built; the screens that consume the API, the score consensus machine, and the Lucra integration follow. The full build brief is [`docs/build-spec.md`](docs/build-spec.md); open questions with their fallbacks are in [`docs/open-questions.md`](docs/open-questions.md).

## 60-second quickstart

Needs Node 22+ (`.nvmrc`) and npm. No Lucra credentials are required.

```sh
npm i
npm run seed     # creates ./data/sideout.db, applies migrations, loads the demo dataset
npm run dev      # http://localhost:3000
```

`LUCRA_MODE=mock` is the default, so no `.env` file is needed; `.env.example` lists every variable for later phases. `GET /health` reports the build sha, Lucra mode, pinned SDK version, migration state, where the session-signing secret came from, and whether the dev sign-in route is compiled in.

Three variables matter once this runs anywhere public: `SESSION_SECRET` (signs the session cookie; without it a production process signs with a random per-process secret and warns), `SIDEOUT_DEV_LOGIN` (must stay unset; it compiles `POST /api/dev/login` into a production build for test targets only) and `TRUSTED_PROXY_HOPS` (how many reverse proxies sit in front of the process; the per-address rate limit on sign-in reads `x-forwarded-for` that many hops from the right and is off at the default `0`, which production warns about at boot — a deploy behind one proxy sets `1`). `AUTH_CODE_GLOBAL_CAP` (default 2000 per ten minutes) is the process-wide backstop on sign-in codes. Phone sign-in needs an SMS provider, which no phase has chosen yet: in production `POST /api/auth/request-code` answers `503` with `detail.code = "sms_unavailable"` until one implements `SmsSender`.

The seed is deterministic and idempotent. It loads one beneficiary, 48 players, and three events — one live (24 teams, pool play complete, a semifinal in progress, a disputed quarterfinal, a quarterfinal awaiting scores, and a first-round bye), one open for registration, and one settled with rewards — and every number on screen is derived from those rows.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` (strict, no `any`) |
| `npm run lint` | ESLint, warnings are errors |
| `npm test` | Vitest unit and integration tests |
| `npm run test:bundle` | Production build with a sentinel backend key, then a scan of `.next/static` proving it never reaches the browser |
| `npm run test:e2e` | Playwright smoke over the pages and the API against a production build (`npx playwright install chromium` first) |
| `npm run seed` | Reset and populate the SQLite database |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` with drizzle-kit |
| `npm run db:migrate` | Apply checked-in migrations |

## API

Every route validates with zod and answers `{ ok: true, data }` or `{ ok: false, error: { code, message, detail? } }`. Sessions are a signed HttpOnly cookie from `POST /api/auth/verify` (phone + one-time code; outside production the code comes back in the response as `devCode`). Organizer routes need `users.role = organizer`.

| Route | Who | What |
|---|---|---|
| `GET /api/tournaments?status=live,registration_open` | public | list with derived figures |
| `GET /api/tournaments/:slug` | public | detail: teams, pools with standings, bracket, sponsors |
| `GET /api/tournaments/:slug/standings` | public | computed from `sets` rows, `Cache-Control: public, max-age=10` |
| `GET /api/tournaments/:slug/impact` | public | donation totals and goal progress |
| `GET /api/matches/:id` | public | one match with participants, sets, consensus state, next seat |
| `POST /api/auth/request-code`, `POST /api/auth/verify`, `POST /api/auth/logout` | anyone | phone sign-in |
| `POST /api/teams` | player | create a team and invite a partner by phone |
| `POST /api/teams/:id/join` | player | accept the invite addressed to your phone |
| `POST /api/tournaments/:slug/register` | player | register a complete team; creates the charitable donation intent (stub provider) |
| `GET /api/me` | player | profile, Lucra link state, teams and history, invites, rewards |
| `POST /api/admin/tournaments`, `PATCH /api/admin/tournaments/:id` | organizer | create; edit fields, sponsors, and status through the state machine |
| `POST /api/admin/tournaments/:id/draw[?preview=1]` | organizer | pools + bracket in one transaction, configuration stored on the tournament; `{ stage: "bracket" }` seeds the bracket from finished pools with the stored advancement rule |
| `POST /api/admin/matches/:id/forfeit` | organizer | forfeit one side; the other advances |
| `POST /api/dev/login` | non-production only | sign in as a seeded user by id or phone |

Draw formats: `pool_to_bracket` (snake-seeded pools, round robin per pool, single-elimination bracket sized by "top N per pool plus best remaining"), `single_elim`, `round_robin`. `double_elim` is refused until it is built. `teams.seed` is the organizer's entry seed (set through the draw request's `seeds` list, kept across re-draws); the order a bracket is seeded in lives on its round-1 slots. Standings tiebreaks, in order: wins, head-to-head (two-way ties only), set ratio, point differential, points for, team id. Across pools (ranking pool winners against each other for bracket seeds, and picking the best remaining), where pools may differ in size by one, the order is per match played: win percentage, set ratio, point differential per match, points for per match, team id.
