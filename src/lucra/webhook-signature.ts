import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

declare global {
  var __sideoutEphemeralWebhookSecret: string | undefined;
}

/**
 * The secret the in-process mock signs with and the receiver verifies with
 * when `LUCRA_WEBHOOK_SECRET` is unset in mock mode: random, minted once per
 * process (on `globalThis`, since the server build bundles this module into
 * every route's chunk), never a constant anyone could read out of the repo.
 */
export function ephemeralWebhookSecret(): string {
  globalThis.__sideoutEphemeralWebhookSecret ??= randomBytes(32).toString("hex");
  return globalThis.__sideoutEphemeralWebhookSecret;
}

export type WebhookSecretSource = "env" | "ephemeral" | "none";

/**
 * Which secret verifies (and, in mock mode, signs) webhook deliveries. The
 * configured value always wins. In mock mode outside production the
 * per-process random secret stands in, so the mock's own deliveries verify
 * and nothing else does. In production, and in every sandbox/production
 * mode, there is no fallback: without `LUCRA_WEBHOOK_SECRET` every delivery
 * is refused, and the process says so at boot.
 */
export function resolveWebhookSecret(env: { NODE_ENV: string; LUCRA_MODE: string; LUCRA_WEBHOOK_SECRET?: string | undefined }, mint: () => string = ephemeralWebhookSecret): { secret: string | undefined; source: WebhookSecretSource } {
  if (env.LUCRA_WEBHOOK_SECRET) return { secret: env.LUCRA_WEBHOOK_SECRET, source: "env" };
  if (env.LUCRA_MODE === "mock" && env.NODE_ENV !== "production") return { secret: mint(), source: "ephemeral" };
  return { secret: undefined, source: "none" };
}

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
