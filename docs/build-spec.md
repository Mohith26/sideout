# Sideout — Build Spec

A charity beach volleyball tournament platform with a real Lucra integration.

This document is the complete build brief. Read it fully before writing code. Where it
says MUST, treat it as a hard requirement. Where it says SHOULD, deviate only with a
stated reason. Where it says OPEN, do not invent an answer; implement the documented
fallback and surface the question.

---

## 1. What we are building

Sideout runs real-world charity beach volleyball tournaments. Organizers create an
event, teams register, pool play and a bracket are generated, scores are submitted from
phones on the sand by both teams, and the competition layer (tournaments, head-to-head
challenges, prize settlement, wallet, compliance) is powered by Lucra's SDK and REST
API rather than built in-house.

The product has two audiences in one app:

- **Players** — register a team, see their pool, submit scores, track standings, see
  what the event has raised, claim rewards.
- **Organizers** — build the event, monitor live play, resolve score disputes, close
  tournaments and trigger settlement.

The charity dimension is first-class, not decoration: every event has a beneficiary, a
fundraising goal, and a live impact figure that is visible on the same screen as the
leaderboard.

### Why it exists

This is a portfolio-grade reference integration. It has to be good enough that a
platform engineer at Lucra can read the code and see that the author understood their
product, their compliance model, and the places where a partner integration goes wrong.
That means: correct API shapes, a real trust boundary around scores, honest handling of
the things Lucra's docs leave ambiguous, and a UI that does not look generated.

---

## 2. Non-goals

Do not build these. They expand scope without improving the artifact.

- Live video, streaming, or highlight clips.
- Social feed, comments, DMs, or follower graph.
- Native iOS or Android apps. Web only, but mobile-first and installable as a PWA.
- Payment processing of any kind written by us. Lucra is the Merchant of Record for
  competition funds; charitable donations go through a separate documented stub.
- Custom KYC, identity verification, geolocation, or AML logic. Lucra owns all of it.
- Ranking systems beyond what a tournament needs (no global ELO ladder in v1).
- Multi-tenant white-labeling. One organizer brand, many events.
- Real money in production. See section 4.

---

## 3. Tech stack

MUST use:

- **Next.js 15+**, App Router, TypeScript strict mode.
- **Tailwind CSS** with a custom theme layer. No component library defaults shipped
  visibly (see section 14).
- **SQLite** via `better-sqlite3`, schema managed with **Drizzle ORM** and checked-in
  migrations. SQLite keeps the demo runnable with zero infrastructure; the Drizzle
  schema must stay Postgres-compatible so the swap is a driver change.
- **Zod** for all input validation at route boundaries and for parsing Lucra responses.
- **Vitest** for unit and integration tests. **Playwright** for two end-to-end flows.
- Node 22+.

MUST NOT use: a UI kit's stock theme, a charting library's default styling, any
animation library heavier than needed (prefer CSS transitions, the Web Animations API,
and a small FLIP helper written in-repo).

Server state lives in route handlers and server actions. Client state stays local to
components; no global store.

---

## 4. Compliance boundaries — read this before designing any flow

Lucra holds the licenses and acts as Merchant of Record for competition funds. Our job
is to never accidentally become a money transmitter or an unlicensed contest operator.
These rules are non-negotiable.

1. **v1 runs free-to-play with rewards only.** Lucra's free-to-play product is
   available in all 50 states; the real-money product is restricted (Lucra's own
   surfaces state 42 and 43 states in different places, so treat the exact number as
   OPEN and read it from config, never hardcode it in copy). Free-to-play removes the
   state-eligibility matrix from the critical path of a demo.
2. **Real-money head-to-head is behind a feature flag, default off.** Build the code
   path, gate it at `FEATURE_REAL_MONEY=false`, and document it. Do not enable it.
3. **Charity entry fees are not prize money and never mix.** A team's entry fee is a
   charitable donation processed through a separate donation provider (stubbed, see
   6.4). Prize pools are sponsor-funded rewards settled by Lucra. The two ledgers are
   separate tables with no foreign key between them. Never compute a prize from
   donation revenue.
4. **The interaction between charitable gaming rules and skill-contest rules is OPEN.**
   Many states regulate charitable gaming under an entirely separate statute from
   skill contests. Do not write copy implying legal clearance. Put the question in the
   open-questions list.
5. **Age and identity gating is Lucra's flow, launched by us.** Even in headless
   integrations, Lucra requires the user be routed through Lucra's own SDK UI to
   authenticate, add or withdraw funds, submit the identity form for age and location
   compliance, and provide demographics for free-to-join tournaments. We launch those
   flows; we never reimplement them or collect that data ourselves.
6. **We never store identity data.** No SSN, no government ID, no KYC artifacts. If a
   Lucra flow returns a verification state, store only the state enum.
7. **Responsible play surfaces are required, not optional.** Link Lucra's responsible
   gaming policy and self-limit tooling anywhere a wallet balance is visible.

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────┐
│  Browser (Next.js client)                            │
│   • Sideout UI                                       │
│   • Lucra Web SDK (iframe), init: tenantId + apiKey  │
│     - launches compliance / wallet / identity flows  │
└───────────────┬──────────────────────────────────────┘
                │  our own API only; never the Lucra
                │  backend key from the client
