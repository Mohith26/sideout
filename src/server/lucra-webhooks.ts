import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { lucraLinks, tournaments, users, webhookEvents, type WebhookEvent, type WebhookProcessingState } from "@/db/schema";
import type { TransitionActor } from "@/domain/transitions";
import { env } from "@/env";
import { systemClock, type Clock } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
import { uuidv7 } from "@/lib/uuid";
import { knownWebhookEventSchema, LUCRA_WEBHOOK_EVENTS, mockWebhookSecret, verifyWebhookSignature, webhookEnvelopeSchema, type KnownWebhookEvent } from "@/lucra";
import { writeAudit, type Tx } from "@/server/audit";
import { getLucra, LUCRA_AUDIT, type LucraAlert } from "@/server/lucra";

/**
 * `POST /api/webhooks/lucra` (spec §7.6), as a service the route and the mock
 * both call with the raw body:
 *
 *   1. the signature is verified over the exact bytes received (the route
 *      caps the body at `WEBHOOK_BODY_LIMIT_BYTES` before reading it); an
 *      unverified delivery is logged and refused with 401 — nothing an
 *      anonymous caller sends reaches durable storage;
 *   2. the body is parsed only after that;
 *   3. the event is deduplicated on `external_event_id` — a repeat answers
 *      200 without reprocessing; a row whose processing failed, or never ran
 *      because the process died after persisting it, is processed on redelivery;
 *   4. the row is persisted to `webhook_events` before anything acts on it;
 *   5. processing runs in one transaction with its audit rows, and a
 *      well-formed event Sideout chooses to ignore still gets a 2xx.
 *
 * Nothing here settles a tournament or touches `rewards`: the organizer's
 * close is the only settlement trigger (§7.4). `TournamentCompleted` confirms
 * a settled tournament and raises an alert on any other.
 *
 * OPEN: (§17.3, "Webhook event id") no published Lucra payload carries an
 * event id, and the docs' own idempotency example keys on matchup id plus
 * event type. `deriveEventId` builds that key for the known types (plus the
 * joining user for `TournamentUserJoined`, the user for the user events) and a
 * sha256 of the body for anything else.
 */

export const WEBHOOK_ACTOR: TransitionActor = { kind: "lucra_webhook", userId: null };

export const WEBHOOK_AUDIT = {
  received: "lucra.webhook.received",
  tournamentCompleted: "lucra.webhook.tournament_completed",
  tournamentCanceled: "lucra.webhook.tournament_canceled",
  userJoined: "lucra.webhook.user_joined",
  userSignedUp: "lucra.webhook.user_signed_up",
  kycVerified: "lucra.webhook.kyc_verified",
  ignored: "lucra.webhook.ignored",
} as const;

/** The most a delivery may weigh; Lucra's payloads are a few kilobytes. */
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

export interface WebhookReceipt {
  /** The HTTP status the route answers with. */
  status: number;
  eventId: string | null;
  eventType: string | null;
  signatureValid: boolean;
  duplicate: boolean;
  processingState: WebhookProcessingState | null;
  /** Plain words for the response body; never a secret or an expected digest. */
  message: string;
}

/** The secret the receiver verifies with: the configured one, or in mock mode outside production the per-process one the mock signs with. */
export function webhookSecretForMode(): string | undefined {
  if (env.LUCRA_MODE === "mock") return mockWebhookSecret();
  return env.LUCRA_WEBHOOK_SECRET;
}

