# Lucra integration

How a score that two phones agreed on becomes a write to Lucra, and how a tournament
becomes a settled one. Spec: [`build-spec.md`](./build-spec.md) §5, §7, §8, §10. Every
Lucra fact below was read from `docs.lucrasports.com` (the legacy REST reference, the
per-page markdown); where the documentation is silent or contradicts itself the row in
[`open-questions.md`](./open-questions.md) says what was implemented instead.

## The write path

```
 phone A ──┐                                                   ┌── Lucra (mock | sandbox | production)
           │  POST /api/matches/:id/scores                     │
 phone B ──┴──► consensus (src/server/consensus.ts)            │
                 legality → canonical form → sha256 → agreed   │
                 mints idempotency_key once                    │
                   │ transaction commits                       │
                   ▼                                           │
            src/server/lucra.ts  submitConsensusScores         │
             1. assertMayWriteToLucra   (only `agreed`)        │
             2. ensureMatchupTarget     (7.3.4, once per event)│─── POST /pool-tournament/query
             3. build the request       (src/domain/lucra-score.ts)
             4. persist attempt row     (outcome = pending) + consensus → submitting
             5. adapter.submitScores    (src/lucra/adapter.ts)  │─── POST /pool-tournament/user-score × players
             6. update the row          (exact calls + responses, key redacted)
             7. consensus → accepted | partial | rejected, audit rows
                   │
                   ▼
            /admin/lucra  ·  GET /api/admin/lucra/submissions
```

The consensus machine (§10) is the trust boundary: nothing reaches step 1 unless both
teams' scorelines hashed equal, or an organizer resolved a dispute. The Lucra layer
never reads a scoreline from a request; it reads the agreed `sets` rows.

Retries: `rejected | partial → submitting` is the organizer's
`POST /api/admin/matches/:id/lucra/retry`, which passes `assertMayRetryLucraWrite`
(never the first-write gate) and sends the same request under the same
`idempotency_key` as the next `attempt`. A second write after `accepted` is refused
before a request exists, so `attemptFinished: true` leaves once per team per match.

A process that dies between step 4 and step 6 leaves the consensus `submitting`:
`sweepStaleSubmissions` (first use of the Lucra layer in a process, and before every
settlement) closes a `pending` row older than `STALE_SUBMISSION_MS` out as
`transport_error`/`rejected`, so the organizer's retry applies.

