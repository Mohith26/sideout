# Open questions

Questions the build spec ([`build-spec.md`](./build-spec.md) §17) marks **OPEN**. None of
these are guessed at in code. Each one has a documented fallback that is implemented,
marked at the point of use with an `// OPEN:` comment, and listed here with the phase that
owns it. Later phases append to this file rather than resolving anything silently.

| # | Question | Fallback implemented | Owner phase | Code marker |
|---|---|---|---|---|
| 1 | **Sandbox credentials.** Keys and `tenantId` are issued by a Lucra representative; there is no self-serve path. | `LUCRA_MODE=mock` is the default and the only mode the app needs to boot. Sandbox/production modes require the credential env vars and fail fast at boot if they are missing. | 1 (env), 4 (mock) | `src/env.ts` |
| 2 | **Forge vs legacy REST.** The public reference is marked legacy and superseded by Forge. Which should a new integration target? | Legacy documented shapes, isolated in `src/lucra/endpoints.ts` so the migration is a single-file change. | 4 | `src/lucra/endpoints.ts` (phase 4) |
| 3 | **Webhook signature scheme.** Not published. | HMAC-SHA256 over the raw body with `LUCRA_WEBHOOK_SECRET`, constant-time compare, in one swappable function; loud warning when `LUCRA_MODE !== 'mock'` and no secret is configured. | 4 | `src/lucra/webhook-signature.ts` (phase 4) |
| 4 | **Idempotency.** Does Lucra support a first-class idempotency key on score writes? | Our own key, minted once when consensus reaches `agreed`, enforced locally as a dedupe guard and echoed in `metadata`. | 3 (mint), 4 (send) | `src/db/schema.ts` (`match_consensus.idempotency_key`) |
| 5 | **GameId and LocationId registration** for an outdoor, non-fixed venue sport. How should `locationId` be modeled for a travelling event? | `tournaments.lucra_location_id` is nullable and left `null`; `lucra_game_id` is the single constant `SIDEOUT_BEACH_2V2`. | 1 (schema), 4 (adapter) | `src/db/schema.ts` (`tournaments.lucra_location_id`), `src/seed/build.ts` (`LUCRA_GAME_ID`, `tournament()`) |
| 6 | **Closing tournaments via API.** Is programmatic close supported for partners, or is the console authoritative? | The organizer console is the settlement trigger; the adapter attempts the documented close call and surfaces a blocking alert if it is refused. | 4 | `src/lucra/adapter.ts` (phase 4) |
| 7 | **State coverage.** Lucra's own surfaces say 42, 43, and 44 states for different products. Which applies to a free-to-play tournament, and what is the runtime source of truth? | Never hardcoded in copy. Read from config at runtime; copy says "where Lucra is available" until the authoritative source is known. | 4/5 | `src/lucra/version.ts` (phase 4) |
| 8 | **Charitable gaming interaction.** Does a charitable-gaming regime apply on top of the skill-contest framework when entry fees are donations and prizes are sponsor-funded rewards? | No copy anywhere implies legal clearance. Donation and prize ledgers are separate tables with no foreign key between them. | 1 (schema), 5 (copy audit) | `src/db/schema.ts` (`donations`) |
| 9 | **Score attestation roadmap.** Is there appetite for a partner-side attestation or dual-confirmation contract of the kind implemented in §10? | The consensus state machine is built regardless; nothing in the Lucra write depends on Lucra acknowledging it. | 3 | `src/domain/scoreline.ts` (`canonicalizeScoreline`) |

## Phase 1 additions

- **Pinned Lucra SDK version.** `/health` must report the pinned Web SDK version, but no
  SDK package is installed until phase 4. `src/lucra/version.ts` holds the single constant
  and reports `"unpinned"` with an `// OPEN:` marker until the real pin lands.

## Phase 2 additions

| Question | Fallback implemented | Owner phase | Code marker |
|---|---|---|---|
| **SMS delivery provider.** The brief leaves Sideout's own sign-in unspecified and names no provider for delivering one-time codes or partner invites. | Codes and invites go through one `SmsSender` seam. Outside production the only implementation writes the message through `src/lib/log.ts` (the phone number masked, the code in clear so a developer can complete the flow) and the code is additionally returned by `POST /api/auth/request-code` as `devCode`. In production the log sender is not permitted — a live code in the hosting log would let anyone with log access take over the account — so `getSmsSender()` returns nothing: `POST /api/auth/request-code` answers `503 unavailable` with `detail.code = "sms_unavailable"` and issues no code, and the partner-invite text is skipped (the invite still waits under the partner's `GET /api/me`). A real provider implements `SmsSender` and is returned from `getSmsSender()`; callers do not change. | 2 (seam), later (provider) | `src/server/auth/sms.ts` |

## Follow-ups (not OPEN, just not built yet)

