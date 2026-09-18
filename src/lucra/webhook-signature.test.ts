import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "@/lucra/webhook-signature";

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
