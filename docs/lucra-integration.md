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
is read back to learn Lucra user ids, and `POST /pool-tournament/:matchupId/complete`
is sent with the frozen preview's rewards as a per-player `paymentStructure`. Success
is `awaiting_settlement → settled` and `rewards.projected → awarded`; a refusal leaves
the tournament where it is with the alert on `/admin/lucra`, where "Settle again"
re-runs it. The mock emits `TournamentCompleted`, which the app's own receiver
processes in-process, so the webhook path runs on every close in mock mode.

## Strictness rules, and where each is enforced

| Rule | Where | Test |
|---|---|---|
| A write targets `matchupId` or a metadata object whose only key is `externalId` (7.3.1, 7.3.2) | `StrictMatchupTarget` (type) and `assertStrictTarget` (zod `.strict()`) in `src/lucra/adapter.ts`, before any request object exists | `adapter.test.ts` spies on fetch: zero calls |
| `tournaments.lucra_external_id` is globally unique and namespaced (7.3.3) | unique index; `sideout-{slug}-{short id}` from the seed and `createTournament` | schema, seed tests |
| Before the first write to a tournament, `/pool-tournament/query` must return exactly one matchup (7.3.4) | `ensureMatchupTarget` in `src/server/lucra.ts`: caches `lucra_matchup_id` + `lucra_matchup_verified_at`; on a count other than one raises a blocking `LucraAlert`, moves a live tournament to `awaiting_settlement` and refuses the write (the organizer's "Verify targeting" thaws it to `live`, or the close runs from the frozen state); a query that did not answer leaves the consensus `agreed` under a non-blocking alert | `lucra.test.ts` (duplicate matchup in the mock; 503 on the query) |
| The type-specific endpoint is the default; the generic one only behind `endpoint: "generic"` (7.2) | `adapter.submitScores` | `adapter.test.ts` |
| Non-empty `failedMatchupIds` under `status: "success"` is `partial` (7.2) | `classifyWrite` in `src/lucra/adapter.ts` | `adapter.test.ts`, `lucra.test.ts` |
| 4xx is never retried; 5xx and transport errors are, three times with jittered backoff; 5s to headers, 10s total (8.1) | `src/lucra/client.ts` | `client.test.ts` with a scripted fake server |
| Every response parses through zod; a mismatch is an error (8.1) | `LucraClient.call` | `client.test.ts` |
| `X-Lucra-Api-Key` never appears in a log line or a stored request (8.1) | redaction in `client.ts`; the key string is also scrubbed from response text | `client.test.ts`, `lucra.test.ts` |
| An attempt row exists before the call and is updated after (8.1) | `submitConsensusScores` step 4 and 6 | `lucra.test.ts` |
| Only `src/lucra/adapter.ts` makes outbound Lucra calls (§5) | ESLint `no-restricted-imports` on `**/lucra/client`, `**/lucra/mock` and `no-restricted-syntax` on `fetch("…lucrasports.com…")` outside `src/lucra/` | `import-boundary.test.ts` runs ESLint over fixtures |
| The BACKEND key and the webhook secret reach no client bundle; the mock route is absent from a non-mock build (§5, acceptance 12) | `npm run test:bundle` builds in sandbox mode with sentinels | CI |

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
is persisted.

## Not built here (phase 4b and later)

The browser SDK (`lucra-web-sdk` v1.12.0, GitHub-only), `LucraGate`, the SDK-launched
identity, wallet and demographic flows, the registration entry step's join button, the
profile's Lucra rows and the rewards sheet. `POST /api/me/lucra/link` and
`GET /api/admin/tournaments/:id/lucra/participants` are the server halves those build on.
Real-money head-to-head stays behind `FEATURE_REAL_MONEY=false`.
