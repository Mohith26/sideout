/**
 * The slice of the Lucra Web SDK (`lucra-web-sdk` 1.12.0) that Sideout's
 * browser code relies on, as a structural type both the real package and the
 * mock stand-in (`sdk-mock.ts`) satisfy, plus the pure mapping from the
 * SDK's sealed failures to Sideout's UI states (spec §7.5, §12.5).
 *
 * `LucraGate` (`src/components/lucra/LucraGate.tsx`) is the only module that
 * loads either implementation; everything else sees these types. Nothing
 * here imports the SDK, a server module or a Node built-in.
 *
 * What v1.12.0 actually exposes (read from its source, not guessed):
 *   - `LucraClient.initialize({ apiKey, tenantId, env, autoJoin? })`, a
 *     singleton with `getInstance()` / `destroy()`;
 *   - `client.open(host).home()` mounts the iframe; `client.dialog().<route>()`
 *     presents a route as a fullscreen overlay and returns a `LucraDialog`;
 *   - `client.ready` resolves once initialized *and* signed in, and rejects
 *     with `LucraUserNotLoggedIn` (or the failed `initialized` body);
 *   - `client.user` is the signed-in `SDKLucraUser` (`id`, `balance`,
 *     `accountStatus`, `metadata`) or `null`;
 *   - `client.api.joinTournament(matchupId)` rejects with `LucraApiError`
 *     whose `code` is one of `LucraApiErrorCode`;
 *   - `client.sendMessage.userUpdated({ metadata: { externalId } })` is the
 *     documented user link (`tournaments/user-linking-and-score-ingestion`).
 *
 * The spec's table names the mobile SDKs' sealed cases (`UserStateError.*`,
 * `LocationError`, `APIError`). The web SDK expresses the same cases as
 * `LucraUserNotLoggedIn`, `LucraApiError.code` and the user's
 * `accountStatus`; `classifySdkFailure` is the one place that translation
 * lives, and it branches on `instanceof` and discriminants only.
 */

export type SdkEnvironment = "sandbox" | "production";

/** `SDKLucraUser`, the fields Sideout reads. Never persisted: only the verification state enum is stored (§4.6). */
export interface SdkUser {
  id?: string | undefined;
  username?: string | undefined;
  /** Wallet balance in dollars, as the SDK reports it. */
  balance?: number | undefined;
  accountStatus?: string | undefined;
  metadata?: Record<string, string> | null | undefined;
}

export interface SdkDialog {
  close: () => void;
  onClose: (callback: () => void) => void;
}

/** The `dialog()` routes Sideout launches (spec §7.5's five flows plus the location grant and the rewards views). */
export interface SdkDialogNavigation {
  profile: () => SdkDialog;
  wallet: () => SdkDialog;
  deposit: () => SdkDialog;
  withdraw: () => SdkDialog;
  kyc: () => SdkDialog;
  demographic: () => SdkDialog;
  locationGrant: () => SdkDialog;
  tournamentDetails: (matchupId: string) => SdkDialog;
}

export interface SdkOpenNavigation {
  home: () => unknown;
  login: () => unknown;
}

export interface SdkEventMap {
  loginSuccess: SdkUser;
  userInfo: SdkUser;
  initialized: { success: boolean };
  kycComplete: void;
  demographicComplete: void;
  locationGranted: void;
  tournamentJoined: { matchupId: string };
  autoJoinedTournaments: { matchupIds: string[] };
  claimReward: { reward: { rewardId: string; title: string } };
  exitLucra: void;
}

export interface SdkClient {
  readonly ready: Promise<void>;
  readonly isInitialized: boolean;
  readonly user: SdkUser | null;
  open: (element: HTMLElement, phoneNumber?: string, options?: { hidden?: boolean }) => SdkOpenNavigation;
  dialog: () => SdkDialogNavigation;
  on: <K extends keyof SdkEventMap>(type: K, listener: (data: SdkEventMap[K]) => void) => void;
  off: <K extends keyof SdkEventMap>(type: K, listener: (data: SdkEventMap[K]) => void) => void;
  hide: () => unknown;
  show: () => unknown;
  logout: () => unknown;
  api: {
    joinTournament: (tournamentId: string) => Promise<{ matchupId: string }>;
  };
  sendMessage: {
    userUpdated: (data: { metadata?: Record<string, string> | null }) => void;
  };
}

export interface SdkClientConfig {
  apiKey: string;
  tenantId: string;
  env: SdkEnvironment;
  /** Sideout passes `false`: entry is an explicit join, never the silent auto-join (§7.5). */
  autoJoin?: boolean;
}

export interface SdkClientStatic {
  initialize: (config: SdkClientConfig) => SdkClient;
  getInstance: () => SdkClient;
  destroy: () => void;
}

/** `LucraApiError`: an `Error` carrying one of `LucraApiErrorCode`'s values. */
export interface SdkApiError extends Error {
  readonly code: string;
}

/** The `LucraApiErrorCode` enum's members, by the names the SDK exports them under. */
export interface SdkApiErrorCodes {
  readonly unverified: string;
  readonly insufficientFunds: string;
  readonly demographicInformationMissing: string;
  readonly locationError: string;
  readonly locationNeeded: string;
  readonly apiError: string;
}