export function bodyFingerprint(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/** A stable dedupe key per delivery, mirroring the documented idempotency guidance. */
export function deriveEventId(payload: { event: string } & Record<string, unknown>, rawBody: string): string {
  const matchup = payload.matchup;
  const matchupId = typeof matchup === "object" && matchup !== null && typeof (matchup as { id?: unknown }).id === "string" ? (matchup as { id: string }).id : null;
  switch (payload.event) {
    case LUCRA_WEBHOOK_EVENTS.tournamentCompleted:
    case LUCRA_WEBHOOK_EVENTS.tournamentCanceled:
    case LUCRA_WEBHOOK_EVENTS.tournamentCreated:
      if (matchupId) return `${payload.event}:${matchupId}`;
      break;
    case LUCRA_WEBHOOK_EVENTS.tournamentUserJoined:
      if (matchupId && typeof payload.newUserId === "string") return `${payload.event}:${matchupId}:${payload.newUserId}`;
      break;
    case LUCRA_WEBHOOK_EVENTS.userSignedUp:
    case LUCRA_WEBHOOK_EVENTS.userKycVerified:
      if (typeof payload.userId === "string") return `${payload.event}:${payload.userId}`;
      break;
    default:
      break;
  }
  // TournamentEdited fires per edit and carries no counter: only the body distinguishes deliveries.
  return `${payload.event}:body:${bodyFingerprint(rawBody)}`;
}

export interface WebhookInput {
  rawBody: string;
  signatureHeader: string | null | undefined;
}

export async function receiveLucraWebhook(input: WebhookInput, clock: Clock = systemClock): Promise<WebhookReceipt> {
  const db = getDb();
  const now = clock.now();
  const secret = webhookSecretForMode();
  if (!secret) {
    // OPEN: (§17.3) no secret means nothing can be verified. Loud, every time, and refused.
    log.warn("lucra webhook: refused because LUCRA_WEBHOOK_SECRET is not configured", { lucraMode: env.LUCRA_MODE });
  }
  const verdict = verifyWebhookSignature(input.rawBody, input.signatureHeader, secret);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody) as unknown;
  } catch {
    parsed = null;
  }
  const envelope = webhookEnvelopeSchema.safeParse(parsed);

  if (!verdict.valid) {
    const eventType = envelope.success ? envelope.data.event : "malformed";
    log.warn("lucra webhook: signature rejected", { reason: verdict.reason, eventType, bytes: input.rawBody.length, bodySha256: bodyFingerprint(input.rawBody) });
    return { status: 401, eventId: null, eventType, signatureValid: false, duplicate: false, processingState: null, message: `Signature rejected (${verdict.reason}).` };
  }

  if (!envelope.success) {
    return { status: 400, eventId: null, eventType: null, signatureValid: true, duplicate: false, processingState: null, message: "The body is not a Lucra event: expected JSON with an `event` name." };
  }
  const payload = envelope.data;
  const eventId = deriveEventId(payload, input.rawBody);

  // Dedupe: a repeat answers 200 without reprocessing; a row left `failed`, or `received` by a process that died, is tried again.
  const existing = db.select().from(webhookEvents).where(eq(webhookEvents.externalEventId, eventId)).get();
  if (existing && existing.processingState !== "failed" && existing.processingState !== "received") {
    log.info("lucra webhook: duplicate delivery ignored", { eventId, eventType: payload.event, state: existing.processingState });
    return { status: 200, eventId, eventType: payload.event, signatureValid: true, duplicate: true, processingState: existing.processingState, message: "Already received." };
  }
  const rowId =
    existing?.id ??
    persist(db, {
      externalEventId: eventId,
      eventType: payload.event,
      signatureValid: true,
      rawBody: input.rawBody,
      parsedJson: JSON.stringify(payload),
      processingState: "received",
      receivedAt: now,
      processedAt: null,
    });

  const known = knownWebhookEventSchema.safeParse(payload);
  let outcome: HandlerOutcome;
  try {
    outcome = db.transaction((tx) => {
      writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.received, subjectType: "tournament", subjectId: subjectFor(payload), detail: { eventId, eventType: payload.event, known: known.success }, at: now });
      let result: HandlerOutcome;
      if (!known.success) {
        result = { state: "ignored", message: `Ignored: ${payload.event} is not an event Sideout handles.` };
        writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.ignored, subjectType: "tournament", subjectId: subjectFor(payload), detail: { eventId, eventType: payload.event, reason: "unknown_type" }, at: now });
      } else {
        result = processKnownEvent(tx, known.data, eventId, now);
      }
      tx.update(webhookEvents).set({ processingState: result.state, processedAt: now }).where(eq(webhookEvents.id, rowId)).run();
      return result;
    });
  } catch (err) {
    log.error("lucra webhook: processing failed", { eventId, eventType: payload.event, message: errorMessage(err) }, err);
    db.update(webhookEvents).set({ processingState: "failed", processedAt: now }).where(eq(webhookEvents.id, rowId)).run();
    return { status: 500, eventId, eventType: payload.event, signatureValid: true, duplicate: false, processingState: "failed", message: "Processing failed; the delivery may be retried." };
  }
  log.info("lucra webhook: processed", { eventId, eventType: payload.event, state: outcome.state });
  return { status: 200, eventId, eventType: payload.event, signatureValid: true, duplicate: false, processingState: outcome.state, message: outcome.message };
}

