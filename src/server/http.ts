import "server-only";
import type { NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import { DatabaseNotReadyError } from "@/db/connection";
import type { User } from "@/db/schema";
import { BracketError } from "@/domain/bracket";
import { ConsensusError, LucraWriteRefused } from "@/domain/consensus";
import { DrawError } from "@/domain/draw";
import { ApiFailure, fail, type ApiErrorCode } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
import { isLucraError, LUCRA_ERROR_MESSAGE, type LucraErrorCode } from "@/lucra";
import { SESSION_COOKIE } from "@/server/auth/session";
import { userForSessionToken } from "@/server/auth/viewer";

/**
 * The thin layer every route handler sits on: zod at the boundary, the
 * envelope from `@/lib/api`, and one place that maps thrown errors to it.
 * Routes never touch the database; they parse, call a `@/server/*` service,
 * and return.
 */

/** Authenticated responses must never be cached by a shared cache. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

const DRAW_ERROR_CODE: Record<DrawError["code"], ApiErrorCode> = {
  unsupported_format: "conflict",
  too_few_teams: "conflict",
  duplicate_team: "conflict",
  bad_seed: "bad_request",
  bad_option: "bad_request",
  bad_advancement: "bad_request",
  bracket_mismatch: "conflict",
};

const CONSENSUS_ERROR_CODE: Record<ConsensusError["code"], ApiErrorCode> = {
  illegal_scoreline: "bad_request",
  not_on_team: "forbidden",
  already_submitted_by_team: "conflict",
  match_not_open: "conflict",
  invalid_transition: "conflict",
};

/**
 * A Lucra failure surfaces as a Sideout envelope: the sealed code in
 * `detail.code`, the plain message from `LUCRA_ERROR_MESSAGE`, and nothing
 * Lucra said verbatim (§9: never leak Lucra internals). An unreachable or
 * misconfigured Lucra is `unavailable`.
 */
const LUCRA_ERROR_CODE: Record<LucraErrorCode, ApiErrorCode> = {
  invalid_api_key: "unavailable",
  no_matchup_identifiers: "conflict",
  matchup_not_found: "conflict",
  user_not_found: "conflict",
  validation: "conflict",
  http: "unavailable",
  server: "unavailable",
  transport: "unavailable",
  shape: "unavailable",
  not_participant: "conflict",
  strict_targeting: "conflict",
  ambiguous_matchup: "conflict",
  unlinked_user: "conflict",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Run a handler body, turning known failures into envelopes and unknown ones into `internal`. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiFailure) {
      const retryAfterMs = err.code === "rate_limited" && isRecord(err.detail) && typeof err.detail.retryAfterMs === "number" ? err.detail.retryAfterMs : null;
      const headers = retryAfterMs === null ? NO_STORE : { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
      return fail(err.code, err.message, err.detail, { headers });
    }
    if (err instanceof ZodError) {
      return fail(
        "bad_request",
        "The request did not validate.",
        { issues: err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) },
        { headers: NO_STORE },
      );
    }
    if (err instanceof DrawError) return fail(DRAW_ERROR_CODE[err.code], err.message, { code: err.code }, { headers: NO_STORE });
    if (err instanceof BracketError) return fail("conflict", err.message, { code: err.code }, { headers: NO_STORE });
    if (err instanceof ConsensusError) return fail(CONSENSUS_ERROR_CODE[err.code], err.message, { ...err.detail, code: err.code }, { headers: NO_STORE });
    if (err instanceof LucraWriteRefused) return fail("conflict", err.message, { code: err.code }, { headers: NO_STORE });
    if (isLucraError(err)) {
      const body = err.detail.body;
      return fail(LUCRA_ERROR_CODE[err.code], LUCRA_ERROR_MESSAGE[err.code], { code: err.code, ...(isRecord(body) && typeof body.count === "number" ? { count: body.count } : {}) }, { headers: NO_STORE });
    }
    if (err instanceof DatabaseNotReadyError) return fail("unavailable", "Database is not ready; run `npm run seed`.", undefined, { headers: NO_STORE });
    log.error("route: unhandled error", { message: errorMessage(err) }, err);
    return fail("internal", "Something went wrong on our side.", undefined, { headers: NO_STORE });
  }
}

/** Parse a JSON body. A missing or malformed body is a `bad_request`, never a 500. */
export async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiFailure("bad_request", "Request body must be JSON.");
  }
  return schema.parse(raw);
}

/**
 * Read a raw body without letting an anonymous caller choose its size: a
 * declared `Content-Length` over the limit is refused before a byte is read,
 * and a stream is abandoned the moment it passes the limit.
 */
export async function readRawBody(request: Request, limitBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  const tooLarge = () => new ApiFailure("payload_too_large", `The request body may not exceed ${limitBytes} bytes.`, { limitBytes });
  if (declared !== null && Number(declared) > limitBytes) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseQuery<T extends z.ZodType>(request: NextRequest, schema: T): z.output<T> {
  const entries: Record<string, string> = {};
  for (const [k, v] of request.nextUrl.searchParams.entries()) entries[k] = v;
  return schema.parse(entries);
}

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

export function currentUser(request: NextRequest, clock: Clock = systemClock): User | null {
  return userForSessionToken(request.cookies.get(SESSION_COOKIE)?.value, clock);
}

export function requireUser(request: NextRequest, clock: Clock = systemClock): User {
  const user = currentUser(request, clock);
  if (!user) throw new ApiFailure("unauthorized", "Sign in to continue.");
  return user;
}

export function requireOrganizer(request: NextRequest, clock: Clock = systemClock): User {
  const user = requireUser(request, clock);
  if (user.role !== "organizer") throw new ApiFailure("forbidden", "Organizer access is required.");
  return user;
}