┌───────────────▼──────────────────────────────────────┐
│  Next.js server (route handlers, server actions)     │
│   • tournament + bracket domain logic                │
│   • score consensus state machine  ◄── trust boundary│
│   • Lucra adapter (mock | sandbox | production)      │
│   • webhook receiver                                 │
└───────────────┬──────────────────────────────────────┘
                │  X-Lucra-Api-Key (BACKEND key, server only)
┌───────────────▼──────────────────────────────────────┐
│  Lucra REST API  /  Lucra mock                       │
└──────────────────────────────────────────────────────┘
```

Three hard architectural rules:

- The **BACKEND** Lucra key exists only in server environment variables and is never
  serialized into any response. The **WEB** key and `tenantId` are the only Lucra
  credentials that may reach the browser.
- **No score reaches Lucra directly from a client.** Every score passes through our
  consensus state machine first (section 10).
- The Lucra adapter is the single module allowed to make outbound Lucra calls. Nothing
  else imports `fetch` against a Lucra host.

---

## 6. Data model

Drizzle schema, SQLite-backed, Postgres-compatible. All ids are UUID v7 strings. All
timestamps are integer epoch milliseconds stored UTC. Money is integer cents with an
explicit currency column; never a float.

### 6.1 Identity and teams

**`users`** — `id`, `display_name`, `phone_e164` (unique, nullable), `email`
(nullable), `avatar_url`, `created_at`.
Sideout's own account record. Deliberately thin.

**`lucra_links`** — `id`, `user_id` → users, `lucra_user_id` (nullable until known),
`external_id` (unique, the value we send to Lucra as metadata), `verification_state`
enum(`unverified`,`verified`,`not_allowed`,`demographics_missing`), `linked_at`,
`last_synced_at`.
`external_id` MUST be a stable opaque id we mint, not the user's email or phone.

**`teams`** — `id`, `tournament_id`, `name`, `seed` (nullable), `status`
enum(`registered`,`checked_in`,`withdrawn`), `created_at`.
Beach volleyball is played in pairs; a team has exactly 2 members in v1, enforced in
application logic with a check constraint on the count.

**`team_members`** — `id`, `team_id`, `user_id`, `role` enum(`captain`,`player`).
Unique on (`team_id`,`user_id`).

### 6.2 Events and play

**`tournaments`** — `id`, `slug` (unique), `name`, `subtitle`, `beneficiary_id` →
charities, `venue_name`, `venue_city`, `venue_state`, `starts_at`, `ends_at`,
`format` enum(`pool_to_bracket`,`single_elim`,`double_elim`,`round_robin`),
`division` enum(`open`,`womens`,`mens`,`coed`,`rec`),
`max_teams`, `entry_donation_cents`, `fundraising_goal_cents`,
`prize_kind` enum(`free_to_play_rewards`,`real_money`),
`status` enum(`draft`,`registration_open`,`registration_closed`,`live`,`awaiting_settlement`,`settled`,`cancelled`),
`lucra_matchup_id` (nullable), `lucra_external_id` (unique, what we put in
`matchupMetadata.externalId`), `lucra_game_id`, `lucra_location_id` (nullable),
`created_at`.

**`pools`** — `id`, `tournament_id`, `label` (e.g. "Pool A"), `court_label`.

**`pool_teams`** — `id`, `pool_id`, `team_id`. Unique on both.

**`matches`** — `id`, `tournament_id`, `pool_id` (nullable for bracket matches),
`round` (integer, bracket round or pool round), `bracket_position` (nullable),
`court_label`, `team_a_id`, `team_b_id` (nullable for byes),
`best_of` enum(`1`,`3`),
`status` enum(`scheduled`,`in_progress`,`awaiting_scores`,`disputed`,`final`,`forfeited`,`bye`),
`winner_team_id` (nullable),
`next_match_id` (nullable, bracket advancement), `next_match_slot` enum(`a`,`b`, nullable),
`scheduled_at`, `started_at`, `finalized_at`.

**`sets`** — `id`, `match_id`, `set_number` (1..3), `team_a_points`, `team_b_points`,
`agreed` boolean. Derived from consensus, written only by the state machine.

### 6.3 Score consensus (the important part)

**`score_submissions`** — `id`, `match_id`, `submitted_by_user_id`,
`submitted_for_team_id`, `payload_json` (the full set-by-set scoreline as submitted),
`payload_hash` (sha256 of the canonicalized scoreline), `created_at`,
`superseded_by_id` (nullable).
One row per submission attempt. Never updated, only superseded. This is the audit trail.

**`match_consensus`** — `id`, `match_id` (unique), `state` enum(see section 10),
`agreed_payload_json` (nullable), `agreed_payload_hash` (nullable),
`disputed_reason` (nullable), `resolved_by_user_id` (nullable),
`idempotency_key` (unique, nullable — minted once when state first reaches `agreed`),
`updated_at`.

**`lucra_score_submissions`** — `id`, `match_id`, `tournament_id`,
`idempotency_key`, `request_json`, `response_json` (nullable),
`http_status` (nullable), `affected_matchup_ids_json`, `failed_matchup_ids_json`,
`outcome` enum(`pending`,`accepted`,`partial`,`rejected`,`transport_error`),
`attempt` integer, `created_at`.
Full request and response are persisted for every attempt. This table is what you show
an engineer when they ask "what did you actually send."

### 6.4 Charity and sponsorship

**`charities`** — `id`, `name`, `ein` (nullable), `mission_short`, `logo_url`,
`website_url`.

**`donations`** — `id`, `tournament_id`, `team_id` (nullable), `user_id` (nullable),
`amount_cents`, `currency`, `provider` enum(`stub`,`stripe`), `provider_ref`,
`status` enum(`pending`,`succeeded`,`refunded`,`failed`), `created_at`.
Provider `stub` is the default and simply marks succeeded after a short delay. There is
no real card processing in this build.

**`sponsors`** — `id`, `tournament_id`, `name`, `logo_url`, `tier`
enum(`presenting`,`court`,`prize`), `prize_contribution_cents`.

**`rewards`** — `id`, `tournament_id`, `team_id`, `placement`, `kind`
enum(`lucra_reward`,`sponsor_item`,`credit`), `amount_cents` (nullable),
`description`, `lucra_reward_ref` (nullable),
`status` enum(`projected`,`awarded`,`claimed`).

### 6.5 Plumbing

**`webhook_events`** — `id`, `provider` (`lucra`), `event_type`, `external_event_id`
(unique), `signature_valid` boolean, `raw_body`, `parsed_json`,
`processing_state` enum(`received`,`processed`,`ignored`,`failed`), `received_at`,
`processed_at`.

**`audit_log`** — `id`, `actor_user_id` (nullable), `actor_kind`
enum(`player`,`organizer`,`system`,`lucra_webhook`), `action`, `subject_type`,
`subject_id`, `detail_json`, `created_at`.
Every state transition on a match, tournament, or consensus record writes here.

---

## 7. Lucra integration contract

All of the following comes from Lucra's public documentation at
`docs.lucrasports.com`. Their docs also publish an `llms.txt` index, per-page markdown
(append `.md` to any docs URL), and a documentation MCP server at
`https://docs.lucrasports.com/lucra-sdk/~gitbook/mcp` — use those while building rather
than guessing.

