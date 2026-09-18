import "server-only";
import type { NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import { DatabaseNotReadyError } from "@/db/connection";
import type { User } from "@/db/schema";
import { BracketError } from "@/domain/bracket";
import { DrawError } from "@/domain/draw";
import { ApiFailure, fail, type ApiErrorCode } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
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
