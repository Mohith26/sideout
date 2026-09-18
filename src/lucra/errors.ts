import type { CallRecord } from "@/lucra/types";
import { LUCRA_ERROR_BODIES } from "@/lucra/endpoints";

/**
 * The sealed set of ways a Lucra call can fail. The rest of the app branches
 * on `code`, never on message text (the same rule spec §7.5 sets for the SDK).
 *
 * - `invalid_api_key`, `no_matchup_identifiers`, `matchup_not_found`,
 *   `user_not_found` are the four documented failure bodies, matched exactly.
 * - `validation` is any other documented-format `{ status: "failure" }` 4xx.
 * - `http` is a 4xx without a parseable failure body; `server` a 5xx that
 *   survived every retry; `transport` a network failure or timeout.
 * - `shape` is a 2xx whose body did not match the schema: an error, not a
 *   silently accepted unknown (spec §8.1).
 * - `not_participant` is a 2xx that affected no matchup at all: Lucra found
 *   the matchup but the user is not in it (§7.5: never rely on auto-join).
 * - `strict_targeting` and `ambiguous_matchup` are ours: rule 7.3.2 and 7.3.4.
 * - `unlinked_user` is ours: a player with no Lucra link cannot be scored.
 */
export const LUCRA_ERROR_CODES = [
  "invalid_api_key",
  "no_matchup_identifiers",
  "matchup_not_found",
  "user_not_found",
  "validation",
  "http",
  "server",
  "transport",
  "shape",
  "not_participant",
  "strict_targeting",
  "ambiguous_matchup",
  "unlinked_user",
] as const;
export type LucraErrorCode = (typeof LUCRA_ERROR_CODES)[number];

/** Failures that may be retried by an organizer (`rejected`/`partial → submitting`) with the same key. */
export const RETRYABLE_LUCRA_ERROR_CODES: ReadonlySet<LucraErrorCode> = new Set(["matchup_not_found", "user_not_found", "not_participant", "server", "transport", "shape", "http"]);

export class LucraError extends Error {
  constructor(
    readonly code: LucraErrorCode,
    message: string,
    readonly detail: {
      httpStatus?: number | null;
      /** The response body as received (already free of any key; requests are redacted before they are kept). */
      body?: unknown;
      path?: string;
      /** How many tries the client made before giving up. */
      tries?: number;
      /** What went over the wire, redacted, for the attempt row. */
      record?: CallRecord;
    } = {},
  ) {
    super(message);
    this.name = "LucraError";
  }

  get retryable(): boolean {
    return RETRYABLE_LUCRA_ERROR_CODES.has(this.code);
  }
}

/** The documented failure envelope, `{ status: "failure", error }`. */
export interface LucraFailureBody {
  status: "failure";
  error: string;
}

export function isLucraFailureBody(body: unknown): body is LucraFailureBody {
  return typeof body === "object" && body !== null && (body as { status?: unknown }).status === "failure" && typeof (body as { error?: unknown }).error === "string";
}

/** Map a documented error string to its code; anything else is `validation`. */
export function codeForFailureBody(body: LucraFailureBody): LucraErrorCode {
  switch (body.error) {
    case LUCRA_ERROR_BODIES.invalidApiKey:
      return "invalid_api_key";
    case LUCRA_ERROR_BODIES.noMatchupIdentifiers:
      return "no_matchup_identifiers";
    case LUCRA_ERROR_BODIES.matchupNotFound:
      return "matchup_not_found";
    case LUCRA_ERROR_BODIES.userNotFound:
      return "user_not_found";
    default:
      return "validation";
  }
}

export function isLucraError(err: unknown): err is LucraError {
  return err instanceof LucraError;
}
