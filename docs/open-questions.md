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
| 5 | **GameId and LocationId registration** for an outdoor, non-fixed venue sport. How should `locationId` be modeled for a travelling event? | `tournaments.lucra_location_id` is nullable and left `null`; `lucra_game_id` is the single constant `SIDEOUT_BEACH_2V2`. | 1 (schema), 4 (adapter) | `src/db/schema.ts`, `src/seed/build.ts` |
| 6 | **Closing tournaments via API.** Is programmatic close supported for partners, or is the console authoritative? | The organizer console is the settlement trigger; the adapter attempts the documented close call and surfaces a blocking alert if it is refused. | 4 | `src/lucra/adapter.ts` (phase 4) |
| 7 | **State coverage.** Lucra's own surfaces say 42, 43, and 44 states for different products. Which applies to a free-to-play tournament, and what is the runtime source of truth? | Never hardcoded in copy. Read from config at runtime; copy says "where Lucra is available" until the authoritative source is known. | 4/5 | `src/lucra/version.ts` (phase 4) |
| 8 | **Charitable gaming interaction.** Does a charitable-gaming regime apply on top of the skill-contest framework when entry fees are donations and prizes are sponsor-funded rewards? | No copy anywhere implies legal clearance. Donation and prize ledgers are separate tables with no foreign key between them. | 1 (schema), 5 (copy audit) | `src/db/schema.ts` (`donations`, `rewards`, `sponsors`) |
| 9 | **Score attestation roadmap.** Is there appetite for a partner-side attestation or dual-confirmation contract of the kind implemented in §10? | The consensus state machine is built regardless; nothing in the Lucra write depends on Lucra acknowledging it. | 3 | `src/domain/scoreline.ts` (canonical hash, phase 1) |

## Phase 1 additions

- **Pinned Lucra SDK version.** `/health` must report the pinned Web SDK version, but no
  SDK package is installed until phase 4. `src/lucra/version.ts` holds the single constant
  and reports `"unpinned"` with an `// OPEN:` marker until the real pin lands.
