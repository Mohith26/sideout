import type { ApiEnvelope } from "@/lib/api";

/**
 * The one way the consensus components talk to the API: same-origin JSON
 * with the session cookie, always resolved to the envelope so a component
 * branches on `ok` and `error.code`, never on a thrown fetch error.
 */
export async function postJson<T>(url: string, body: unknown): Promise<ApiEnvelope<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: { code: "unavailable", message: "No connection. Your scoreline was not sent; try again when you have signal." } };
  }
  const envelope = await readEnvelope<T>(res);
  if (envelope) return envelope;
  return {
    ok: false,
    error: { code: res.ok ? "internal" : "unavailable", message: "The server sent an unexpected reply. Your request may have gone through; reload to see where things stand." },
  };
}

/** The body as the envelope, or null when the reply (a proxy error page, an empty body) is not one. */
async function readEnvelope<T>(res: Response): Promise<ApiEnvelope<T> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as { ok?: unknown; error?: unknown };
  if (value.ok === true) return parsed as ApiEnvelope<T>;
  if (value.ok !== false || typeof value.error !== "object" || value.error === null) return null;
  const error = value.error as { code?: unknown; message?: unknown };
  return typeof error.code === "string" && typeof error.message === "string" ? (parsed as ApiEnvelope<T>) : null;
}

/** The `detail.code` an envelope carries, when it carries one. */
export function detailCode(envelope: ApiEnvelope<unknown>): string | null {
  if (envelope.ok) return null;
  const detail = envelope.error.detail;
  if (typeof detail === "object" && detail !== null && typeof (detail as { code?: unknown }).code === "string") return (detail as { code: string }).code;
  return null;
}