/**
 * What `import("lucra-web-sdk")` and `import("@/lucra/sdk-mock")` both
 * provide. The error classes are typed for `instanceof` only (`never`
 * parameters): the gate never constructs one.
 */
export interface LucraSdkModule {
  LucraClient: SdkClientStatic;
  LucraApiError: abstract new (...args: never[]) => SdkApiError;
  LucraUserNotLoggedIn: abstract new (...args: never[]) => Error;
  LucraApiErrorCode: SdkApiErrorCodes;
}

// ---------------------------------------------------------------------------
// Sealed failures → UI states (spec §7.5 table)
// ---------------------------------------------------------------------------

/**
 * `SDKLucraUser.accountStatus` values that mean "blocked or ineligible per
 * backend rules" — the web SDK's `UserStateError.NotAllowed`. Terminal on
 * the client: messaging with a support path, no retry (§7.5, §11.5). The
 * verification-failure statuses are not here: they are `Unverified`, which
 * launches the identity flow again.
 */
export const BLOCKED_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(["BLOCKED", "SUSPENDED", "CLOSED", "CLOSED_PENDING", "HIDDEN"]);

export const VERIFIED_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(["VERIFIED", "AGE_ASSURED_VERIFIED"]);

export type LucraUiFailure =
  /** `UserStateError.NotInitialized`: not ready, or no signed-in user for a user-scoped call. Gate on ready, retry once. */
  | { kind: "not_initialized"; signedIn: boolean }
  /** `UserStateError.Unverified`: launch the identity flow. */
  | { kind: "unverified" }
  /** `UserStateError.NotAllowed`: terminal, no retry. */
  | { kind: "not_allowed" }
  /** `UserStateError.InsufficientFunds`: launch add funds. */
  | { kind: "insufficient_funds" }
  /** `UserStateError.DemographicInformationMissing`: launch the demographic form. */
  | { kind: "demographics_missing" }
  /** `LocationError`: show the location-help state and retry; `grant` when Lucra has no location yet (present the grant page first). */
  | { kind: "location"; grant: boolean }
  /** `APIError`: retried with backoff by the gate, then surfaced. */
  | { kind: "api_error"; message: string };

export type LucraUiFailureKind = LucraUiFailure["kind"];

/** Whether the user's own account state already decides the outcome before any call is made. */
export function accountFailure(user: SdkUser | null): LucraUiFailure | null {
  if (user?.accountStatus && BLOCKED_ACCOUNT_STATUSES.has(user.accountStatus)) return { kind: "not_allowed" };
  return null;
}

/**
 * Translate whatever an SDK call rejected with. Branches on `instanceof`
 * against the loaded module's classes and on the `code` discriminant, never
 * on message text (wording changes between releases). The SDK also rejects
 * with plain strings ("Timeout", a superseded request) and, for a failed
 * initialization, with the `{ success: false }` body; both are handled.
 */
export function classifySdkFailure(err: unknown, sdk: Pick<LucraSdkModule, "LucraApiError" | "LucraUserNotLoggedIn" | "LucraApiErrorCode">, user: SdkUser | null): LucraUiFailure {
  if (err instanceof sdk.LucraUserNotLoggedIn) return { kind: "not_initialized", signedIn: false };
  if (err instanceof sdk.LucraApiError) {
    const codes = sdk.LucraApiErrorCode;
    switch (err.code) {
      case codes.unverified:
        return { kind: "unverified" };
      case codes.insufficientFunds:
        return { kind: "insufficient_funds" };
      case codes.demographicInformationMissing:
        return { kind: "demographics_missing" };
      case codes.locationError:
        return { kind: "location", grant: false };
      case codes.locationNeeded:
        return { kind: "location", grant: true };
      case codes.apiError:
      default:
        // A blocked account fails every call with the catch-all code; the account status is the discriminant.
        return accountFailure(user) ?? { kind: "api_error", message: err.message };
    }
  }
  if (isInitializedBody(err) && err.success === false) return { kind: "not_initialized", signedIn: user !== null };
  if (typeof err === "string") return { kind: "api_error", message: err };
  if (err instanceof Error) return { kind: "api_error", message: err.message };
  return { kind: "api_error", message: "The Lucra request could not be completed." };
}

function isInitializedBody(value: unknown): value is { success: boolean } {
  return typeof value === "object" && value !== null && typeof (value as { success?: unknown }).success === "boolean";
}

/** Whether the gate may try the same call again on its own (the table's "retry" column). */
export function isRetryable(failure: LucraUiFailure): boolean {
  return failure.kind === "not_initialized" || failure.kind === "location" || failure.kind === "api_error";
}

/** Backoff for `APIError`: three tries (spec §7.5 "retry with backoff, then surface"). */
export const API_ERROR_MAX_TRIES = 3;
export function apiErrorBackoffMs(attempt: number, baseMs = 400): number {
  return baseMs * 2 ** Math.max(0, attempt - 1);
}
