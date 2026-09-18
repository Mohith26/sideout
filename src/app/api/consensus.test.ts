import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listDisputesRoute } from "@/app/api/admin/disputes/route";
import { POST as forfeitRoute } from "@/app/api/admin/matches/[id]/forfeit/route";
import { POST as resolveRoute } from "@/app/api/admin/matches/[id]/resolve/route";
import { GET as previewRoute } from "@/app/api/admin/tournaments/[id]/close/preview/route";
import { POST as closeRoute } from "@/app/api/admin/tournaments/[id]/close/route";
import { GET as getMatch } from "@/app/api/matches/[id]/route";
import { POST as scoresRoute } from "@/app/api/matches/[id]/scores/route";
import { matches, teamMembers, type Match } from "@/db/schema";
import type { SubmittedSet } from "@/domain/consensus";
import type { SetScore } from "@/domain/scoreline";
import { SLUGS } from "@/seed/build";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

type Envelope<T> = { ok: true; data: T };
type SubmitData = {
  outcome: string;
  replaced: boolean;
  perspective: "a" | "b";
  consensus: { state: string; live: Array<{ teamId: string | null; sets: SetScore[] }>; differences: Array<{ setNumber: number }>; disputedReason: string | null; resolvedBy: { userId: string } | null };
  match: { match: Match; sets: Array<{ setNumber: number; agreed: boolean }> };
};
type PreviewData = { previewHash: string; blockers: Array<{ matchId: string; reason: string; status: string }>; standingsProvisional: boolean; standings: Array<{ placement: number; teamId: string }>; rewards: unknown[] };

