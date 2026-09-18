import { createHmac, timingSafeEqual } from "node:crypto";
import { LUCRA_SIGNATURE_HEADER, LUCRA_SIGNATURE_PREFIX } from "@/lucra/endpoints";

/**
 * Webhook signature verification (spec §7.6), in one swappable function.
 *
 * The scheme is published (server-to-server/webhook-subscriptions/
 * request-verification, legacy/2.0_webhook_setup): an HMAC of the raw request
 * body under the webhook's shared secret, hex-encoded, sent as
 * `X-Lucra-Signature: sha256=<hex>`, compared in constant time.
 *
 * OPEN: (§17.3) the request-verification page hedges — "Let's assume the
 * hashing algorithm is HMAC-SHA256 and the header format is sha256=" — while
 * the setup page states both flatly. HMAC-SHA256 with that header is what is
 * implemented; if a live delivery ever carries a different prefix, this
 * function is the only thing to change.
 */

export { LUCRA_SIGNATURE_HEADER };

/** The mock signs with this when `LUCRA_WEBHOOK_SECRET` is unset; the receiver in mock mode verifies with it. Never used outside mock mode. */
export const MOCK_WEBHOOK_SECRET = "sideout-mock-webhook-secret";

export function signWebhookBody(rawBody: string | Uint8Array, secret: string): string {
  return `${LUCRA_SIGNATURE_PREFIX}${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export type SignatureVerdict = { valid: true } | { valid: false; reason: "missing_header" | "bad_format" | "mismatch" | "no_secret" };

/**
 * Verify `signatureHeader` over exactly the bytes received. Never parse and
 * re-stringify the body first: whitespace or key order would change the digest.
 */
export function verifyWebhookSignature(rawBody: string | Uint8Array, signatureHeader: string | null | undefined, secret: string | undefined): SignatureVerdict {
  if (!secret) return { valid: false, reason: "no_secret" };
  if (!signatureHeader) return { valid: false, reason: "missing_header" };
  if (!signatureHeader.startsWith(LUCRA_SIGNATURE_PREFIX)) return { valid: false, reason: "bad_format" };
  const received = signatureHeader.slice(LUCRA_SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return { valid: false, reason: "bad_format" };
  const expected = signWebhookBody(rawBody, secret).slice(LUCRA_SIGNATURE_PREFIX.length);
  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "mismatch" };
  return { valid: true };
}