### 7.1 Credentials

Three key types, each scoped to `sandbox` or `production`. Keys are issued by a Lucra
representative; there is no self-serve key generation.

| Key | Where it lives | Used for |
|---|---|---|
| `BACKEND` | server env only | REST API calls, header `X-Lucra-Api-Key` |
| `WEB` | may reach browser | Lucra Web SDK init |
| `MOBILE` | unused in this build | iOS / Android / React Native |

Web SDK initialization requires **both** `tenantId` and `apiKey`. Passing `tenantId`
alone is no longer supported on Web SDK versions above 0.20.2. Record the pinned SDK
version in `package.json` and in `/health`.

Environment variables:

```
LUCRA_MODE=mock|sandbox|production      # default: mock
LUCRA_BASE_URL=https://api.sandbox.lucrasports.com
LUCRA_BACKEND_API_KEY=
NEXT_PUBLIC_LUCRA_WEB_API_KEY=
NEXT_PUBLIC_LUCRA_TENANT_ID=
LUCRA_WEBHOOK_SECRET=
FEATURE_REAL_MONEY=false
```

The app MUST boot and be fully demoable with only `LUCRA_MODE=mock` set.

### 7.2 Score ingestion

Primary endpoint, type-agnostic:

```
POST {LUCRA_BASE_URL}/api/rest/user-score
X-Lucra-Api-Key: <BACKEND key>
Content-Type: application/json
```

```json
{
  "object": {
    "matchupId": "uuid",
    "matchupMetadata": { "externalId": "sideout-sandbar-2026-m41" },
    "gameId": "SIDEOUT_BEACH_2V2",
    "locationId": "uuid",
    "userScores": [
      {
        "userId": "uuid",
        "phoneNumber": "+15551234567",
        "userMetadata": { "externalId": "sideout-user-91f3" },
        "score": 21,
        "metadata": { "sets": "21-18,19-21,15-12", "match_id": "..." },
        "attemptFinished": true
      }
    ]
  }
}
```

At least one matchup identifier is required. One user identifier is required per entry
in `userScores`. Success response:

```json
{ "status": "success",
  "data": { "affectedMatchupIds": ["uuid"], "failedMatchupIds": [] } }
```

Note that `status` is `"success"` even on partial failure — `failedMatchupIds` being
non-empty is the real failure signal. The adapter MUST treat a non-empty
`failedMatchupIds` as outcome `partial` and surface it.

Documented error bodies, matched exactly in tests:

```
{"status":"failure","error":"No matchup identifiers were provided"}
{"status":"failure","error":"Matchup not found"}
{"status":"failure","error":"User not found"}
{"status":"failure","error":"Invalid Api Key."}
```

Type-specific endpoints also exist and SHOULD be preferred when the matchup type is
known, because their behavior is more predictable:

```
POST /api/rest/pool-tournament/user-score
POST /api/rest/recreational-games/user-score
POST /api/rest/pool-tournament/query      # search before you write
```

Since Sideout always knows it is writing to a tournament, the adapter MUST default to
`/pool-tournament/user-score` and expose the generic endpoint only behind an explicit
argument.

### 7.3 Matchup targeting, and why we are strict about it

