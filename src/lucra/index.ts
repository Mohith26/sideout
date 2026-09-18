/**
 * The import surface of `src/lucra/` (spec §5, §8): the adapter and the
 * types. `client.ts` and `mock.ts` are internal — an ESLint restriction
 * (`eslint.config.mjs`) refuses them, and any direct `fetch` against a Lucra
 * host, anywhere outside this directory.
 */
export {
  assertStrictTarget,
  classifyWrite,
  createLucraAdapter,
  getLucraAdapter,
  installLucraAdapter,
  mockWebhookSecret,
  type AdapterOptions,
  type LucraAdapter,
  type QueryInput,
  type ScoreWriteInput,
  type ScoreWriteResult,
  type WriteEndpoint,
  type WriteOutcome,
} from "@/lucra/adapter";
export { LUCRA_API_KEY_HEADER, LUCRA_API_VERSION, LUCRA_ERROR_BODIES, LUCRA_PATHS, LUCRA_WEBHOOK_EVENTS, REDACTED } from "@/lucra/endpoints";
export { isLucraError, LUCRA_ERROR_MESSAGE, LucraError, type LucraErrorCode } from "@/lucra/errors";
export { MATCHER_INTERPRETATIONS, type MatcherInterpretation } from "@/lucra/matcher";
export type { MockSeed, MockSeedMatchup, MockSeedUser, MockStateSnapshot, MockWebhookDelivery } from "@/lucra/mock";
export * from "@/lucra/types";
export { LUCRA_SDK_PACKAGE, LUCRA_SDK_SOURCE, LUCRA_SDK_VERSION, LUCRA_STATE_COVERAGE } from "@/lucra/version";
export { LUCRA_SIGNATURE_HEADER, signWebhookBody, verifyWebhookSignature, type SignatureVerdict } from "@/lucra/webhook-signature";
