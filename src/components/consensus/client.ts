import type { ApiEnvelope } from "@/lib/api";

/**
 * The one way the consensus components talk to the API: same-origin JSON
 * with the session cookie, always resolved to the envelope so a component
 * branches on `ok` and `error.code`, never on a thrown fetch error.
 */
export async function postJson<T>(url: string, body: unknown): Promise<ApiEnvelope<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!text) return { ok: false, error: { code: res.ok ? "internal" : "unavailable", message: "The server sent an empty reply." } };
    return JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    return { ok: false, error: { code: "unavailable", message: "No connection. Your scoreline was not sent; try again when you have signal." } };
  }
}

/** The `detail.code` an envelope carries, when it carries one. */
export function detailCode(envelope: ApiEnvelope<unknown>): string | null {
  if (envelope.ok) return null;
  const detail = envelope.error.detail;
  if (typeof detail === "object" && detail !== null && typeof (detail as { code?: unknown }).code === "string") return (detail as { code: string }).code;
  return null;
}