Lucra can route a score by fuzzy metadata similarity. The documented scoring is:
`externalId` takes absolute precedence and is exact-match only; otherwise exact field
match scores 1.0, a partial string match 0.5, array intersection 0.7 × overlap, and a
nested object 0.8 × its nested score. Any record totalling at least 1.0 is returned,
and **the score is written to every matchup that matches and in which the user is a
participant.** Lucra's own example: three matchups tagged `season="2026-spring"` with
one player in all three results in that player's score being written to all three.

Therefore, hard rules for this codebase:

1. Every Lucra write MUST target either a concrete `matchupId` or a
   `matchupMetadata.externalId`. Never a loose metadata bag.
2. The adapter MUST reject, at the type level and at runtime, any score submission
   whose matchup targeting is neither `matchupId` nor an object whose only key is
   `externalId`. Throw before the network call.
3. `tournaments.lucra_external_id` MUST be globally unique and namespaced, format
   `sideout-{tournament_slug}-{match_id_short}`.
4. Before the first write to a new tournament, call `/pool-tournament/query` and assert
   exactly one matchup is returned. Log the count. If it is not 1, refuse to proceed
   and mark the tournament `awaiting_settlement` with a blocking organizer alert.

### 7.4 Settlement semantics

These differ by product type and the difference matters:

- **Tournaments have no auto-settlement.** They must always be closed manually by a
  game operator, regardless of `attemptFinished`. Our organizer console is therefore
  the settlement trigger, and the UI must make that explicit.
- **Recreational games** configured `track_results = AUTOMATED` close and distribute
  prizes automatically once every participant has submitted `attemptFinished: true`.
  Sideout does not use this path in v1, but the adapter must not assume it is absent.

`attemptFinished` also controls overwrite behavior: any submitted score overwrites the
prior score for that user unless `attemptFinished: true` was passed, the tournament is
closed, or the user paid for another attempt. Sideout submits `attemptFinished: true`
exactly once per team per match, at consensus, and never again.

### 7.5 Client SDK surface

Load the Lucra Web SDK client-side. It renders in an iframe and must be themed to
Sideout's palette via Lucra's web theming configuration. We launch Lucra flows for:

- authentication
- add funds / withdraw
- identity form for age and location compliance
- demographic collection for free-to-join tournaments
- rewards sheet

Error handling: the SDK surfaces a small sealed set of failures. Branch on the type,
never on message text, because wording changes between releases.

| Type | Meaning | Our handling |
|---|---|---|
| `UserStateError.NotInitialized` | SDK not ready or no signed-in user | gate on ready state, retry |
| `UserStateError.Unverified` | KYC incomplete | launch identity flow |
| `UserStateError.NotAllowed` | blocked or ineligible per backend rules | terminal, show messaging, no retry |
| `UserStateError.InsufficientFunds` | balance below stake | launch add-funds flow |
| `UserStateError.DemographicInformationMissing` | required fields absent | launch demographic form |
| `LocationError` | geolocation problem (GeoComply) | show location-help state, retry |
| `APIError` | auth, backend, network | retry with backoff, then surface |

Also note the SDK auto-enrolls authenticated users into all eligible free tournaments
by default, and that this call is **silently skipped** if any gate condition fails
(location permission missing, blocked user, flag off). Sideout MUST NOT rely on
auto-join for correctness. Always read back the participant list from Lucra and
reconcile against our own `teams` table; show the organizer any divergence.

### 7.6 Webhooks

Lucra publishes webhook subscriptions for tournaments, free-to-play, and convert-to-credit.
Implement a single receiver at `POST /api/webhooks/lucra` that:

1. Reads the raw body before any JSON parsing.
2. Verifies the signature. **OPEN:** the signature scheme is not specified in the public
   docs. Implement HMAC-SHA256 over the raw body with `LUCRA_WEBHOOK_SECRET` compared in
   constant time, keep it in one swappable function, and log a loud warning when
   `LUCRA_MODE !== 'mock'` and no secret is configured.
3. Deduplicates on `external_event_id`; a repeat returns 200 without reprocessing.
4. Persists to `webhook_events` before acting.
5. Processes in a transaction, writes `audit_log`, and always returns 2xx for
   well-formed events it chooses to ignore.

### 7.7 Legacy vs Forge

Lucra's public REST reference is marked legacy and superseded by a newer service called
**Forge**. This spec is written against the legacy documented shapes because those are
fully published. Isolate every endpoint path and payload shape in
`src/lucra/endpoints.ts` so migrating is a single-file change, and add the Forge
question to the open list.

---

## 8. The Lucra adapter and mock

`src/lucra/` contains:

```
endpoints.ts    # every path + version constant, no logic
types.ts        # zod schemas for requests and responses
client.ts       # real HTTP client, retry, timeout, redaction
mock.ts         # in-memory implementation of the documented surface
adapter.ts      # selects client vs mock from LUCRA_MODE; the only public export
matcher.ts      # port of Lucra's documented metadata similarity algorithm
```

### 8.1 Client requirements

- 5s connect / 10s total timeout. Three retries on 5xx and transport errors with
  exponential backoff and jitter. **Never retry a 4xx.**
- Parse every response through a zod schema. A shape mismatch is an error, not a
  silently-accepted unknown.
- Redact `X-Lucra-Api-Key` from every log line and from anything written to
  `lucra_score_submissions.request_json`.
- Persist an attempt row before the call and update it after, so a crashed process
  still leaves evidence.

### 8.2 Mock requirements

The mock must be faithful enough that swapping to sandbox surfaces no surprises. It MUST:

- Enforce the API key header and return the exact documented `"Invalid Api Key."` body.
- Return the exact documented error strings for missing identifiers, unknown matchup,
  and unknown user.
- Implement matchup resolution using `matcher.ts`, including the multiple-match
  behavior, so our strictness rules are actually exercised.
- Implement tournament semantics: no auto-settlement, manual close only.
- Implement recreational `AUTOMATED` auto-settlement, so the distinction is testable.
- Implement `attemptFinished` overwrite rules.
- Expose `GET /api/rest/_mock/state` for assertions. Available only in mock mode.
- Seed several deliberately overlapping matchups so a loose query would match more than
  one, proving rule 7.3.2 has teeth.

### 8.3 matcher.ts

Port the documented algorithm exactly: `externalId` absolute precedence; exact 1.0;
partial string 0.5; array intersection 0.7 × overlap; nested 0.8 × nested; threshold
at least 1.0.

While porting, note that the published worked examples are internally inconsistent with
the prose in at least two places — a documented "partial match" between strings that
are not substrings of one another, and a fully-equal array scored as 1.0 rather than
0.7. Implement two named interpretations, `literal` and `doc-examples`, expose the
active one in config, and write a test table that records which published examples
reproduce under each. Do not paper over the discrepancy; it is a genuine finding and the
tests are the place to state it.

---

## 9. Application API

All routes validate with zod, return `{ ok: true, data }` or
`{ ok: false, error: { code, message, detail? } }`, and never leak Lucra internals.

### Public
```
GET  /api/tournaments                      list, filterable by status
GET  /api/tournaments/:slug                detail incl. pools, bracket, standings
GET  /api/tournaments/:slug/standings       computed, cacheable 10s
GET  /api/tournaments/:slug/impact          donation totals, goal progress
GET  /api/matches/:id
```

### Player (authenticated)
```
POST /api/teams                            create team, invite partner
POST /api/teams/:id/join                   accept invite
POST /api/tournaments/:slug/register       register team, creates donation intent
POST /api/matches/:id/scores               submit a scoreline for your team
GET  /api/me                               profile, lucra link state, rewards
POST /api/me/lucra/link                    mint external_id, link on SDK sign-in
```

### Organizer (role-gated)
```
POST  /api/admin/tournaments               create
PATCH /api/admin/tournaments/:id           update, status transitions
POST  /api/admin/tournaments/:id/draw      generate pools + bracket
POST  /api/admin/tournaments/:id/close     close + trigger Lucra settlement
GET   /api/admin/disputes                  disputed matches queue
POST  /api/admin/matches/:id/resolve       organizer-authoritative scoreline
GET   /api/admin/lucra/submissions         audit view of every Lucra write
```

### Plumbing
```
POST /api/webhooks/lucra
GET  /health        # build sha, LUCRA_MODE, pinned SDK version, db migration state
```

---

## 10. Score consensus state machine

This is the heart of the build. Beach volleyball scores are self-reported from a phone
on the sand, so a single submitted number must never be trusted enough to move a prize.

States on `match_consensus.state`:

```
awaiting_first
  └─ first team submits ──► awaiting_second
                              ├─ second team submits identical hash ──► agreed
                              └─ second team submits different hash ──► disputed
disputed
  └─ organizer resolves ──► agreed   (records resolved_by_user_id)
agreed
  └─ submit to Lucra ──► submitting ──► accepted | partial | rejected
rejected / partial
  └─ organizer retries ──► submitting
```

Rules:

1. A scoreline is canonicalized (ordered sets, normalized team orientation) and hashed
   before comparison. Agreement is hash equality, not field-by-field prose comparison.
2. Both submissions must come from users on **different** teams. A single captain
   cannot satisfy both sides. Enforce in the query, not the UI.
3. Entering `agreed` mints exactly one `idempotency_key`. Every Lucra attempt for that
   match reuses it. Replays are therefore safe even though Lucra's documented API does
   not itself take an idempotency header — we use it as our own dedupe guard and
   include it in `metadata` for traceability. **OPEN:** whether Lucra supports a
   first-class idempotency key.
4. **Plausibility validation runs before Lucra is ever called.** Beach volleyball gives
   us real constraints: sets are to 21 (third set to 15), win by two, and a match is
   best-of-1 or best-of-3. A scoreline that is not a legal beach volleyball result is
   rejected at submission time with a specific message, not sent onward. No absurd
   integer ever reaches the settlement layer.
5. Only `agreed` may trigger a Lucra write. Assert this in code, not by convention.
6. Every transition writes `audit_log`.
7. Tournament close is blocked while any match is in `disputed`, `submitting`,
   `rejected`, or `partial`. The organizer console must show exactly what is blocking.

---

## 11. Screens and flows

Mobile-first at 390px, then 768px, then 1280px. Installable PWA with offline read of
the user's own pool and a queued score submission that syncs on reconnect — players are
on a beach with bad signal, and this detail is the difference between a demo and a
product.

### 11.1 Home
Live-first. If an event is in progress, the top of the screen is a live match strip with
scores ticking. Below: the featured event card, then upcoming events, then past events
with what each raised. Not a marketing hero. The app opens into the state of play.

### 11.2 Tournament detail
Sticky header with event name, beneficiary, status pill, and a countdown or live
indicator. Four tabs:

- **Overview** — format, division, courts, schedule, sponsors, the impact meter.
- **Bracket** — SVG bracket, pan and zoom on mobile, pinned current match, animated
  advancement lines. Pool play shown as pool tables before the bracket unlocks.
- **Standings** — per-pool tables with point differential tiebreaks, animated reorder.
- **Impact** — beneficiary story, amount raised vs goal, donor wall, sponsor tiers.

### 11.3 Match detail and score submission
The most important interaction. A bottom sheet, thumb-reachable, one set per row, large
stepper controls sized for sandy wet hands. As the user types, live validation shows
whether the scoreline is a legal beach volleyball result. On submit:

- If you are first, the state becomes "waiting on {opponent}" with a clear explanation
  that both teams must agree before results are final.
- If you are second and agree, a confirmation animation, then "final."
- If you are second and disagree, both scorelines are shown side by side with the
  differing set highlighted, and the match routes to the organizer with a neutral
  message. No blame language.

### 11.4 Team and registration
Create team, name it, invite a partner by phone. Registration collects the charitable
donation (stub provider) and, separately, launches the Lucra flow for tournament entry.
The two steps are visually distinct so a user never thinks their donation is a wager.

### 11.5 Profile
Identity/verification state as a calm status row, wallet chip, rewards earned,
tournament history, and responsible-play links. If Lucra reports `NotAllowed`, show a
plain terminal explanation with a support path and no retry button.

### 11.6 Organizer console
Denser, table-driven, still on the same design system. Event builder with a live draw
preview, a court-by-court live board, the dispute queue as the primary alert surface,
and a close-tournament flow that is an explicit two-step confirm showing the final
standings and projected payouts **frozen** before anyone commits. After the earlier work
on preview-then-commit surfaces, this is the pattern: nothing settles without a
reviewable frozen preview.

A `/admin/lucra` page lists every row of `lucra_score_submissions` with the exact
request and response. This page is the thing to open when an engineer asks how the
integration behaves.

---

## 12. Design system

The reference points are Offsuit and Five Iron Golf. What to take from each:

- **Offsuit** — restraint and legibility. Their stated position is that poker "doesn't
  have to look and feel like a scam," and the result is a calm dark interface, generous
  spacing, elegant stat display, and no casino ornamentation. Take the discipline.
- **Five Iron Golf** — urban sports energy. Near-black, bold type, a confident single
  accent, nightlife rather than country club. Take the attitude.

The synthesis: **premium dark sports-tech.** Confident, quiet, fast. It should feel
closer to a well-made trading or performance app than to a gaming skin.

### 12.1 Color

Dark-first. There is no light theme in v1; do not build a half-finished one.

```css
--bg-base:        #08090B;   /* app background */
--bg-raised:      #101216;   /* cards */
--bg-overlay:     #171A1F;   /* sheets, popovers */
--bg-inset:       #050607;   /* wells, inputs */

--border-subtle:  #22262D;
--border-strong:  #323843;

--text-primary:   #F4F5F7;
--text-secondary: #9BA3AF;
--text-tertiary:  #646C79;

--volt:           #D7FF3E;   /* primary action, brand */
--volt-dim:       #A8C82F;
--on-volt:        #08090B;

--ember:          #FF6B3D;   /* charity + impact only */
--surf:           #35D6C3;   /* live, positive delta, agreed */
--fault:          #FF4D4D;   /* errors, disputes */
```

Discipline rules:

- **One primary accent.** `--volt` is the only color used for primary actions. If two
  buttons on a screen are both volt, one of them is wrong.
- `--ember` is reserved exclusively for charity and impact figures. Never a button.
- `--surf` marks live state and agreement. Never decorative.
- Elevation on dark comes from **background lightness plus a hairline border**, not from
  drop shadows. Shadows are permitted only on overlays that genuinely float.
- Never use a color as the sole carrier of meaning; pair with an icon or label.

### 12.2 Typography

- **Display:** Archivo Expanded (variable), weights 600–800, uppercase for headings and
  scores, letter-spacing `-0.01em` to `-0.02em`. Broad, athletic, not condensed.
- **UI:** Instrument Sans (variable), 400/500/600.
- **Numerals:** always `font-variant-numeric: tabular-nums` on any score, timer,
  standing, or money figure so digits do not jitter as they change.

Scale, 1.25 ratio, clamped fluid:

```
display-xl  clamp(2.75rem, 6vw, 4.5rem)   /* live score */
display-l   clamp(2rem, 4vw, 3rem)        /* page titles */
heading     1.5rem / 600
subheading  1.125rem / 600
body        0.9375rem / 400  line-height 1.55
label       0.8125rem / 500  uppercase  tracking 0.06em
mono-stat   0.875rem tabular
```

Do not center long-form text. Do not set body copy below 15px.

### 12.3 Space, radius, layout

8px base grid, 4px half-step. Radii are deliberately restrained — oversized radii are
the single fastest way to look generated:

```
--r-xs: 4px    chips, badges
--r-sm: 6px    inputs, buttons
--r-md: 10px   cards
--r-lg: 14px   sheets, modals
--r-full: 999px  pills, avatars
```

Content max width 1280px, 16px gutters on mobile, 32px at desktop. Bottom tab bar on
mobile with safe-area insets; left rail at 1280px and up.

### 12.4 Motion

Motion must communicate state, never decorate.