const A_WINS: SetScore[] = [
  { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
  { setNumber: 2, teamAPoints: 21, teamBPoints: 16 },
];
const typed = (setsForA: readonly SetScore[], side: "a" | "b"): SubmittedSet[] =>
  setsForA.map((s) => ({ setNumber: s.setNumber, usPoints: side === "a" ? s.teamAPoints : s.teamBPoints, themPoints: side === "a" ? s.teamBPoints : s.teamAPoints }));

describe("consensus routes (spec §9, §10)", () => {
  let app: TestApp;
  let organizerCookie: string;
  let live: { id: string };

  beforeEach(() => {
    app = createTestApp();
    organizerCookie = app.cookieFor(app.organizer().id);
    live = app.tournament(SLUGS.live);
  });
  afterEach(() => app.close());

  const at = (position: number): Match => {
    const m = app.conn.db
      .select()
      .from(matches)
      .where(and(eq(matches.tournamentId, live.id), eq(matches.bracketPosition, position)))
      .get();
    if (!m) throw new Error(`no match at ${position}`);
    return m;
  };
  const captainOf = (teamId: string | null) => {
    const row = app.conn.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId ?? ""))
      .get();
    if (!row) throw new Error("no captain");
    return row.userId;
  };
  const submit = (matchId: string, userId: string, sets: SubmittedSet[]) =>
    app.call<Envelope<SubmitData>>(scoresRoute, `/api/matches/${matchId}/scores`, { method: "POST", params: { id: matchId }, cookie: app.cookieFor(userId), body: { sets } });
  const preview = (id: string, cookie = organizerCookie) => app.call<Envelope<PreviewData>>(previewRoute, `/api/admin/tournaments/${id}/close/preview`, { params: { id }, cookie });
  const close = (id: string, previewHash: string, cookie = organizerCookie) =>
    app.call<Envelope<{ detail: { tournament: { status: string } }; frozen: { previewHash: string }; settlement: { state: string } }>>(closeRoute, `/api/admin/tournaments/${id}/close`, {
      method: "POST",
      params: { id },
      cookie,
      body: { previewHash },
    });

  describe("POST /api/matches/:id/scores", () => {
    it("requires a session, a member of one of the two teams, and a well-formed body", async () => {
      const m = at(13);
      const captain = captainOf(m.teamAId);
      expectFailure(await app.call(scoresRoute, `/api/matches/${m.id}/scores`, { method: "POST", params: { id: m.id }, body: { sets: typed(A_WINS, "a") } }), 401, "unauthorized");
      const outsider = app.organizer();
      const denied = await submit(m.id, outsider.id, typed(A_WINS, "a"));
      const err = expectFailure(denied, 403, "forbidden");
      expect(err.detail).toEqual({ code: "not_on_team" });
      expectFailure(await submit(m.id, captain, [] as SubmittedSet[]), 400, "bad_request");
      expectFailure(await submit(m.id, captain, [{ setNumber: 1, usPoints: 100, themPoints: 0 }]), 400, "bad_request");
      expectFailure(await app.call(scoresRoute, `/api/matches/${m.id}/scores`, { method: "POST", params: { id: m.id }, cookie: app.cookieFor(captain), rawBody: "{not json" }), 400, "bad_request");
      expectFailure(await submit("nope", captain, typed(A_WINS, "a")), 404, "not_found");
    });

    it("rejects an illegal scoreline with illegal_scoreline naming the set", async () => {
      const m = at(13);
      const res = await submit(m.id, captainOf(m.teamAId), [{ setNumber: 1, usPoints: 21, themPoints: 20 }]);
      const err = expectFailure(res, 400, "bad_request");
      expect(err.message).toBe("Set 1: Sets are won by 2; 21–20 is not a finished set.");
      expect(err.detail).toEqual({ code: "illegal_scoreline", setNumber: 1, bestOf: "3" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("walks a match from first submission to agreement, answering with the consensus and the final match", async () => {
      const m = at(13);
      const first = await submit(m.id, captainOf(m.teamAId), typed(A_WINS, "a"));
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({ outcome: "awaiting_second", replaced: false, perspective: "a" });
      expect(first.body.data.consensus.state).toBe("awaiting_second");
      expect(first.body.data.match.match.status).toBe("awaiting_scores");
      expect(first.body.data.consensus.live).toHaveLength(1);

      // The public match read shows the consensus state and no agreed sets yet.
      const mid = await app.call<Envelope<{ consensusState: string; sets: unknown[] }>>(getMatch, `/api/matches/${m.id}`, { params: { id: m.id } });
      expect(mid.body.data.consensusState).toBe("awaiting_second");

      const second = await submit(m.id, captainOf(m.teamBId), typed(A_WINS, "b"));
      expect(second.status).toBe(201);
      expect(second.body.data).toMatchObject({ outcome: "agreed", perspective: "b" });
      expect(second.body.data.consensus.state).toBe("agreed");
      expect(second.body.data.match.match.status).toBe("final");
      expect(second.body.data.match.match.winnerTeamId).toBe(m.teamAId);
      expect(second.body.data.match.sets.map((s) => s.agreed)).toEqual([true, true]);
      expect(JSON.stringify(second.body)).not.toMatch(/idempotencyKey/);

      const again = await submit(m.id, captainOf(m.teamBId), typed(A_WINS, "b"));
      expect(expectFailure(again, 409, "conflict").detail).toMatchObject({ code: "already_submitted_by_team", state: "agreed" });
    });

    it("answers a disagreement with both scorelines and the differing set", async () => {
      const m = at(13);
      await submit(m.id, captainOf(m.teamAId), typed(A_WINS, "a"));
      const other: SetScore[] = [A_WINS[0]!, { setNumber: 2, teamAPoints: 21, teamBPoints: 14 }];
      const res = await submit(m.id, captainOf(m.teamBId), typed(other, "b"));
      expect(res.status).toBe(201);
      expect(res.body.data.outcome).toBe("disputed");
      expect(res.body.data.consensus.live.map((s) => s.sets)).toEqual([A_WINS, other]);
      expect(res.body.data.consensus.differences.map((d) => d.setNumber)).toEqual([2]);
      expect(res.body.data.consensus.disputedReason).toBe("Set 2 differs: 21–16 vs 21–14");
      expect(res.body.data.match.match.status).toBe("disputed");
      const blocked = await submit(m.id, captainOf(m.teamAId), typed(A_WINS, "a"));
      expect(expectFailure(blocked, 409, "conflict").detail).toMatchObject({ code: "already_submitted_by_team", state: "disputed" });
    });

    it("takes a scheduled match on the sand with its first submission, and refuses a settled one", async () => {
      const m = at(15);
      app.conn.db.update(matches).set({ teamAId: at(13).teamAId, teamBId: at(13).teamBId }).where(eq(matches.id, m.id)).run();
      const first = await submit(m.id, captainOf(at(13).teamAId), typed(A_WINS, "a"));
      expect(first.status).toBe(201);
      expect(first.body.data.match.match.status).toBe("awaiting_scores");

      app.conn.db.update(matches).set({ status: "forfeited", winnerTeamId: at(13).teamBId }).where(eq(matches.id, m.id)).run();
      const res = await submit(m.id, captainOf(at(13).teamBId), typed(A_WINS, "b"));
      expect(expectFailure(res, 409, "conflict").detail).toEqual({ code: "match_not_open", status: "forfeited" });
    });
  });

  describe("GET /api/admin/disputes and POST /api/admin/matches/:id/resolve", () => {
    it("gates on the organizer role", async () => {
      const player = app.cookieFor(app.player().id);
      expectFailure(await app.call(listDisputesRoute, "/api/admin/disputes"), 401, "unauthorized");
      expectFailure(await app.call(listDisputesRoute, "/api/admin/disputes", { cookie: player }), 403, "forbidden");
      const m = at(11);
      expectFailure(await app.call(resolveRoute, `/api/admin/matches/${m.id}/resolve`, { method: "POST", params: { id: m.id }, cookie: player, body: { sets: A_WINS } }), 403, "forbidden");
    });

    it("lists the seeded dispute with both scorelines, then resolves it with attribution", async () => {
      const m = at(11);
      type Queue = { disputes: Array<{ match: Match; roundLabel: string; teamA: { name: string }; consensus: { differences: Array<{ setNumber: number }>; live: Array<{ teamId: string | null }> } }> };
      const list = await app.call<Envelope<Queue>>(listDisputesRoute, "/api/admin/disputes", { cookie: organizerCookie });
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("no-store");
      expect(list.body.data.disputes.map((d) => d.match.id)).toEqual([m.id]);
      expect(list.body.data.disputes[0]).toMatchObject({ roundLabel: "Quarterfinals", teamA: { name: expect.any(String) } });
      expect(list.body.data.disputes[0]?.consensus.differences.map((d) => d.setNumber)).toEqual([3]);
      expect(list.body.data.disputes[0]?.consensus.live.map((s) => s.teamId).sort()).toEqual([m.teamAId, m.teamBId].sort());
      const filtered = await app.call<Envelope<Queue>>(listDisputesRoute, `/api/admin/disputes?tournamentId=${app.tournament(SLUGS.settled).id}`, { cookie: organizerCookie });
      expect(filtered.body.data.disputes).toEqual([]);

      const illegal = await app.call(resolveRoute, `/api/admin/matches/${m.id}/resolve`, { method: "POST", params: { id: m.id }, cookie: organizerCookie, body: { sets: [A_WINS[0]] } });
      expect(expectFailure(illegal, 400, "bad_request").detail).toMatchObject({ code: "illegal_scoreline" });
      const shape = await app.call(resolveRoute, `/api/admin/matches/${m.id}/resolve`, { method: "POST", params: { id: m.id }, cookie: organizerCookie, body: { sets: typed(A_WINS, "a") } });
      expectFailure(shape, 400, "bad_request");

      const resolved = await app.call<Envelope<SubmitData>>(resolveRoute, `/api/admin/matches/${m.id}/resolve`, { method: "POST", params: { id: m.id }, cookie: organizerCookie, body: { sets: A_WINS } });
      expect(resolved.status).toBe(200);
      expect(resolved.body.data.consensus.state).toBe("agreed");
      expect(resolved.body.data.consensus.resolvedBy).toMatchObject({ userId: app.organizer().id });
      expect(resolved.body.data.match.match.status).toBe("final");
      expect(resolved.body.data.match.match.winnerTeamId).toBe(m.teamAId);
      expect((await app.call<Envelope<Queue>>(listDisputesRoute, "/api/admin/disputes", { cookie: organizerCookie })).body.data.disputes).toEqual([]);

      const twice = await app.call(resolveRoute, `/api/admin/matches/${m.id}/resolve`, { method: "POST", params: { id: m.id }, cookie: organizerCookie, body: { sets: A_WINS } });
      expect(expectFailure(twice, 409, "conflict").detail).toMatchObject({ code: "invalid_transition", state: "agreed" });
      expectFailure(await app.call(resolveRoute, "/api/admin/matches/nope/resolve", { method: "POST", params: { id: "nope" }, cookie: organizerCookie, body: { sets: A_WINS } }), 404, "not_found");
    });
  });

  describe("GET …/close/preview and POST …/close", () => {
    it("gates on the organizer role and validates the hash", async () => {
      const player = app.cookieFor(app.player().id);
      expectFailure(await preview(live.id, ""), 401, "unauthorized");
      expectFailure(await preview(live.id, player), 403, "forbidden");
      expectFailure(await close(live.id, "a".repeat(64), player), 403, "forbidden");
      expectFailure(await close(live.id, "not-a-hash"), 400, "bad_request");
      expectFailure(await preview("nope"), 404, "not_found");
    });

    it("previews with the blocking list, refuses close_blocked and preview_stale, then closes", async () => {
      const first = await preview(live.id);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(first.body.data.blockers).toHaveLength(5);
      expect(first.body.data.standingsProvisional).toBe(true);
      const blocked = await close(live.id, first.body.data.previewHash);
      const err = expectFailure(blocked, 409, "conflict");
      expect(err.detail).toMatchObject({ code: "close_blocked" });
      expect((err.detail as { blockers: Array<{ matchId: string }> }).blockers.map((b) => b.matchId).sort()).toEqual(first.body.data.blockers.map((b) => b.matchId).sort());

      // Clear every blocker through the routes.
      await app.call(resolveRoute, `/api/admin/matches/${at(11).id}/resolve`, { method: "POST", params: { id: at(11).id }, cookie: organizerCookie, body: { sets: A_WINS } });
      const twelve = at(12);
      const aTyped = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
      await submit(twelve.id, captainOf(twelve.teamBId), aTyped.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })));
      await submit(at(13).id, captainOf(at(13).teamAId), typed(A_WINS, "a"));
      await submit(at(13).id, captainOf(at(13).teamBId), typed(A_WINS, "b"));
      for (const position of [14, 15]) {
        const m = at(position);
        const res = await app.call(forfeitRoute, `/api/admin/matches/${m.id}/forfeit`, { method: "POST", params: { id: m.id }, cookie: organizerCookie, body: { teamId: m.teamBId } });
        expect(res.status).toBe(200);
      }

      const clean = await preview(live.id);
      expect(clean.body.data.blockers).toEqual([]);
      expect(clean.body.data.standingsProvisional).toBe(false);
      expect(clean.body.data.standings[0]?.placement).toBe(1);
      expect(clean.body.data.previewHash).not.toBe(first.body.data.previewHash);

      const stale = await close(live.id, first.body.data.previewHash);
      expect(expectFailure(stale, 409, "conflict").detail).toEqual({ code: "preview_stale", previewHash: clean.body.data.previewHash });

      const done = await close(live.id, clean.body.data.previewHash);
      expect(done.status).toBe(200);
      expect(done.body.data.detail.tournament.status).toBe("awaiting_settlement");
      expect(done.body.data.frozen.previewHash).toBe(clean.body.data.previewHash);
      expect(done.body.data.settlement).toEqual({ state: "not_available" });
      expect(JSON.stringify(done.body)).not.toMatch(/lucra_backend|LUCRA_BACKEND/i);
    });
  });
});
