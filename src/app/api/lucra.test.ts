import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as submissionsRoute } from "@/app/api/admin/lucra/submissions/route";
import { POST as retryRoute } from "@/app/api/admin/matches/[id]/lucra/retry/route";
import { GET as participantsRoute } from "@/app/api/admin/tournaments/[id]/lucra/participants/route";
import { POST as settleRoute } from "@/app/api/admin/tournaments/[id]/lucra/settle/route";
import { POST as verifyRoute } from "@/app/api/admin/tournaments/[id]/lucra/verify/route";
import { POST as linkRoute } from "@/app/api/me/lucra/link/route";
import { GET as mockStateRoute } from "@/app/api/rest/%5Fmock/state/route.mock";
import { POST as webhookRoute } from "@/app/api/webhooks/lucra/route";
import { lucraLinks, lucraScoreSubmissions, matchConsensus, matches, tournaments } from "@/db/schema";
import type { ApiEnvelope } from "@/lib/api";
import { LUCRA_SIGNATURE_HEADER, mockWebhookSecret, signWebhookBody } from "@/lucra";
import { SLUGS } from "@/seed/build";
import { getLucra } from "@/server/lucra";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

type Envelope<T> = ApiEnvelope<T>;
type SubmissionsData = { submissions: Array<{ row: { id: string; outcome: string; tournamentId: string; requestJson: string; responseJson: string | null; attempt: number }; retryable: boolean; attemptsForKey: number; match: { roundLabel: string } }>; tournaments: Array<{ tournament: { id: string; lucraExternalId: string } }> };