Settlement: tournaments never settle on their own. The organizer's two-step close
(`POST /api/admin/tournaments/:id/close`) commits `live → awaiting_settlement`, then
`lucraSettlementHook` runs `settleTournament`: stale attempts are swept, any consensus
still `agreed` is written,
anything not `accepted` refuses settlement with a blocking alert, the participant list
is read back to learn Lucra user ids — and, if that read shows the matchup already
`CLOSED` (a complete whose response was lost, or a close from Lucra's console), that is
the settlement, recorded with the read-back reward structure and never repeated — then
`POST /pool-tournament/:matchupId/complete` is sent with the frozen preview's rewards
as a per-player `paymentStructure`; a complete refused as already closed is read back
once more before the refusal is believed. Success
is `awaiting_settlement → settled` and `rewards.projected → awarded`; a refusal leaves
the tournament where it is with the alert on `/admin/lucra`, where "Settle again"
re-runs it. The mock emits `TournamentCompleted`, which the app's own receiver
processes in-process, so the webhook path runs on every close in mock mode.

## Strictness rules, and where each is enforced

| Rule | Where | Test |
|---|---|---|
| A write targets `matchupId` or a metadata object whose only key is `externalId` (7.3.1, 7.3.2) | `StrictMatchupTarget` (type) and `assertStrictTarget` (zod `.strict()`) in `src/lucra/adapter.ts`, before any request object exists | `adapter.test.ts` spies on fetch: zero calls |
| `tournaments.lucra_external_id` is globally unique and namespaced (7.3.3) | unique index; `sideout-{slug}-{short id}` from the seed and `createTournament` | schema, seed tests |
| Before the first write to a tournament, `/pool-tournament/query` must return exactly one matchup (7.3.4) | `ensureMatchupTarget` in `src/server/lucra.ts`: caches `lucra_matchup_id` + `lucra_matchup_verified_at`; on a count other than one raises a blocking `LucraAlert`, moves a live tournament to `awaiting_settlement` and refuses the write (the organizer's "Verify targeting" thaws it to `live`, or the organizer forfeits the remaining matches and the close runs from the frozen state); a query that did not answer leaves the consensus `agreed` under a non-blocking alert | `lucra.test.ts` (duplicate matchup in the mock; 503 on the query) |
| The type-specific endpoint is the default; the generic one only behind `endpoint: "generic"` (7.2) | `adapter.submitScores` | `adapter.test.ts` |
| Non-empty `failedMatchupIds` under `status: "success"` is `partial` (7.2) | `classifyWrite` in `src/lucra/adapter.ts` | `adapter.test.ts`, `lucra.test.ts` |
| 4xx is never retried; 5xx and transport errors are, three times with jittered backoff; 5s to headers, 10s total (8.1) | `src/lucra/client.ts` | `client.test.ts` with a scripted fake server |
| Every response parses through zod; a mismatch is an error (8.1) | `LucraClient.call` | `client.test.ts` |
| `X-Lucra-Api-Key` never appears in a log line or a stored request (8.1) | redaction in `client.ts`; the key string is also scrubbed from response text | `client.test.ts`, `lucra.test.ts` |
| An attempt row exists before the call and is updated after (8.1) | `submitConsensusScores` step 4 and 6 | `lucra.test.ts` |
| Only `src/lucra/adapter.ts` makes outbound Lucra calls (§5) | ESLint `no-restricted-imports` on `**/lucra/client`, `**/lucra/mock` and `no-restricted-syntax` on `fetch("…lucrasports.com…")` outside `src/lucra/` | `import-boundary.test.ts` runs ESLint over fixtures |
| The BACKEND key and the webhook secret reach no client bundle; the mock routes are absent from a non-mock build (§5, acceptance 12) | `npm run test:bundle` builds in sandbox mode with sentinels | CI |
| Only `src/components/lucra/LucraGate.tsx` loads the Web SDK or its stand-in; a sandbox build ships the real SDK and none of the stand-in (§7.5, §12.5) | ESLint `no-restricted-imports` on `lucra-web-sdk` and `**/lucra/sdk-mock` everywhere but the gate (and its test helper); `LucraGate` branches on the inlined `NEXT_PUBLIC_LUCRA_MODE` | `import-boundary.test.ts`; `npm run test:bundle` scans for the SDK's iframe id and the stand-in's sheet marker |
| Every SDK failure is branched on by class and code, never by message (§7.5) | `classifySdkFailure` in `src/lucra/sdk-surface.ts` | `sdk-surface.test.ts` (an impostor class with a matching code is not trusted), `LucraGate.test.tsx` |
| A Lucra user id is recorded on a link only from Lucra's side (§4.6, §7.5) | `bindLucraAccount` in `src/server/lucra.ts`: the mock's account or the participant read-back; the client's id is a hint that is checked | `src/app/api/lucra-sdk.test.ts` |

## What is sent

One `POST /api/rest/pool-tournament/user-score` per player (the type-specific endpoint
takes a single `userScore`; the generic and recreational endpoints take an array):

```json
{
  "object": {
    "matchupMetadata": { "externalId": "sideout-sandbar-classic-2026-019fd83b" },
    "gameId": "SIDEOUT_BEACH_2V2",
    "userScore": {
      "userMetadata": { "externalId": "sideout-user-019f220e" },
      "score": 42,
      "attemptFinished": true,
      "metadata": {
        "sets": "21-18,21-16",
        "match_id": "01a0b611-…",
        "idempotency_key": "01a0b6ed-…",
        "team_id": "01a0b508-…",
        "won": true,
        "round": 2,
        "tournament": "sandbar-classic-2026"
      }
    }
  }
}
```

`score` is the points the player's team won across the agreed sets; the scoreline is
carried from that team's side in `metadata.sets`. Players are identified only by the
opaque `lucra_links.external_id` (minted by `POST /api/me/lucra/link`), never by phone
or email. `locationId` is omitted while `tournaments.lucra_location_id` is null (§17.5).

## The mock

`LUCRA_MODE=mock` runs the same `LucraClient` against an in-process implementation of
the documented surface (`src/lucra/mock.ts`): the API key header is enforced with the
exact `"Invalid Api Key."` body; the three documented identifier errors are returned
byte for byte; matchups and users resolve through the ported matcher, including the
multiple-match behaviour; tournaments close only through the complete call;
recreational `AUTOMATED` games settle once every participant has `attemptFinished: true`
(and cannot be reached through the tournament endpoint). `GET /api/rest/_mock/state`
(organizer-gated, mock builds only) shows its world.

At boot the mock is rebuilt from the database: one matchup per tournament targeted by
its `externalId`, every linked player as a Lucra user, three deliberately overlapping
matchups sharing `season` and `venue` with one player in all of them, two recreational
games, and every accepted attempt row replayed so the leaderboard agrees with what the
database says was written.

## The matcher finding

`src/lucra/matcher.ts` ports the documented similarity algorithm. Two of the published
worked examples contradict the prose: a fully-equal array is scored 1 (the prose gives
0.7 × overlap = 0.7, under the threshold), and `"summer-league"` vs
`"summer-tournament"` is called a 0.5 partial match though neither contains the other.
`LUCRA_MATCHER_INTERPRETATION=literal` (default) follows the prose;
`doc-examples` follows the examples (set-equal arrays are exact; strings sharing a whole
token are partial). `src/lucra/matcher.test.ts` is the table of which examples
reproduce under which reading; `/health` reports the active one. Sideout only ever
targets by `externalId`, which both readings resolve identically.

## Webhooks

`POST /api/webhooks/lucra` reads the raw body first (capped at 256 KB), verifies
`X-Lucra-Signature: sha256=<hex>` (HMAC-SHA256 over the raw bytes, constant-time
compare, one swappable function in `src/lucra/webhook-signature.ts`), derives a stable
event id (no published payload carries one), deduplicates on it, persists to
`webhook_events`, then processes in one transaction with audit rows. Handled:
`TournamentCompleted` (confirms a settled tournament, raises a blocking alert on any
other — it never settles, awards or changes a status; the organizer's close is the
only settlement trigger), `TournamentCanceled` (alert), `TournamentUserJoined` and
`UserSignedUp` (record the Lucra user id on the matching link), `UserKYCVerified`
(`verification_state` only — never identity data). Everything else well-formed is
`ignored` with a 2xx. An invalid signature is refused with 401 and nothing about it
is persisted. The secret is `LUCRA_WEBHOOK_SECRET`; in mock mode outside production a
random per-process secret shared by the in-process mock signer and the receiver stands
in, and in production there is no fallback in any mode (boot warns, every delivery is
refused until the secret is configured).

## The browser

Spec §7.5 and §12.5: the Lucra Web SDK runs client-side, Sideout launches Lucra's
flows and never reimplements them, and one component owns the SDK.

**Loading.** `lucra-web-sdk` is installed from the GitHub release tag
(`package.json`: `github:Lucra-Sports/lucra-web-sdk#v1.12.0`; the lockfile pins the
commit, fetched as a tarball over https, so `npm ci` needs no SSH). The pin is
repeated in `src/lucra/version.ts` for `/health`, which also reports the version read
from the installed manifest at build time (`lucraSdk.installed`); `version.test.ts`
keeps the three in step. Only `src/components/lucra/LucraGate.tsx` imports the
package, through a dynamic `import()` on the client, initialized with the WEB key and
tenant id from `src/env.public.ts` (`NEXT_PUBLIC_LUCRA_WEB_API_KEY`,
`NEXT_PUBLIC_LUCRA_TENANT_ID`), `env` from the mode, and `autoJoin: false`. ESLint
refuses `lucra-web-sdk` and `@/lucra/sdk-mock` everywhere else
(`src/lucra/import-boundary.test.ts`), and `npm run test:bundle` proves over a sandbox
build that the real SDK is in the client output and the stand-in is not.

**Mode.** `NEXT_PUBLIC_LUCRA_MODE` is derived from `LUCRA_MODE` by `next.config.ts` and
inlined, so `LucraGate` branches at build time: `mock` loads `src/lucra/sdk-mock.ts`,
anything else the real package. `src/env.ts` refuses to boot when the two disagree. A
live mode with no WEB credentials renders the gate's `unconfigured` state (the profile
and the entry step say so) rather than initializing with half a pair.

**Theming.** Lucra's Web Theming Guide publishes ten options (colors in HSL) configured
on the tenant — the SDK has no runtime theme API. `src/lucra/theme.ts` computes them
from `src/styles/tokens.css` (`primary` = volt, `on-primary` = on-volt, `secondary` =
the overlay surface, no imagery; `theme.test.ts` pins every source hex to the CSS) and
`/admin/lucra` shows them for handing to the Lucra representative. The mock stand-in
renders on the same tokens, which is what the themed iframe looks like once applied.

**`LucraGate` and `useLucra()`.** The gate mounts a host element, opens the SDK into
it hidden (`client.open(host, undefined, { hidden: true }).home()`), waits on
`client.ready`, and exposes `status`, `user` (the SDK's session: balance and account
status, never persisted), `launch(flow)` for `auth` (Lucra's login screen on the host,
awaited until `loginSuccess`), `identity` (`dialog().kyc()` until `kycComplete`),
`demographics` (`dialog().demographic()` until `demographicComplete`), `addFunds`,
`withdraw`, `wallet`, `profile`, `location` (`dialog().locationGrant()` until
`locationGranted`) and `rewards` (see the open question), plus `joinTournament(matchupId)`
(`client.api.joinTournament`). Every rejection goes through `classifySdkFailure` in
`src/lucra/sdk-surface.ts`, which branches on `instanceof` the loaded module's classes
and on `LucraApiError.code` — never on message text — into the states the spec table
names:

| Spec (§7.5) | Web SDK 1.12.0 | Gate |
|---|---|---|
| `NotInitialized` | `LucraUserNotLoggedIn`, or `ready` rejecting with `{ success: false }` | gate on ready; one automatic re-initialization; `retry()`; a user-scoped flow signs in first |
| `Unverified` | `LucraApiErrorCode.unverified` | launch identity, retry the call once |
| `NotAllowed` | `SDKLucraUser.accountStatus` in `BLOCKED`/`SUSPENDED`/`CLOSED`/`CLOSED_PENDING`/`HIDDEN` (the web SDK has no code for it; a blocked account fails with the catch-all) | terminal: messaging, `LUCRA_SUPPORT_URL`, no retry |
| `InsufficientFunds` | `insufficientFunds` | launch add funds, retry once |
| `DemographicInformationMissing` | `demographicInformationMissing` | launch the demographic form, retry once |
| `LocationError` | `locationError`; `locationNeeded` when Lucra has no location yet | location-help state and retry; the grant page first for `locationNeeded` |
| `APIError` | `apiError`, the SDK's plain-string rejections (`"Timeout"`) | three tries with backoff, then surfaced |

`src/components/lucra/LucraFailureNotice.tsx` is the one rendering of that table's
right-hand column. `LucraGate.test.tsx` drives every row through a scripted module
that throws the stand-in's classes.

**Sign-in binding.** On `loginSuccess` (and on a session the SDK restores) the gate
mints the link (`POST /api/me/lucra/link`), sends the documented user link
(`client.sendMessage.userUpdated({ metadata: { externalId } })`) and calls
`POST /api/me/lucra/bind`. The server records a Lucra user id only when Lucra's side
vouches for it: in mock mode the in-process Lucra's account for the phone, otherwise
the participant read-back of every verified matchup the player has a registered team
in, matched on the echoed `externalId`; the SDK's `user.id` is a hint that is checked
and refused when it disagrees. When nothing vouches yet the answer is
`bound: false, reason: "not_visible_yet"` and the `UserSignedUp` /
`TournamentUserJoined` webhooks or the pre-settlement read-back record it later.

**Registration step 2.** `/t/[slug]/register` renders `LucraEntryStep` inside a
`LucraGate` once the team is registered. The server computes `lucraEntryStatus`: the
§7.3.4-verified matchup (running the assertion when it is not cached; a count other
than one raises the organizer's alert without freezing anything, since this is a
read) and, from `GET /pool-tournament/:matchupId`, who on the roster Lucra lists. The
one volt action runs `joinTournament(matchupId)` (signing in first if needed), then
re-reads `GET /api/tournaments/:slug/lucra/entry` on a short schedule — Lucra's
enrolment is asynchronous — and shows exactly what the read-back says. Auto-join is
off and never relied on; the organizer's reconciliation (`/organizer/events/[id]/lucra`,
`GET /api/admin/tournaments/:id/lucra/participants`, a "Re-check" action) is the proof.