```css
--ease-out-expo:  cubic-bezier(0.16, 1, 0.30, 1);
--ease-in-out-quart: cubic-bezier(0.76, 0, 0.24, 1);
--d-micro: 120ms;   /* hover, press */
--d-base:  220ms;   /* enter, exit */
--d-enter: 420ms;   /* sheets, page content */
--d-draw:  700ms;   /* bracket path */
```

Required named transitions:

1. **Score count-up** — digits roll to the new value over `--d-base`, tabular so width
   is stable.
2. **Leaderboard reorder** — a FLIP transition when standings change, with a brief
   `--surf` rank-delta flash. Write a ~40-line FLIP helper; do not add a dependency.
3. **Bracket advancement** — SVG `stroke-dashoffset` draw over `--d-draw` when a winner
   advances.
4. **Consensus confirm** — when the second team agrees, a single decisive check
   animation in `--surf`. One beat, not a celebration.
5. **Sheet** — translateY with `--ease-out-expo`, backdrop blur 8px and a fade.
6. **Live pulse** — 2s breathing dot on live indicators only.

All of it must be wrapped in `@media (prefers-reduced-motion: reduce)` and reduced to
opacity-only.

### 12.5 Component inventory

Build these as the vocabulary. No ad-hoc one-off styling in screens.

`AppShell` · `TabBar` · `NavRail` · `Button` (primary/secondary/ghost/danger) ·
`StatusPill` · `TournamentCard` · `LiveMatchStrip` · `ScoreDisplay` ·
`SetStepper` · `ScoreSubmitSheet` · `ConsensusBadge` · `Bracket` · `PoolTable` ·
`StandingsTable` · `ImpactMeter` · `DonorWall` · `SponsorRow` · `TeamAvatarPair` ·
`WalletChip` · `LucraGate` · `VerificationRow` · `DisputeCard` · `FrozenPreview` ·
`DataTable` · `EmptyState` · `Skeleton` · `Toast` · `ConfirmDialog`

`LucraGate` deserves care: it is the single wrapper that owns launching Lucra SDK flows
and mapping the sealed error types from 7.5 into UI states. No other component touches
the SDK.

### 12.6 Accessibility

WCAG AA contrast minimum, verified for `--volt` on `--bg-base` and for all text tiers.
Note that `--volt` requires `--on-volt` dark text; never white on volt. Full keyboard
operability including the bracket. Visible focus rings, 2px `--volt` at 2px offset.
Real semantic headings. `aria-live="polite"` for score and standings updates. Every
touch target at least 44×44px, and the set steppers larger than that.

---

## 13. Seed data

Seeds must make the app feel real on first run, and must exercise every state.

- Charity: one plausible beneficiary with a real mission sentence.
- **"Sandbar Classic"** — the flagship event. `status: live`, 24 teams, 6 pools of 4,
  pool play complete, quarterfinals in progress. Contains: two `final` matches, one
  `awaiting_scores`, one **`disputed`** so the organizer queue is populated on load,
  and one bye.
- A second event, `registration_open`, 40% full, so the registration flow is reachable.
- A third, `settled`, with awarded rewards and a completed impact total, so history and
  the rewards surface are populated.
- 48 users with varied `verification_state`, including one `not_allowed` and one
  `demographics_missing`, so those UI states are visible without contriving them.
- Three sponsors across tiers, donations summing to a partially-met goal.
- In the Lucra mock: matchups deliberately overlapping on loose metadata, so the
  strict-targeting assertion in 7.3.4 is exercised by the seed itself.

---

## 14. Anti-patterns — explicitly banned

This project is judged partly on not looking machine-generated. The following are
prohibited:

- Purple-to-blue or indigo-to-violet gradients anywhere.
- Emoji used as iconography. Use a single consistent icon set, 1.5px stroke.
- Glassmorphism as a general surface treatment. Backdrop blur is allowed only on the
  sheet backdrop.
- `rounded-2xl` / `rounded-3xl` applied uniformly to everything. Follow 12.3.
- A landing-page hero with a big centered headline and three equal feature cards below.
  The app opens into live state, not marketing.
- Stock component-library appearance. If a screen looks like untouched shadcn defaults,
  it is not done.
- Decorative full-bleed stock photography of beaches. One editorial event image maximum,
  and it must carry information.
- Fake data that does not add up. Impact totals must equal the sum of seeded donations;
  standings must follow from seeded match results. Every number on screen must be
  derived, never typed in.
- Multiple competing accent colors on one screen.
- Centered body paragraphs, or text below 15px in primary content.
- Skeleton loaders that do not match the shape of what loads.
- `console.log` left in shipped code, `any` in TypeScript, or an empty `catch`.

---

## 15. Acceptance criteria

The build is done when all of the following are demonstrably true.

**Runs clean**
1. `npm i && npm run seed && npm run dev` produces a working app with only
   `LUCRA_MODE=mock` configured.
2. `npm run typecheck` passes with strict mode and zero `any`.
3. `npm test` passes; matcher tests explicitly record which published Lucra examples
   reproduce under each interpretation.
4. `/health` reports build sha, `LUCRA_MODE`, pinned Lucra SDK version, migration state.

**Integration is correct**
5. Every Lucra write targets `matchupId` or a sole-key `externalId`; a unit test proves
   a loose-metadata write throws before any network call.