describe("Lucra routes (spec §9)", () => {
  let app: TestApp;
  let organizerCookie = "";
  let playerCookie = "";
  let logs: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    app = createTestApp();
    organizerCookie = app.cookieFor(app.organizer().id);
    playerCookie = app.cookieFor(app.player().id);
    logs = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(process.stdout, "write").mockImplementation(() => true)];
  });
  afterEach(() => {
    for (const l of logs) l.mockRestore();
    app.close();
  });

  describe("GET /api/admin/lucra/submissions", () => {
    it("is organizer-only and lists every row with the exact request and response, filterable", async () => {
      expectFailure(await app.call(submissionsRoute, "/api/admin/lucra/submissions"), 401, "unauthorized");
      expectFailure(await app.call(submissionsRoute, "/api/admin/lucra/submissions", { cookie: playerCookie }), 403, "forbidden");
      const all = await app.call<Envelope<SubmissionsData>>(submissionsRoute, "/api/admin/lucra/submissions", { cookie: organizerCookie });
      expect(all.status).toBe(200);
      expect(all.headers.get("cache-control")).toBe("no-store");
      if (!all.body.ok) throw new Error("expected ok");
      expect(all.body.data.submissions.length).toBe(app.data.lucraScoreSubmissions.length);
      expect(all.body.data.tournaments).toHaveLength(3);
      const first = all.body.data.submissions[0]!;
      expect(JSON.parse(first.row.requestJson)).toMatchObject({ endpoint: "pool_tournament", target: { matchupMetadata: { externalId: expect.stringMatching(/^sideout-/) } } });
      expect(first.row.requestJson).not.toContain("sideout-mock-backend-key");
      expect(JSON.stringify(all.body)).not.toMatch(/LUCRA_BACKEND|mock-backend-key/);

      const partial = await app.call<Envelope<SubmissionsData>>(submissionsRoute, "/api/admin/lucra/submissions?outcome=partial", { cookie: organizerCookie });
      if (!partial.body.ok) throw new Error("expected ok");
      expect(partial.body.data.submissions.map((s) => s.row.outcome)).toEqual(["partial"]);
      // A failed attempt that was later retried is not retryable; its consensus is accepted.
      expect(partial.body.data.submissions[0]).toMatchObject({ retryable: false, attemptsForKey: 2 });
      const settled = app.tournament(SLUGS.settled);
      const byTournament = await app.call<Envelope<SubmissionsData>>(submissionsRoute, `/api/admin/lucra/submissions?tournamentId=${settled.id}`, { cookie: organizerCookie });
      if (!byTournament.body.ok) throw new Error("expected ok");
      expect(byTournament.body.data.submissions.every((s) => s.row.tournamentId === settled.id)).toBe(true);
      expectFailure(await app.call(submissionsRoute, "/api/admin/lucra/submissions?outcome=nope", { cookie: organizerCookie }), 400, "bad_request");
    });
  });

  describe("POST /api/me/lucra/link", () => {
    it("mints once, is idempotent, and records the Lucra id the SDK reports", async () => {
      expectFailure(await app.call(linkRoute, "/api/me/lucra/link", { method: "POST", body: {} }), 401, "unauthorized");
      const organizer = app.organizer();
      const cookie = app.cookieFor(organizer.id); // organizers hold no link in the seed
      const first = await app.call<Envelope<{ externalId: string; lucraUserId: string | null; minted: boolean; verificationState: string }>>(linkRoute, "/api/me/lucra/link", { method: "POST", body: {}, cookie });
      expect(first.status).toBe(201);
      if (!first.body.ok) throw new Error("expected ok");
      expect(first.body.data).toMatchObject({ minted: true, lucraUserId: null, verificationState: "unverified" });
      expect(first.body.data.externalId).not.toContain(organizer.phoneE164?.replace("+", "") ?? "nope");
      const second = await app.call<Envelope<{ externalId: string; minted: boolean }>>(linkRoute, "/api/me/lucra/link", { method: "POST", body: {}, cookie });
      expect(second.status).toBe(200);
      if (!second.body.ok) throw new Error("expected ok");
      expect(second.body.data).toMatchObject({ minted: false, externalId: first.body.data.externalId });
      const linked = await app.call<Envelope<{ lucraUserId: string | null }>>(linkRoute, "/api/me/lucra/link", { method: "POST", body: { lucraUserId: "lucra-sdk-user-1" }, cookie });
      if (!linked.body.ok) throw new Error("expected ok");
      expect(linked.body.data.lucraUserId).toBe("lucra-sdk-user-1");
      expect(expectFailure(await app.call(linkRoute, "/api/me/lucra/link", { method: "POST", body: { lucraUserId: "lucra-sdk-user-2" }, cookie }), 409, "conflict").detail).toEqual({ code: "lucra_user_id_conflict" });
      expectFailure(await app.call(linkRoute, "/api/me/lucra/link", { method: "POST", body: { lucraUserId: "" }, cookie }), 400, "bad_request");
      expectFailure(await app.call(linkRoute, "/api/me/lucra/link", { method: "POST", body: { phone: "+1" }, cookie }), 400, "bad_request");
      expect(app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.userId, organizer.id)).all()).toHaveLength(1);
    });
  });

  describe("POST /api/webhooks/lucra", () => {
    it("reads the raw body, verifies the signature, deduplicates, and never leaks a secret", async () => {
      const body = JSON.stringify({ event: "UserKYCVerified", userId: "lucra-nobody" });
      const signed = await app.call<Envelope<{ eventId: string; duplicate: boolean; processingState: string }>>(webhookRoute, "/api/webhooks/lucra", { method: "POST", rawBody: body, headers: { [LUCRA_SIGNATURE_HEADER]: signWebhookBody(body, mockWebhookSecret()) } });
      expect(signed.status).toBe(200);
      if (!signed.body.ok) throw new Error("expected ok");
      expect(signed.body.data).toMatchObject({ eventId: "UserKYCVerified:lucra-nobody", duplicate: false, processingState: "ignored" });
      const replay = await app.call<Envelope<{ duplicate: boolean }>>(webhookRoute, "/api/webhooks/lucra", { method: "POST", rawBody: body, headers: { [LUCRA_SIGNATURE_HEADER]: signWebhookBody(body, mockWebhookSecret()) } });
      expect(replay.status).toBe(200);
      if (!replay.body.ok) throw new Error("expected ok");
      expect(replay.body.data.duplicate).toBe(true);
      const forged = await app.call(webhookRoute, "/api/webhooks/lucra", { method: "POST", rawBody: body, headers: { [LUCRA_SIGNATURE_HEADER]: "sha256=" + "f".repeat(64) } });
      expectFailure(forged, 401, "unauthorized");
      expect(JSON.stringify(forged.body)).not.toContain(mockWebhookSecret());
      expectFailure(await app.call(webhookRoute, "/api/webhooks/lucra", { method: "POST", rawBody: body }), 401, "unauthorized");
      const garbage = "{{{";
      expectFailure(await app.call(webhookRoute, "/api/webhooks/lucra", { method: "POST", rawBody: garbage, headers: { [LUCRA_SIGNATURE_HEADER]: signWebhookBody(garbage, mockWebhookSecret()) } }), 400, "bad_request");
    });
  });

  describe("organizer Lucra actions", () => {
    const liveMatch = () => {
      const live = app.tournament(SLUGS.live);
      const m = app.conn.db
        .select()
        .from(matches)
        .where(and(eq(matches.tournamentId, live.id), eq(matches.bracketPosition, 9)))
        .get();
      if (!m) throw new Error("no QF 9");
      return m;
    };

    it("retry is organizer-only and refuses an accepted write (nothing is sent twice)", async () => {
      const m = liveMatch();
      expectFailure(await app.call(retryRoute, `/api/admin/matches/${m.id}/lucra/retry`, { method: "POST", params: { id: m.id } }), 401, "unauthorized");
      expectFailure(await app.call(retryRoute, `/api/admin/matches/${m.id}/lucra/retry`, { method: "POST", params: { id: m.id }, cookie: playerCookie }), 403, "forbidden");
      const refused = await app.call(retryRoute, `/api/admin/matches/${m.id}/lucra/retry`, { method: "POST", params: { id: m.id }, cookie: organizerCookie });
      expect(expectFailure(refused, 409, "conflict").detail).toMatchObject({ code: "not_retryable" });
      expectFailure(await app.call(retryRoute, "/api/admin/matches/nope/lucra/retry", { method: "POST", params: { id: "nope" }, cookie: organizerCookie }), 404, "not_found");
      expect(app.conn.db.select().from(lucraScoreSubmissions).where(eq(lucraScoreSubmissions.matchId, m.id)).all()).toHaveLength(1);
    });

    it("retry re-sends a partial write under the same key", async () => {
      const m = liveMatch();
      const t = app.tournament(SLUGS.live);
      const matchup = getLucra().mock!.listMatchups().find((x) => x.metadata.externalId === t.lucraExternalId)!;
      // Put the consensus back to partial as the earlier attempt left it, with the mock refusing the matchup.
      app.conn.db.update(matchConsensus).set({ state: "partial" }).where(eq(matchConsensus.matchId, m.id)).run();
      matchup.status = "CLOSED";
      const stillPartial = await app.call<Envelope<{ outcome: string; attempt: number }>>(retryRoute, `/api/admin/matches/${m.id}/lucra/retry`, { method: "POST", params: { id: m.id }, cookie: organizerCookie });
      expect(stillPartial.status).toBe(200);
      if (!stillPartial.body.ok) throw new Error("expected ok");
      expect(stillPartial.body.data).toMatchObject({ outcome: "partial", attempt: 2 });
      matchup.status = "OPEN";
      const landed = await app.call<Envelope<{ outcome: string; attempt: number; consensusState: string }>>(retryRoute, `/api/admin/matches/${m.id}/lucra/retry`, { method: "POST", params: { id: m.id }, cookie: organizerCookie });
      if (!landed.body.ok) throw new Error("expected ok");
      expect(landed.body.data).toMatchObject({ outcome: "accepted", attempt: 3, consensusState: "accepted" });
      const rows = app.conn.db.select().from(lucraScoreSubmissions).where(eq(lucraScoreSubmissions.matchId, m.id)).all();
      expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(1);
      expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2, 3]);
    });

    it("verify runs the pre-write assertion; participants reconciles; settle refuses a live event", async () => {
      const upcoming = app.tournament(SLUGS.upcoming);
      expectFailure(await app.call(verifyRoute, `/api/admin/tournaments/${upcoming.id}/lucra/verify`, { method: "POST", params: { id: upcoming.id }, cookie: playerCookie }), 403, "forbidden");
      const verified = await app.call<Envelope<{ matchupId: string; count: number; queried: boolean }>>(verifyRoute, `/api/admin/tournaments/${upcoming.id}/lucra/verify`, { method: "POST", params: { id: upcoming.id }, cookie: organizerCookie });
      expect(verified.status).toBe(200);
      if (!verified.body.ok) throw new Error("expected ok");
      expect(verified.body.data).toMatchObject({ count: 1, queried: true });
      expect(app.conn.db.select({ id: tournaments.lucraMatchupId }).from(tournaments).where(eq(tournaments.id, upcoming.id)).get()?.id).toBe(verified.body.data.matchupId);
      expect(app.audits(upcoming.id, "lucra.matchup_verified")).toHaveLength(1);

      const recon = await app.call<Envelope<{ matched: unknown[]; missing: unknown[]; unlinked: unknown[]; extra: unknown[]; lucraStatus: string }>>(participantsRoute, `/api/admin/tournaments/${upcoming.id}/lucra/participants`, { params: { id: upcoming.id }, cookie: organizerCookie });
      expect(recon.status).toBe(200);
      if (!recon.body.ok) throw new Error("expected ok");
      expect(recon.body.data).toMatchObject({ lucraStatus: "OPEN" });
      expect(recon.body.data.missing).toHaveLength(1);
      expect(recon.body.data.extra).toHaveLength(1);
      expect(JSON.stringify(recon.body)).not.toMatch(/phone|\+1555/);

      const live = app.tournament(SLUGS.live);
      expect(expectFailure(await app.call(settleRoute, `/api/admin/tournaments/${live.id}/lucra/settle`, { method: "POST", params: { id: live.id }, cookie: organizerCookie }), 409, "conflict").detail).toMatchObject({ code: "not_awaiting_settlement" });
      expectFailure(await app.call(verifyRoute, "/api/admin/tournaments/nope/lucra/verify", { method: "POST", params: { id: "nope" }, cookie: organizerCookie }), 404, "not_found");
    });

    it("the mock state route is organizer-gated and exposes the mock's world", async () => {
      expectFailure(await app.call(mockStateRoute, "/api/rest/_mock/state"), 401, "unauthorized");
      expectFailure(await app.call(mockStateRoute, "/api/rest/_mock/state", { cookie: playerCookie }), 403, "forbidden");
      const state = await app.call<Envelope<{ interpretation: string; matchups: Array<{ kind: string; status: string; metadata: { externalId?: string; season?: string } }>; users: unknown[]; ingestions: unknown[] }>>(mockStateRoute, "/api/rest/_mock/state", { cookie: organizerCookie });
      expect(state.status).toBe(200);
      if (!state.body.ok) throw new Error("expected ok");
      expect(state.body.data.interpretation).toBe("literal");
      // One matchup per seeded tournament, three overlapping on loose metadata, two recreational games.
      expect(state.body.data.matchups.filter((m) => m.kind === "pool_tournament")).toHaveLength(6);
      expect(state.body.data.matchups.filter((m) => m.metadata.season === "2026-spring")).toHaveLength(3);
      expect(state.body.data.matchups.filter((m) => m.kind === "recreational")).toHaveLength(2);
      expect(state.body.data.matchups.find((m) => m.metadata.externalId === app.tournament(SLUGS.settled).lucraExternalId)?.status).toBe("CLOSED");
      expect(state.body.data.users.length).toBe(app.data.lucraLinks.length);
    });
  });
});