| Item | Status | Where |
|---|---|---|
| **Double elimination.** `double_elim` is in the `tournaments.format` enum (§6.2) but the phase-2 draw engine does not build it: `draw()` refuses it with `DrawError("unsupported_format")` and the route answers `409 conflict` with `detail.code = "unsupported_format"`. The bracket module (`advanceWinner`, `next_match_id`/`next_match_slot`) is shaped so a losers' bracket can hang off the same links. | Not built; refused honestly | `src/domain/draw.ts` (`draw`), `docs/build-spec.md` §6.2 |
| **Reopening registration.** The status machine is exactly the chain in the brief (`draft → registration_open → registration_closed → live → awaiting_settlement → settled`, `cancelled` from any pre-live state). There is no `registration_closed → registration_open` edge; add one in `src/domain/transitions.ts` if organizers need it. | Not built | `src/domain/transitions.ts` |
| **Closing and settlement edges.** `live → awaiting_settlement → settled` exist in the machine but `PATCH /api/admin/tournaments/:id` refuses them: they belong to the close flow with its blocking checks (§10.7), which is phase 4. | Phase 4 | `src/server/tournaments.ts` (`PATCHABLE_TARGETS`) |
| **Bracket seeding trigger.** For `pool_to_bracket`, round 1 is seeded from pool standings by `seedBracketFromPools` (`POST …/draw` with `{ stage: "bracket" }`), which applies the advancement rule stored on the tournament (`tournaments.draw_config_json`, written by the pools stage) rather than one resent by the caller. The consensus phase should call the same service when the last pool match finalizes so organizers do not have to. | Phase 3 wires the trigger | `src/server/draw.ts` |
| **Trusted proxy hops.** `POST /api/auth/request-code` and `/verify` key a per-address rate limit on `x-forwarded-for` only when `TRUSTED_PROXY_HOPS` says how many proxies vouch for it; a Next.js route handler has no socket address of its own, so with the default `0` only the per-phone and process-wide limits apply. Set it to the depth of the proxy chain on the public deployment. | Deployment setting | `src/env.ts`, `src/server/auth/rate-limit.ts` |
| **Lucra tournament entry at registration.** `registerTeam` calls `lucraEntryHook`, which returns `{ state: "not_available" }` rather than pretending to enrol anyone. | Phase 4 | `src/server/registration.ts` |

## Spec deviations

Places where the spec is followed in intent but not to the letter, each with the reason
the spec's "deviate only with a stated reason" rule asks for.

| Where | Spec says | Implemented | Reason |
|---|---|---|---|
| `--text-tertiary` in `src/styles/tokens.css` | `#646C79` (§12.1) | `#7C8491` | The spec value measures 3.76:1 on `--bg-base` and 3.29:1 on `--bg-overlay`, below the 4.5:1 that §12.6 and acceptance #21 require for every text tier. Lightened to the nearest value in the same hue that clears 4.5:1 on all four surfaces (4.62:1 on `--bg-overlay`); `src/styles/tokens.test.ts` asserts it. |
| `teams.status` in `src/db/schema.ts` | `enum(registered, checked_in, withdrawn)` (§6.1) | adds `forming` first | `POST /api/teams` (captain plus a pending partner invite) happens before `POST /api/tournaments/:slug/register` (both members in, donation intent created), and the spec's enum has no state for a team in between. `forming` teams never count toward capacity and are not listed publicly. Migration `0001` rebuilds the CHECK constraint. |
| `users.role` in `src/db/schema.ts` | not in §6.1 | `enum(player, organizer)`, default `player` | The organizer routes are "role-gated" (§9) and the spec's `users` table has no role. Lucra still owns wallet identity; this is only Sideout's thin account. Seeded organizers do not play. |
| `team_invites`, `auth_codes` tables | not in §6 | added in migration `0001` | Partner invites by phone (§11.4) and one-time sign-in codes need a home; neither is identity data (§4.6): an invite holds a phone, a code row holds only an HMAC. |
| `POST /api/admin/matches/:id/forfeit` | not in §9 | added | Confirmed by the task's build instructions, which asked for an organizer forfeit path that the organizer console (phase 2b) drives. It is the only route that resolves a match in phase 2 and it never sets `final`. |
| `POST /api/auth/request-code`, `POST /api/auth/verify`, `POST /api/auth/logout`, `POST /api/dev/login` | not in §9 | added | The spec leaves Sideout's own session unspecified. Phone + one-time code is the minimum that fits the invite-by-phone flow; the dev login exists only outside production or with `SIDEOUT_DEV_LOGIN=true` (a page-extension gate, asserted by `npm run test:bundle`). |
| Seed users | 48 (§13) | 48 players + 2 organizers | Organizer accounts are needed to exercise `/api/admin/*`; they hold no Lucra link and no team, so the 48-player, every-verification-state requirement is untouched. |
