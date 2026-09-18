import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ephemeralWebhookSecret, resolveWebhookSecret, signWebhookBody, verifyWebhookSignature } from "@/lucra/webhook-signature";

/** The documented worked example (request-verification page): body, secret, and the `sha256=` framing. */
const DOC_BODY = '{"event_type":"item.created","payload":{"id":"item_abc123","name":"New Item","quantity":10},"timestamp":"2025-05-29T12:00:00Z"}';
const DOC_SECRET = "yourSecretToken123";

describe("webhook signature", () => {
  it("signs as sha256=<hex HMAC-SHA256 of the raw body>", () => {
    const expected = createHmac("sha256", DOC_SECRET).update(DOC_BODY).digest("hex");
    expect(signWebhookBody(DOC_BODY, DOC_SECRET)).toBe(`sha256=${expected}`);
    expect(verifyWebhookSignature(DOC_BODY, `sha256=${expected}`, DOC_SECRET)).toEqual({ valid: true });
  });

  it("verifies bytes, not parsed JSON: re-serialized whitespace changes the digest", () => {
    const sig = signWebhookBody(DOC_BODY, DOC_SECRET);
    const pretty = JSON.stringify(JSON.parse(DOC_BODY), null, 2);
    expect(verifyWebhookSignature(pretty, sig, DOC_SECRET)).toEqual({ valid: false, reason: "mismatch" });
    expect(verifyWebhookSignature(Buffer.from(DOC_BODY, "utf8"), sig, DOC_SECRET)).toEqual({ valid: true });
  });

  it("names why a signature fails without leaking the expected digest", () => {
    const sig = signWebhookBody(DOC_BODY, DOC_SECRET);
    expect(verifyWebhookSignature(DOC_BODY, sig, undefined)).toEqual({ valid: false, reason: "no_secret" });
    expect(verifyWebhookSignature(DOC_BODY, null, DOC_SECRET)).toEqual({ valid: false, reason: "missing_header" });
    expect(verifyWebhookSignature(DOC_BODY, "", DOC_SECRET)).toEqual({ valid: false, reason: "missing_header" });
    expect(verifyWebhookSignature(DOC_BODY, sig.slice(7), DOC_SECRET)).toEqual({ valid: false, reason: "bad_format" });
    expect(verifyWebhookSignature(DOC_BODY, "sha256=zz", DOC_SECRET)).toEqual({ valid: false, reason: "bad_format" });
    expect(verifyWebhookSignature(DOC_BODY, sig, "otherSecret")).toEqual({ valid: false, reason: "mismatch" });
    expect(verifyWebhookSignature(DOC_BODY + " ", sig, DOC_SECRET)).toEqual({ valid: false, reason: "mismatch" });
  });

  it("accepts an upper-case hex digest", () => {
    const sig = signWebhookBody(DOC_BODY, DOC_SECRET);
    expect(verifyWebhookSignature(DOC_BODY, `sha256=${sig.slice(7).toUpperCase()}`, DOC_SECRET)).toEqual({ valid: true });
  });
});

describe("resolveWebhookSecret", () => {
  it("prefers the configured secret in every mode", () => {
    expect(resolveWebhookSecret({ NODE_ENV: "production", LUCRA_MODE: "mock", LUCRA_WEBHOOK_SECRET: "s" }, () => "minted")).toEqual({ secret: "s", source: "env" });
    expect(resolveWebhookSecret({ NODE_ENV: "development", LUCRA_MODE: "sandbox", LUCRA_WEBHOOK_SECRET: "s" }, () => "minted")).toEqual({ secret: "s", source: "env" });
  });

  it("stands in a per-process random secret only in mock mode outside production", () => {
    let minted = 0;
    const mint = () => `minted-${(minted += 1)}`;
    expect(resolveWebhookSecret({ NODE_ENV: "development", LUCRA_MODE: "mock" }, mint)).toEqual({ secret: "minted-1", source: "ephemeral" });
    expect(resolveWebhookSecret({ NODE_ENV: "test", LUCRA_MODE: "mock" }, mint)).toEqual({ secret: "minted-2", source: "ephemeral" });
    expect(resolveWebhookSecret({ NODE_ENV: "production", LUCRA_MODE: "mock" }, mint)).toEqual({ secret: undefined, source: "none" });
    expect(resolveWebhookSecret({ NODE_ENV: "development", LUCRA_MODE: "sandbox" }, mint)).toEqual({ secret: undefined, source: "none" });
    expect(resolveWebhookSecret({ NODE_ENV: "production", LUCRA_MODE: "production" }, mint)).toEqual({ secret: undefined, source: "none" });
    expect(minted).toBe(2);
  });

  it("mints one random 64-hex secret per process, stable across calls, and a guessed constant does not verify against it", () => {
    const a = ephemeralWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ephemeralWebhookSecret()).toBe(a);
    const body = '{"event":"TournamentCompleted"}';
    expect(verifyWebhookSignature(body, signWebhookBody(body, a), a)).toEqual({ valid: true });
    expect(verifyWebhookSignature(body, signWebhookBody(body, "sideout-mock-webhook-secret"), a)).toEqual({ valid: false, reason: "mismatch" });
  });
});