**Profile.** `VerificationRow` renders `lucra_links.verification_state`, refined by
the SDK's live `accountStatus` (a blocked account is `not_allowed`, a verified one
`verified`); `unverified` launches identity, `demographics_missing` the form,
`not_allowed` is the terminal row. `WalletChip` shows the SDK's balance with
`ResponsiblePlayLinks` directly beneath it (`LUCRA_RESPONSIBLE_GAMING_URL`,
`LUCRA_SELF_LIMIT_URL`, and Lucra's own profile flow for limits when signed in), a
sign-in affordance otherwise; add funds and withdraw are offered only behind
`FEATURE_REAL_MONEY`. `RewardsAction` opens the rewards sheet.

**The stand-in (`LUCRA_MODE=mock`).** `src/lucra/sdk-mock.ts` exports the same
surface as the package — `LucraClient.initialize/getInstance/destroy`, `ready`,
`user`, `open().home()/login()`, `dialog().<route>()` returning a `LucraDialog`,
`on/off`, `api.joinTournament`, `sendMessage.userUpdated` — and the same error classes
with the same codes. Where the SDK mounts Lucra's iframe, it mounts a small sheet on
the design tokens into the same host and resolves each flow against the server-side
mock through `POST /api/rest/_mock/sdk` (`route.mock.ts`; absent from any non-mock
build; every action scoped to the signed-in Sideout account, which stands in for
Lucra's session; `src/server/lucra-sdk-mock.ts`). Outcomes are deterministic per
seeded account: `verified` → `VERIFIED`, `not_allowed` → `BLOCKED`,
`demographics_missing` → the form is outstanding, `unverified` → the identity flow
verifies. Every change travels the production path: the mock emits its signed
`UserSignedUp`, `UserKYCVerified`, `FundsDeposited` and `TournamentUserJoined`
webhooks and the receiver updates the rows before the route answers — which is why a
production build in mock mode needs `LUCRA_WEBHOOK_SECRET` set for those changes to
land (`playwright.config.ts` sets one). The mock session and the location grant live
in `localStorage`, like the iframe's own state.

## Not built here (later)

Real-money head-to-head stays behind `FEATURE_REAL_MONEY=false`: the add-funds and
withdraw launches exist in `LucraGate` and the wallet chip offers them only when the
flag is on. The six named transitions' polish, PWA/offline, the two Playwright flows
of §15 and the README are the polish phase.
