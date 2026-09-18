/**
 * Every Lucra path, header and version constant, and nothing else (spec §8).
 *
 * OPEN: (§17.2) Lucra's public REST reference is marked legacy and superseded
 * by Forge (`https://forge.sandbox.lucrasports.com/docs/`), whose surface is
 * only published behind the interactive docs. Everything here is the legacy
 * documented shape; when Forge is confirmed as the target, this file — and the
 * request/response schemas in `types.ts` it names — is the migration.
 *
 * Sources (per-page markdown at docs.lucrasports.com, `.md` appended):
 *   legacy/1.0_api_setup, legacy/3.0_tournaments_rest_api,
 *   legacy/3.2_tournaments_metadata_matching, legacy/4.2_gyp_metadata_matching,
 *   legacy/7.0_user_score_by_metadata, legacy/2.0_webhook_setup,
 *   server-to-server/webhook-subscriptions/request-verification.
 */

/** Documented "Last Updated 2026-03-03, Version 1.1" on the score ingestion pages. */
export const LUCRA_API_VERSION = "legacy-rest/1.1" as const;

/** The BACKEND key travels in this header and nowhere else (never a query parameter). */
export const LUCRA_API_KEY_HEADER = "X-Lucra-Api-Key" as const;
/** What replaces the key in every log line and persisted request. */
export const REDACTED = "[redacted]" as const;

/** `sha256=<hex>` HMAC of the raw webhook body. */
export const LUCRA_SIGNATURE_HEADER = "X-Lucra-Signature" as const;
export const LUCRA_SIGNATURE_PREFIX = "sha256=" as const;

/** Path templates. `:matchupId` is filled by the client; the strings themselves never change shape. */
export const LUCRA_PATHS = {
  /** Type-specific score write, one `userScore` per call. The adapter's default. */
  poolTournamentUserScore: "/api/rest/pool-tournament/user-score",
  /** Search before you write: matchups by strict or loose criteria. */
  poolTournamentQuery: "/api/rest/pool-tournament/query",
  /** Participants and standings of one tournament. */
  poolTournamentGet: "/api/rest/pool-tournament/:matchupId",
  /** Manual close with the final payment structure. Tournaments never auto-settle. */
  poolTournamentComplete: "/api/rest/pool-tournament/:matchupId/complete",
  /** Recreational games take an array and may auto-settle; not on Sideout's path. */
  recreationalUserScore: "/api/rest/recreational-games/user-score",
  /** Type-agnostic write with `userScores[]`; only behind an explicit argument. */
  genericUserScore: "/api/rest/user-score",
  /** Mock-only inspection route, absent from any non-mock build. */
  mockState: "/api/rest/_mock/state",
} as const;

/** Webhook event names as Lucra publishes them (legacy/2.0_webhook_setup). */
export const LUCRA_WEBHOOK_EVENTS = {
  tournamentCreated: "TournamentCreated",
  tournamentEdited: "TournamentEdited",
  tournamentUserJoined: "TournamentUserJoined",
  tournamentCanceled: "TournamentCanceled",
  tournamentCompleted: "TournamentCompleted",
  userSignedUp: "UserSignedUp",
  userKycVerified: "UserKYCVerified",
  fundsDeposited: "FundsDeposited",
} as const;

/** The exact error strings the documentation publishes, matched byte for byte. */
export const LUCRA_ERROR_BODIES = {
  invalidApiKey: "Invalid Api Key.",
  noMatchupIdentifiers: "No matchup identifiers were provided",
  matchupNotFound: "Matchup not found",
  userNotFound: "User not found",
} as const;