6. A replayed consensus reuses its `idempotency_key` and produces exactly one accepted
   Lucra submission row.
7. A tournament does not settle on `attemptFinished` alone; only an explicit organizer
   close settles it, and a test asserts this.
8. The recreational `AUTOMATED` auto-settlement path is implemented and tested, and is
   provably not on Sideout's tournament path.
9. Every documented Lucra error body is produced by the mock and handled distinctly.
10. `partial` outcomes (non-empty `failedMatchupIds` under `status: "success"`) are
    detected and surfaced, not swallowed.
11. Webhook replay with a duplicate event id returns 200 and does not double-process.
12. The BACKEND key never appears in any client bundle, response, or log. A test greps
    the built output.

**Domain is correct**
13. An illegal beach volleyball scoreline is rejected at submission with a specific
    message and never reaches the adapter.
14. Two submissions from the same team cannot satisfy consensus.
15. Mismatched scorelines produce a `disputed` match visible in the organizer queue,
    resolvable by an organizer, with the resolution attributed in `audit_log`.
16. Tournament close is blocked while any match is unresolved, and the blocker is named
    in the UI.
17. Donation and prize ledgers are separate; no query joins them.

**UI is correct**
18. Usable one-handed at 390px; score submission reachable by thumb.
19. All six named transitions from 12.4 are implemented and disabled under
    `prefers-reduced-motion`.
20. Standings reorder via FLIP, not a re-render jump.
21. AA contrast verified across all text tiers and on `--volt`.
22. Keyboard-navigable bracket.
23. Offline: a queued score submission survives reload and syncs on reconnect.
24. Nothing in section 14 appears anywhere.

**Two Playwright end-to-end flows**
25. Player: register team → view pool → submit score → opponent agrees → match final →
    standings update.
26. Organizer: open dispute → resolve → close tournament through the frozen preview →
    Lucra submission row recorded as accepted.

---

## 16. Build order

Ship in this sequence; each phase should end in a runnable app.

1. **Foundation** — Next.js, TS strict, Tailwind theme tokens from section 12, Drizzle
   schema and migrations, seed script, `/health`, `AppShell` and the design primitives.
   No Lucra yet.
2. **Domain** — tournaments, teams, pools, draw generation, bracket advancement,
   standings with tiebreaks. Pure logic, heavily unit-tested, no network.
3. **Consensus** — `score_submissions`, `match_consensus`, the state machine,
   plausibility validation, dispute queue. Still no Lucra.
4. **Lucra** — `matcher.ts` with its test table, the mock, the typed client, the
   adapter, strict targeting assertions, the webhook receiver, `/admin/lucra`.
5. **Polish** — the six transitions, PWA and offline queue, empty and error states,
   accessibility pass, Playwright flows, README with screenshots.

Do not start phase 4 before phase 3's tests pass. The value of this project is that the
trust boundary exists before the integration does.

---

## 17. Open questions

Do not guess at these. Implement the stated fallback, mark it clearly in code with an
`// OPEN:` comment, and collect them in `docs/open-questions.md`.

1. **Sandbox credentials.** Keys and `tenantId` are issued by a Lucra representative;
   there is no self-serve path. Fallback: `LUCRA_MODE=mock` with a faithful mock.
2. **Forge vs legacy REST.** The public reference is marked legacy and superseded.
   Which should a new integration target? Fallback: legacy shapes, isolated in
   `endpoints.ts`.
3. **Webhook signature scheme.** Not published. Fallback: HMAC-SHA256 over the raw body,
   isolated in one function.
4. **Idempotency.** Does Lucra support a first-class idempotency key on score writes?
   Fallback: our own key, enforced locally and echoed in `metadata`.
5. **GameId and LocationId registration** for an outdoor, non-fixed venue sport —
   beach volleyball courts are not permanent installations. How should `locationId` be
   modeled for a travelling event?
6. **Closing tournaments via API.** Docs say tournaments are closed manually by a game
   operator and reference both an API and a console. Is programmatic close supported for
   partners, or is the console authoritative?
7. **State coverage.** Lucra's own surfaces state 42 states, 43 states, and 44 states
   for different products. Which applies to a free-to-play tournament product, and what
   is the authoritative source to read at runtime?
8. **Charitable gaming interaction.** Where an entry fee is a charitable donation and
   prizes are sponsor-funded rewards, does any additional charitable-gaming regime apply
   on top of the skill-contest framework?
9. **Score attestation roadmap.** Lucra ingests a score it cannot independently verify.
   Is there any appetite for a partner-side attestation or dual-confirmation contract,
   of the kind implemented here in section 10?

---

## 18. README requirements

The repo README is part of the deliverable. It MUST contain, in this order:

1. One sentence on what Sideout is, and one screenshot of the live tournament screen.
2. A 60-second quickstart that works with no Lucra credentials.
3. An architecture diagram and the three hard rules from section 5.
4. A short, plainly-written section titled **"How scores become prizes"** explaining the
   consensus state machine and why a self-reported number is not trusted on its own.
5. The matcher interpretation table, stating honestly which published examples reproduce.
6. The open questions from section 17.
7. What is explicitly not built, from section 2, and the `FEATURE_REAL_MONEY` flag state.

Write it in first person, plainly, with no marketing voice. The README is the thing an
engineer reads first and it should sound like a person who built it.