function persist(db: ReturnType<typeof getDb>, row: Omit<WebhookEvent, "id" | "provider">): string {
  const id = uuidv7();
  db.insert(webhookEvents)
    .values({ id, provider: "lucra", ...row })
    .run();
  return id;
}

function subjectFor(payload: { event: string } & Record<string, unknown>): string {
  const matchup = payload.matchup;
  if (typeof matchup === "object" && matchup !== null && typeof (matchup as { id?: unknown }).id === "string") return (matchup as { id: string }).id;
  if (typeof payload.userId === "string") return payload.userId;
  return payload.event;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface HandlerOutcome {
  state: Extract<WebhookProcessingState, "processed" | "ignored">;
  message: string;
}

function processKnownEvent(tx: Tx, event: KnownWebhookEvent, eventId: string, now: number): HandlerOutcome {
  switch (event.event) {
    case LUCRA_WEBHOOK_EVENTS.tournamentCompleted:
      return onTournamentCompleted(tx, event, eventId, now);
    case LUCRA_WEBHOOK_EVENTS.tournamentCanceled:
      return onTournamentCanceled(tx, event, eventId, now);
    case LUCRA_WEBHOOK_EVENTS.tournamentUserJoined:
      return onTournamentUserJoined(tx, event, eventId, now);
    case LUCRA_WEBHOOK_EVENTS.userSignedUp:
      return onUserSignedUp(tx, event, eventId, now);
    case LUCRA_WEBHOOK_EVENTS.userKycVerified:
      return onUserKycVerified(tx, event, eventId, now);
    case LUCRA_WEBHOOK_EVENTS.tournamentCreated:
    case LUCRA_WEBHOOK_EVENTS.tournamentEdited: {
      const t = tournamentForMatchup(tx, event.matchup);
      writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.ignored, subjectType: "tournament", subjectId: t?.id ?? event.matchup.id, detail: { eventId, eventType: event.event, reason: "no_action" }, at: now });
      return { state: "ignored", message: `${event.event} recorded; nothing to do.` };
    }
  }
}

/** The Sideout tournament a Lucra matchup belongs to: by cached matchup id, else by the externalId in its metadata. */
function tournamentForMatchup(tx: Tx, matchup: { id: string; metadata?: Record<string, unknown> | null | undefined }) {
  const byId = tx.select().from(tournaments).where(eq(tournaments.lucraMatchupId, matchup.id)).get();
  if (byId) return byId;
  const ext = matchup.metadata?.externalId;
  if (typeof ext === "string") return tx.select().from(tournaments).where(eq(tournaments.lucraExternalId, ext)).get() ?? null;
  return null;
}

/**
 * Lucra says the tournament is closed. If the organizer's close already
 * settled it this is a confirmation. Anything else — closed from Lucra's
 * console while Sideout has it live or awaiting settlement — is recorded and
 * raised as a blocking alert; the status, the rewards and the frozen preview
 * are the organizer's close to change, never a webhook's.
 */
