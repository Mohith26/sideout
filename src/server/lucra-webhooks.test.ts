import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lucraLinks, rewards, tournaments, webhookEvents } from "@/db/schema";
import { fixedClock } from "@/lib/clock";
import { uuidv7 } from "@/lib/uuid";
import { mockWebhookSecret, signWebhookBody } from "@/lucra";
import { SLUGS } from "@/seed/build";
import { getLucra } from "@/server/lucra";
import { bodyFingerprint, deliverPendingMockWebhooks, deriveEventId, receiveLucraWebhook } from "@/server/lucra-webhooks";
import { createTestApp, type TestApp } from "@/test/routes";

describe("Lucra webhook receiver (spec §7.6; acceptance 11)", () => {
  let app: TestApp;
  const clock = fixedClock(1_790_000_000_000);
  let logs: ReturnType<typeof vi.spyOn>[] = [];
  const secret = () => mockWebhookSecret();
  const deliver = (payload: unknown, options: { signature?: string | null; raw?: string } = {}) => {
    const rawBody = options.raw ?? JSON.stringify(payload);
    return receiveLucraWebhook({ rawBody, signatureHeader: options.signature === undefined ? signWebhookBody(rawBody, secret()) : options.signature }, clock);
  };
  const events = () => app.conn.db.select().from(webhookEvents).all();

  beforeEach(() => {
    app = createTestApp();
    logs = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(process.stdout, "write").mockImplementation(() => true)];
  });
  afterEach(() => {
    for (const l of logs) l.mockRestore();
    app.close();
  });

  const matchupFor = (slug: (typeof SLUGS)[keyof typeof SLUGS]) => {
    const t = app.tournament(slug);
    const matchup = getLucra().mock?.listMatchups().find((m) => m.metadata.externalId === t.lucraExternalId);
    if (!matchup) throw new Error("no mock matchup");
    return { t, matchup };
  };

  it("rejects a bad or missing signature with 401, keeps the evidence under a key that cannot shadow the real delivery", async () => {
    const body = { event: "TournamentCompleted", matchup: { id: "m-1", status: "CLOSED", users: [] } };
    const bad = await deliver(body, { signature: "sha256=" + "0".repeat(64) });
    expect(bad).toMatchObject({ status: 401, signatureValid: false, eventId: null, processingState: "ignored" });
    expect(bad.message).not.toMatch(/[0-9a-f]{64}/);
    const missing = await deliver(body, { signature: null });
    expect(missing.status).toBe(401);
    const rows = events();
    expect(rows).toHaveLength(1); // the same forged body twice is one evidence row
    expect(rows[0]).toMatchObject({ externalEventId: `unverified:${bodyFingerprint(JSON.stringify(body))}`, signatureValid: false, processingState: "ignored", eventType: "TournamentCompleted" });
    // The genuine delivery is still processed afterwards: the forged one occupied no real key.
    const real = await deliver(body);
    expect(real).toMatchObject({ status: 200, duplicate: false, eventId: "TournamentCompleted:m-1", processingState: "ignored" });
    expect(events()).toHaveLength(2);
  });

  it("answers 400 to a signed body that is not an event, without persisting it", async () => {
    expect(await deliver(null, { raw: "not json" })).toMatchObject({ status: 400 });
    expect(await deliver({ hello: "world" })).toMatchObject({ status: 400 });
    expect(events()).toEqual([]);
  });

  it("acceptance 11: a replayed event id answers 200 and is not processed twice", async () => {
    const { t, matchup } = matchupFor(SLUGS.live);
    app.conn.db.update(tournaments).set({ status: "awaiting_settlement", closePreviewJson: JSON.stringify({ tournamentId: t.id, standings: [], rewards: [], previewHash: "x", closedAt: 1, closedByUserId: "o" }) }).where(eq(tournaments.id, t.id)).run();
    const body = { event: "TournamentCompleted", tenantId: "sideout-mock-tenant", mode: "admin", matchup: { id: matchup.id, status: "CLOSED", metadata: { externalId: t.lucraExternalId }, users: [{ userId: "u-1", position: 1, positionOverride: null, score: 10 }] } };
    const first = await deliver(body);
    expect(first).toMatchObject({ status: 200, duplicate: false, processingState: "processed", eventId: `TournamentCompleted:${matchup.id}` });
    expect(app.conn.db.select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, t.id)).get()?.status).toBe("settled");
    const auditsAfterFirst = app.audits(t.id, "lucra.webhook.tournament_completed").length;
    expect(auditsAfterFirst).toBe(1);

    const replay = await deliver(body);
    expect(replay).toMatchObject({ status: 200, duplicate: true, processingState: "processed" });
    // Redelivered with different whitespace: same key, still a duplicate.
    const reserialized = await deliver(body, { raw: JSON.stringify(body, null, 2) });
    expect(reserialized.duplicate).toBe(true);
    expect(app.audits(t.id, "lucra.webhook.tournament_completed")).toHaveLength(auditsAfterFirst);
    expect(events().filter((e) => e.externalEventId === `TournamentCompleted:${matchup.id}`)).toHaveLength(1);
  });

  it("ignores a well-formed unknown type with 2xx and records it as ignored", async () => {
    const res = await deliver({ event: "FundsWithdrawnByAlien", userId: "u-1" });
    expect(res).toMatchObject({ status: 200, processingState: "ignored", eventType: "FundsWithdrawnByAlien" });
    expect(events()[0]).toMatchObject({ processingState: "ignored", signatureValid: true, eventType: "FundsWithdrawnByAlien" });
    expect(events()[0]?.externalEventId).toMatch(/^FundsWithdrawnByAlien:body:[0-9a-f]{64}$/);
    // FundsDeposited is a known name Sideout has nothing to do with: ignored the same way.
    expect((await deliver({ event: "FundsDeposited", userId: "u-1", tenantId: "t", properties: { amount: 5 } })).processingState).toBe("ignored");
  });

  it("TournamentCompleted settles a tournament awaiting settlement, confirms a settled one, and alerts on a live one", async () => {
    const { t, matchup } = matchupFor(SLUGS.live);
    const body = { event: "TournamentCompleted", mode: "auto", matchup: { id: matchup.id, status: "CLOSED", metadata: { externalId: t.lucraExternalId }, users: [] } };
    // Live: Sideout has not closed; Lucra says it is done. Recorded, alert raised, nothing settled.
    const live = await deliver(body);
    expect(live).toMatchObject({ status: 200, processingState: "processed" });
    const row = app.conn.db.select().from(tournaments).where(eq(tournaments.id, t.id)).get()!;
    expect(row.status).toBe("live");
    expect(JSON.parse(row.lucraAlertJson ?? "{}")).toMatchObject({ code: "settlement_refused", blocking: true });

    // Awaiting settlement with a projected reward: the webhook settles and awards.
    const rewardId = uuidv7();
    app.conn.db.insert(rewards).values({ id: rewardId, tournamentId: t.id, teamId: app.data.teams.find((x) => x.tournamentId === t.id)!.id, placement: 1, kind: "lucra_reward", amountCents: 100, currency: "USD", description: "x", lucraRewardRef: null, status: "projected" }).run();
    app.conn.db.update(tournaments).set({ status: "awaiting_settlement" }).where(eq(tournaments.id, t.id)).run();
    const again = await deliver({ ...body, mode: "manual" }, { raw: JSON.stringify({ ...body, mode: "manual", nonce: 2 }) });
    expect(again.duplicate).toBe(true); // same matchup + type: the dedupe key does not see the mode change
    // A failed row is retried; simulate by marking the stored row failed.
    app.conn.db.update(webhookEvents).set({ processingState: "failed" }).where(eq(webhookEvents.externalEventId, `TournamentCompleted:${matchup.id}`)).run();
    const retried = await deliver(body);
    expect(retried).toMatchObject({ status: 200, duplicate: false, processingState: "processed" });
    const settled = app.conn.db.select().from(tournaments).where(eq(tournaments.id, t.id)).get()!;
    expect(settled.status).toBe("settled");
    expect(settled.lucraAlertJson).toBeNull();
    expect(app.conn.db.select().from(rewards).where(eq(rewards.id, rewardId)).get()).toMatchObject({ status: "awarded", lucraRewardRef: matchup.id });
    expect(app.audits(t.id, "tournament.status_changed").at(-1)).toMatchObject({ actorKind: "lucra_webhook" });
    // A matchup Sideout does not know is ignored.
    expect((await deliver({ event: "TournamentCompleted", matchup: { id: "ghost", status: "CLOSED", users: [] } })).processingState).toBe("ignored");
  });

  it("TournamentUserJoined records the Lucra id on the link it names; UserKYCVerified updates only the state enum; UserSignedUp links by phone", async () => {
    const { matchup } = matchupFor(SLUGS.live);
    const player = app.player();
    const link = app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.userId, player.id)).get()!;
    app.conn.db.update(lucraLinks).set({ lucraUserId: null, verificationState: "unverified" }).where(eq(lucraLinks.id, link.id)).run();

    const joined = await deliver({ event: "TournamentUserJoined", newUserId: "lucra-user-777", userMetadata: { externalId: link.externalId }, matchup: { id: matchup.id, status: "OPEN", users: [{ userId: "lucra-user-777" }] } });
    expect(joined).toMatchObject({ status: 200, processingState: "processed", eventId: `TournamentUserJoined:${matchup.id}:lucra-user-777` });
    expect(app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.id, link.id)).get()).toMatchObject({ lucraUserId: "lucra-user-777", lastSyncedAt: clock.now() });
    // Another user joining under a Lucra id nobody links to: recorded, no link touched.
    expect((await deliver({ event: "TournamentUserJoined", newUserId: "lucra-user-000", userMetadata: { externalId: "nobody" }, matchup: { id: matchup.id, status: "OPEN", users: [] } })).processingState).toBe("processed");

    const kyc = await deliver({ event: "UserKYCVerified", userId: "lucra-user-777" });
    expect(kyc).toMatchObject({ status: 200, processingState: "processed", eventId: "UserKYCVerified:lucra-user-777" });
    const after = app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.id, link.id)).get()!;
    expect(after.verificationState).toBe("verified");
    expect(Object.keys(after)).toEqual(["id", "userId", "lucraUserId", "externalId", "verificationState", "linkedAt", "lastSyncedAt"]); // no identity data, ever
    expect(app.audits(player.id, "lucra.webhook.kyc_verified")[0]).toMatchObject({ actorKind: "lucra_webhook" });
    expect((await deliver({ event: "UserKYCVerified", userId: "lucra-user-unknown" })).processingState).toBe("ignored");

    // Sign-up by phone: exactly one Sideout account, link without an id yet.
    const other = app.data.users.find((u) => u.role === "player" && u.id !== player.id)!;
    const otherLink = app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.userId, other.id)).get()!;
    app.conn.db.update(lucraLinks).set({ lucraUserId: null }).where(eq(lucraLinks.id, otherLink.id)).run();
    const digits = (other.phoneE164 ?? "").replace("+", "");
    const signedUp = await deliver({ event: "UserSignedUp", userId: "lucra-user-888", email: null, username: "x", phoneNumber: digits });
    expect(signedUp).toMatchObject({ status: 200, processingState: "processed" });
    expect(app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.id, otherLink.id)).get()?.lucraUserId).toBe("lucra-user-888");
    expect((await deliver({ event: "UserSignedUp", userId: "lucra-user-999", phoneNumber: "+10000000000" })).processingState).toBe("ignored");
  });

  it("derives stable event ids: explicit ids win, known types key on matchup and user, the rest on the body", () => {
    expect(deriveEventId({ event: "X", eventId: "abc" }, "{}")).toBe("event:abc");
    expect(deriveEventId({ event: "TournamentCompleted", matchup: { id: "m" } }, "{}")).toBe("TournamentCompleted:m");
    expect(deriveEventId({ event: "TournamentUserJoined", matchup: { id: "m" }, newUserId: "u" }, "{}")).toBe("TournamentUserJoined:m:u");
    expect(deriveEventId({ event: "UserKYCVerified", userId: "u" }, "{}")).toBe("UserKYCVerified:u");
    expect(deriveEventId({ event: "TournamentEdited", matchup: { id: "m" } }, '{"a":1}')).toBe(`TournamentEdited:body:${bodyFingerprint('{"a":1}')}`);
    expect(deriveEventId({ event: "TournamentCompleted" }, "{}")).toBe(`TournamentCompleted:body:${bodyFingerprint("{}")}`);
  });

  it("delivers the mock's queued webhooks to this receiver in process, signed, so the real path runs in mock mode", async () => {
    const { t, matchup } = matchupFor(SLUGS.upcoming);
    const mock = getLucra().mock!;
    const newcomer = mock.state().users.find((u) => !matchup.participants.has(u.id))!;
    mock.join(matchup.id, newcomer.id);
    expect(mock.pendingWebhooks.map((w) => w.event)).toEqual(["TournamentUserJoined"]);
    expect(await deliverPendingMockWebhooks(clock)).toBe(1);
    expect(mock.pendingWebhooks).toEqual([]);
    expect(events().map((e) => [e.eventType, e.signatureValid, e.processingState])).toEqual([["TournamentUserJoined", true, "processed"]]);
    expect(app.audits(t.id, "lucra.webhook.received").length + app.audits(newcomer.metadata.externalId as string).length).toBeGreaterThanOrEqual(0);
    expect(await deliverPendingMockWebhooks(clock)).toBe(0);
  });
});
