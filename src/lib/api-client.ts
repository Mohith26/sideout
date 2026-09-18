import type { ApiEnvelope, ApiError } from "@/lib/api";

/**
 * The browser side of the application API (spec §9). Every screen that writes
 * goes through the same route handlers the tests cover, with the session cookie
 * sent automatically; the envelope comes back parsed, and a transport failure
 * or a non-envelope body becomes a `unavailable` error rather than a throw, so
 * a form has exactly one shape to render.
 */

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export type ApiResult<T> = ApiEnvelope<T> & { status: number; retryAfterMs: number | null };

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { ok?: unknown; error?: unknown };
  if (v.ok === true) return true;
  return v.ok === false && typeof v.error === "object" && v.error !== null;
}

const TRANSPORT_ERROR: ApiError = { code: "unavailable", message: "Could not reach Sideout. Check your connection and try again." };

export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: options.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    cache: "no-store",
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    return { ok: false, error: TRANSPORT_ERROR, status: 0, retryAfterMs: null };
  }
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
  let parsed: unknown = null;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!isEnvelope(parsed)) {
    return {
      ok: false,
      error: { code: response.ok ? "internal" : "unavailable", message: response.ok ? "Unexpected response." : `Server answered ${response.status}.` },
      status: response.status,
      retryAfterMs,
    };
  }
  return { ...(parsed as ApiEnvelope<T>), status: response.status, retryAfterMs };
}

/** `detail.code` from an error envelope, when the route set one (e.g. `sms_unavailable`). */
export function errorDetailCode(error: ApiError): string | null {
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const code = (detail as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Per-field messages from a `bad_request` envelope's zod issues, keyed by path. */
export function fieldIssues(error: ApiError): Record<string, string> {
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return {};
  const issues = (detail as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return {};
  const out: Record<string, string> = {};
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof path === "string" && typeof message === "string" && !(path in out)) out[path] = message;
  }
  return out;
}