function onTournamentCompleted(tx: Tx, event: Extract<KnownWebhookEvent, { event: "TournamentCompleted" }>, eventId: string, now: number): HandlerOutcome {
  const t = tournamentForMatchup(tx, event.matchup);
  if (!t) {
    writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.ignored, subjectType: "tournament", subjectId: event.matchup.id, detail: { eventId, eventType: event.event, reason: "unknown_matchup" }, at: now });
    return { state: "ignored", message: "TournamentCompleted for a matchup Sideout does not know." };
  }
  const winners = event.matchup.users.filter((u) => (u.positionOverride ?? u.position) !== null && (u.positionOverride ?? u.position) !== undefined).map((u) => ({ userId: u.userId, position: u.positionOverride ?? u.position ?? null }));
  if (t.status === "settled") {
    writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.tournamentCompleted, subjectType: "tournament", subjectId: t.id, detail: { eventId, matchupId: event.matchup.id, mode: event.mode ?? null, alreadySettled: true, winners }, at: now });
    return { state: "processed", message: "TournamentCompleted confirmed an already settled tournament." };
  }
  const alert: LucraAlert = { code: "settlement_refused", blocking: true, at: now, message: `Lucra reports this tournament as completed (mode ${event.mode ?? "unknown"}) while Sideout has it ${t.status}. Reconcile in the console; only the organizer's close settles it here.`, detail: { eventId, matchupId: event.matchup.id, winners } };
  tx.update(tournaments).set({ lucraAlertJson: JSON.stringify(alert) }).where(eq(tournaments.id, t.id)).run();
  writeAudit(tx, { actor: WEBHOOK_ACTOR, action: LUCRA_AUDIT.alertRaised, subjectType: "tournament", subjectId: t.id, detail: { code: alert.code, message: alert.message, eventId }, at: now });
  writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.tournamentCompleted, subjectType: "tournament", subjectId: t.id, detail: { eventId, matchupId: event.matchup.id, mode: event.mode ?? null, tournamentStatus: t.status, winners }, at: now });
  return { state: "processed", message: `TournamentCompleted recorded against a ${t.status} tournament; organizer alert raised.` };
}

function onTournamentCanceled(tx: Tx, event: Extract<KnownWebhookEvent, { event: "TournamentCanceled" }>, eventId: string, now: number): HandlerOutcome {
  const t = tournamentForMatchup(tx, event.matchup);
  if (!t) return { state: "ignored", message: "TournamentCanceled for a matchup Sideout does not know." };
  const alert: LucraAlert = { code: "tournament_canceled", blocking: true, at: now, message: "Lucra canceled this tournament's matchup; no score can be written and it cannot settle through Lucra. Contact your Lucra representative.", detail: { eventId, matchupId: event.matchup.id } };
  tx.update(tournaments).set({ lucraAlertJson: JSON.stringify(alert) }).where(eq(tournaments.id, t.id)).run();
  writeAudit(tx, { actor: WEBHOOK_ACTOR, action: LUCRA_AUDIT.alertRaised, subjectType: "tournament", subjectId: t.id, detail: { code: alert.code, message: alert.message, eventId }, at: now });
  writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.tournamentCanceled, subjectType: "tournament", subjectId: t.id, detail: { eventId, matchupId: event.matchup.id }, at: now });
  return { state: "processed", message: "TournamentCanceled recorded; organizer alert raised." };
}

/** A user joined the matchup: record Lucra's id on their link (by the externalId we gave Lucra) and refresh the sync time. */
function onTournamentUserJoined(tx: Tx, event: Extract<KnownWebhookEvent, { event: "TournamentUserJoined" }>, eventId: string, now: number): HandlerOutcome {
  const t = tournamentForMatchup(tx, event.matchup);
  const ext = event.userMetadata?.externalId;
  const link = typeof ext === "string" ? tx.select().from(lucraLinks).where(eq(lucraLinks.externalId, ext)).get() : undefined;
  if (link) {
    const claimed = link.lucraUserId === null ? tx.select({ id: lucraLinks.id }).from(lucraLinks).where(eq(lucraLinks.lucraUserId, event.newUserId)).get() : undefined;
    if (link.lucraUserId === null && !claimed) tx.update(lucraLinks).set({ lucraUserId: event.newUserId, linkedAt: link.linkedAt ?? now, lastSyncedAt: now }).where(eq(lucraLinks.id, link.id)).run();
    else tx.update(lucraLinks).set({ lastSyncedAt: now }).where(eq(lucraLinks.id, link.id)).run();
    writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.userJoined, subjectType: "user", subjectId: link.userId, detail: { eventId, matchupId: event.matchup.id, tournamentId: t?.id ?? null, lucraUserId: event.newUserId, recordedLucraId: link.lucraUserId === null && !claimed }, at: now });
    return { state: "processed", message: "TournamentUserJoined matched a linked player." };
  }
  writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.userJoined, subjectType: "tournament", subjectId: t?.id ?? event.matchup.id, detail: { eventId, matchupId: event.matchup.id, lucraUserId: event.newUserId, matchedLink: false }, at: now });
  return { state: "processed", message: "TournamentUserJoined recorded for a Lucra user with no Sideout link; the reconciliation view lists them as extra." };
}

