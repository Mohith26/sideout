import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * The response envelope every application route returns (spec §9):
 * `{ ok: true, data }` or `{ ok: false, error: { code, message, detail? } }`.
 * Nothing under `error` ever carries a Lucra internal or a secret.
 */

export const API_ERROR_CODES = [
  "bad_request",
  "not_found",
  "unauthorized",
  "forbidden",
  "conflict",
  "rate_limited",
  "unavailable",
  "internal",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  code: z.enum(API_ERROR_CODES),
  message: z.string(),
  detail: z.unknown().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export type ApiOk<T> = { ok: true; data: T };
export type ApiFail = { ok: false; error: ApiError };
export type ApiEnvelope<T> = ApiOk<T> | ApiFail;

const STATUS_FOR_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export function ok<T>(data: T, init?: ResponseInit): NextResponse<ApiOk<T>> {
  return NextResponse.json<ApiOk<T>>({ ok: true, data }, init);
}

export function fail(
  code: ApiErrorCode,
  message: string,
  detail?: unknown,
  init?: ResponseInit,
): NextResponse<ApiFail> {
  const error: ApiError = detail === undefined ? { code, message } : { code, message, detail };
  return NextResponse.json<ApiFail>({ ok: false, error }, { status: STATUS_FOR_CODE[code], ...init });
}

/**
 * A failure that already knows its envelope. Services throw these; the route
 * wrapper (`@/server/http`) turns them into `fail()` responses. Anything else
 * thrown is an `internal` error with no detail leaked.
 */
export class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

/** Build a zod schema for a successful envelope around `data`, for tests and clients. */
export function okEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({ ok: z.literal(true), data });
}

export const failEnvelopeSchema = z.object({ ok: z.literal(false), error: apiErrorSchema });
