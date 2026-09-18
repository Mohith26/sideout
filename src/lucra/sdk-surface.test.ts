import { describe, expect, it } from "vitest";
import { LucraApiError, LucraApiErrorCode, LucraUserNotLoggedIn } from "@/lucra/sdk-mock";
import { accountFailure, API_ERROR_MAX_TRIES, apiErrorBackoffMs, BLOCKED_ACCOUNT_STATUSES, classifySdkFailure, isRetryable } from "@/lucra/sdk-surface";

/**
 * The §7.5 table as a pure function: every sealed case the web SDK can
 * reject with lands on exactly one UI state, decided by class and code.
 */
const sdk = { LucraApiError, LucraUserNotLoggedIn, LucraApiErrorCode };

describe("classifySdkFailure", () => {
  it("maps each LucraApiErrorCode to its row of the table", () => {
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.unverified), sdk, null)).toEqual({ kind: "unverified" });
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.insufficientFunds), sdk, null)).toEqual({ kind: "insufficient_funds" });
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.demographicInformationMissing), sdk, null)).toEqual({ kind: "demographics_missing" });
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.locationError), sdk, null)).toEqual({ kind: "location", grant: false });
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.locationNeeded), sdk, null)).toEqual({ kind: "location", grant: true });
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.apiError, "500 from Lucra"), sdk, null)).toEqual({ kind: "api_error", message: "500 from Lucra" });
  });

  it("NotInitialized: the not-logged-in class, or a failed initialization body", () => {
    expect(classifySdkFailure(new LucraUserNotLoggedIn(), sdk, null)).toEqual({ kind: "not_initialized", signedIn: false });
    expect(classifySdkFailure({ success: false }, sdk, null)).toEqual({ kind: "not_initialized", signedIn: false });
    expect(classifySdkFailure({ success: false }, sdk, { id: "u" })).toEqual({ kind: "not_initialized", signedIn: true });
  });

  it("NotAllowed comes from the account status, never from the message", () => {
    for (const status of BLOCKED_ACCOUNT_STATUSES) {
      expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.apiError, "User is not verified"), sdk, { accountStatus: status })).toEqual({ kind: "not_allowed" });
      expect(accountFailure({ accountStatus: status })).toEqual({ kind: "not_allowed" });
    }
    // A specific code wins over the status: the table's row for that code applies.
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.unverified, "blocked"), sdk, { accountStatus: "BLOCKED" })).toEqual({ kind: "unverified" });
    expect(accountFailure({ accountStatus: "VERIFICATION_FAILED" })).toBeNull();
    expect(accountFailure(null)).toBeNull();
    // The message says "blocked"; the status does not: APIError, retryable.
    expect(classifySdkFailure(new LucraApiError(LucraApiErrorCode.apiError, "User is blocked"), sdk, { accountStatus: "VERIFIED" })).toEqual({ kind: "api_error", message: "User is blocked" });
  });

  it("the SDK's plain-string rejections and unknown values are APIError", () => {
    expect(classifySdkFailure("Timeout", sdk, null)).toEqual({ kind: "api_error", message: "Timeout" });
    expect(classifySdkFailure(new Error("boom"), sdk, null)).toEqual({ kind: "api_error", message: "boom" });
    expect(classifySdkFailure(undefined, sdk, null)).toEqual({ kind: "api_error", message: "The Lucra request could not be completed." });
  });

  it("a foreign error class with a matching code is not trusted: instanceof, not shape", () => {
    class Impostor extends Error {
      code = LucraApiErrorCode.unverified;
    }
    expect(classifySdkFailure(new Impostor("x"), sdk, null)).toEqual({ kind: "api_error", message: "x" });
  });

  it("says which rows the gate may retry on its own, and how APIError backs off", () => {
    expect(isRetryable({ kind: "not_initialized", signedIn: false })).toBe(true);
    expect(isRetryable({ kind: "location", grant: false })).toBe(true);
    expect(isRetryable({ kind: "api_error", message: "" })).toBe(true);
    expect(isRetryable({ kind: "not_allowed" })).toBe(false);
    expect(isRetryable({ kind: "unverified" })).toBe(false);
    expect(API_ERROR_MAX_TRIES).toBe(3);
    expect([1, 2, 3].map((n) => apiErrorBackoffMs(n))).toEqual([400, 800, 1600]);
  });
});