/** A Lucra sign-up: link by phone, only when exactly one Sideout account has that phone and no link holds the Lucra id yet. */
function onUserSignedUp(tx: Tx, event: Extract<KnownWebhookEvent, { event: "UserSignedUp" }>, eventId: string, now: number): HandlerOutcome {
  const phone = typeof event.phoneNumber === "string" ? normalizePhone(event.phoneNumber) : null;
  const user = phone ? tx.select().from(users).where(eq(users.phoneE164, phone)).get() : undefined;
  if (!user) {
    writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.userSignedUp, subjectType: "user", subjectId: event.userId, detail: { eventId, matchedUser: false }, at: now });
    return { state: "ignored", message: "UserSignedUp for a phone Sideout does not know." };
  }
  const link = tx.select().from(lucraLinks).where(eq(lucraLinks.userId, user.id)).get();
  const claimed = tx.select({ id: lucraLinks.id }).from(lucraLinks).where(eq(lucraLinks.lucraUserId, event.userId)).get();
  if (link && link.lucraUserId === null && !claimed) {
    tx.update(lucraLinks).set({ lucraUserId: event.userId, linkedAt: link.linkedAt ?? now, lastSyncedAt: now }).where(eq(lucraLinks.id, link.id)).run();
    writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.userSignedUp, subjectType: "user", subjectId: user.id, detail: { eventId, lucraUserId: event.userId, recordedLucraId: true }, at: now });
    return { state: "processed", message: "UserSignedUp recorded the Lucra user id on the player's link." };
  }
  writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.userSignedUp, subjectType: "user", subjectId: user.id, detail: { eventId, lucraUserId: event.userId, recordedLucraId: false, hadLink: link !== undefined }, at: now });
  return { state: "processed", message: link ? "UserSignedUp matched a player whose link is already set." : "UserSignedUp matched a player with no link yet; the id is recorded when they link." };
}

/** Verification updates: only the state enum is stored, never identity data (§4.6). */
function onUserKycVerified(tx: Tx, event: Extract<KnownWebhookEvent, { event: "UserKYCVerified" }>, eventId: string, now: number): HandlerOutcome {
  const link = tx.select().from(lucraLinks).where(eq(lucraLinks.lucraUserId, event.userId)).get();
  if (!link) {
    writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.kycVerified, subjectType: "user", subjectId: event.userId, detail: { eventId, matchedLink: false }, at: now });
    return { state: "ignored", message: "UserKYCVerified for a Lucra user no Sideout link claims." };
  }
  tx.update(lucraLinks).set({ verificationState: "verified", lastSyncedAt: now }).where(eq(lucraLinks.id, link.id)).run();
  writeAudit(tx, { actor: WEBHOOK_ACTOR, action: WEBHOOK_AUDIT.kycVerified, subjectType: "user", subjectId: link.userId, detail: { eventId, from: link.verificationState, to: "verified" }, at: now });
  return { state: "processed", message: "Verification state updated." };
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

// ---------------------------------------------------------------------------
// Mock delivery
// ---------------------------------------------------------------------------

/** Hand every webhook the mock has queued to this receiver, in process. Returns how many were delivered. */
export async function deliverPendingMockWebhooks(clock: Clock = systemClock): Promise<number> {
  const adapter = getLucra();
  if (!adapter.mock) return 0;
  const deliveries = adapter.mock.drainWebhooks();
  for (const d of deliveries) {
    const receipt = await receiveLucraWebhook({ rawBody: d.rawBody, signatureHeader: d.signature }, clock);
    log.info("lucra: mock webhook delivered in process", { event: d.event, status: receipt.status, state: receipt.processingState ?? null });
  }
  return deliveries.length;
}
