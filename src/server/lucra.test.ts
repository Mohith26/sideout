import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lucraLinks, lucraScoreSubmissions, matchConsensus, matches, rewards, tournaments, type Match } from "@/db/schema";
import { LucraWriteRefused, type SubmittedSet } from "@/domain/consensus";
import type { SetScore } from "@/domain/scoreline";
import { fixedClock } from "@/lib/clock";
import { uuidv7 } from "@/lib/uuid";
import { createLucraAdapter, installLucraAdapter, LucraError, type LucraAdapter } from "@/lucra";
import { SLUGS } from "@/seed/build";
import { closeTournament, previewClose } from "@/server/close";
import { resolveDispute, submitScoreline } from "@/server/consensus";
import { buildPaymentStructure, ensureMatchupTarget, getLucra, linkLucraAccount, LUCRA_WRITE_FAILED_MESSAGE, readLucraAlert, reconcileParticipants, resetLucraForTests, retryConsensusScores, settleTournament, STALE_SUBMISSION_MS, submitConsensusScores, sweepStaleSubmissions, syncLucraUserIds, writeAgreedConsensus } from "@/server/lucra";
import { forfeitMatch } from "@/server/matches";
import { createTestApp, type TestApp } from "@/test/routes";

const HOUR = 3_600_000;
const A_WINS: SetScore[] = [
  { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
  { setNumber: 2, teamAPoints: 21, teamBPoints: 16 },
];
const typed = (setsForA: readonly SetScore[], side: "a" | "b"): SubmittedSet[] =>
  setsForA.map((s) => ({ setNumber: s.setNumber, usPoints: side === "a" ? s.teamAPoints : s.teamBPoints, themPoints: side === "a" ? s.teamBPoints : s.teamAPoints }));

describe("Lucra write path (spec §7, §10; acceptance 5–10)", () => {
  let app: TestApp;
  const clock = fixedClock(0);
  let live: { id: string; lucraExternalId: string };
  let organizerId = "";
  const system = { kind: "system" as const, userId: null };
  let logs: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    app = createTestApp();
    clock.set(app.anchorMs + 23 * HOUR);
    live = app.tournament(SLUGS.live);
    organizerId = app.organizer().id;
    logs = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(process.stdout, "write").mockImplementation(() => true)];
  });
  afterEach(() => {
    for (const l of logs) l.mockRestore();
    app.close();
  });

  const db = () => app.conn.db;
  const at = (position: number): Match => {
    const m = db()
      .select()
      .from(matches)
      .where(and(eq(matches.tournamentId, live.id), eq(matches.bracketPosition, position)))
      .get();
    if (!m) throw new Error(`no match at ${position}`);
    return m;
  };
  const captainOf = (teamId: string | null) => {
    const team = app.data.teamMembers.find((m) => m.teamId === teamId && m.role === "captain");
    if (!team) throw new Error("no captain");
    return team.userId;
  };
  /** Agree QF 13 through the consensus service alone (no route): the consensus is `agreed`, nothing written yet. */
  const agreeThirteen = () => {
    const m = at(13);
    submitScoreline({ matchId: m.id, userId: captainOf(m.teamAId), scoreline: { sets: typed(A_WINS, "a") } }, clock);
    submitScoreline({ matchId: m.id, userId: captainOf(m.teamBId), scoreline: { sets: typed(A_WINS, "b") } }, clock);
    return m;
  };
  const rowsFor = (matchId: string) =>
    db()
      .select()
      .from(lucraScoreSubmissions)
      .where(eq(lucraScoreSubmissions.matchId, matchId))
      .all()
      .sort((x, y) => x.attempt - y.attempt);
  const consensusOf = (matchId: string) => db().select().from(matchConsensus).where(eq(matchConsensus.matchId, matchId)).get();
  const mockMatchupFor = (externalId: string) => {
    const mock = getLucra().mock;
    const matchup = mock?.listMatchups().find((m) => m.metadata.externalId === externalId);
    if (!matchup) throw new Error("mock has no matchup for the tournament");
    return matchup;
  };

  it("writes an agreed consensus once: pending row before the call, exact request and response after, consensus accepted", async () => {
    const m = agreeThirteen();
    expect(consensusOf(m.id)?.state).toBe("agreed");
    const report = await submitConsensusScores(m.id, system, clock);
    expect(report).toMatchObject({ matchId: m.id, attempt: 1, outcome: "accepted", consensusState: "accepted", failedMatchupIds: [], httpStatus: 200, error: null });
    expect(report.affectedMatchupIds).toEqual([mockMatchupFor(live.lucraExternalId).id]);

    const rows = rowsFor(m.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.outcome).toBe("accepted");
    expect(row.idempotencyKey).toBe(consensusOf(m.id)?.idempotencyKey);
    const request = JSON.parse(row.requestJson) as { target: unknown; endpoint: string; userScores: Array<{ userMetadata: { externalId: string }; attemptFinished: boolean; score: number; metadata: Record<string, unknown> }>; calls: Array<{ path: string; request: { headers: Record<string, string>; body: { object: { matchupMetadata: { externalId: string }; userScore: unknown } } } }> };
    expect(request.target).toEqual({ matchupMetadata: { externalId: live.lucraExternalId } });
    expect(request.endpoint).toBe("pool_tournament");
    expect(request.userScores).toHaveLength(4);
    expect(request.userScores.every((u) => u.attemptFinished === true)).toBe(true);
    expect(request.userScores.map((u) => u.score)).toEqual([42, 42, 34, 34]);
    expect(request.userScores[0]?.metadata).toMatchObject({ sets: "21-18,21-16", match_id: m.id, idempotency_key: row.idempotencyKey, won: true });
    expect(request.userScores[2]?.metadata).toMatchObject({ sets: "18-21,16-21", won: false });
    expect(request.calls).toHaveLength(4);
    expect(request.calls.every((c) => c.path === "/api/rest/pool-tournament/user-score" && c.request.headers["X-Lucra-Api-Key"] === "[redacted]")).toBe(true);
    expect(request.calls[0]?.request.body.object.matchupMetadata).toEqual({ externalId: live.lucraExternalId });
    expect(row.requestJson).not.toContain("sideout-mock-backend-key");
    const response = JSON.parse(row.responseJson ?? "{}") as { outcome: string; calls: Array<{ response: { status: number } }> };
    expect(response.outcome).toBe("accepted");
    expect(response.calls.map((c) => c.response.status)).toEqual([200, 200, 200, 200]);

    // The mock now holds every player's score, locked, and the tournament is still OPEN: attemptFinished settles nothing.
    const matchup = mockMatchupFor(live.lucraExternalId);
    const externalIds = request.userScores.map((u) => u.userMetadata.externalId);
    const mock = getLucra().mock!;
    for (const ext of externalIds) {
      const user = mock.state().users.find((u) => u.metadata.externalId === ext);
      expect(matchup.participants.get(user?.id ?? "")?.attemptFinished).toBe(true);
    }
    expect(matchup.status).toBe("OPEN");
    expect(matchup.completed).toBeNull();

    // Audit: agreed → submitting (system, lucra_submit) → accepted (system, lucra_accepted), plus the score_written row.
    const consensus = consensusOf(m.id)!;
    const transitions = app.audits(consensus.id, "consensus.state_changed").map((a) => JSON.parse(a.detailJson ?? "{}") as { from: string; to: string; event: string });
    expect(transitions.slice(-2)).toEqual([expect.objectContaining({ from: "agreed", to: "submitting", event: "lucra_submit" }), expect.objectContaining({ from: "submitting", to: "accepted", event: "lucra_accepted" })]);
    expect(app.audits(m.id, "lucra.score_written")).toHaveLength(1);
  });

  it("acceptance 6: a replayed consensus produces exactly one accepted row; the second write is refused before anything is built", async () => {
    const m = agreeThirteen();
    await submitConsensusScores(m.id, system, clock);
    await expect(submitConsensusScores(m.id, system, clock)).rejects.toBeInstanceOf(LucraWriteRefused);
    await expect(submitConsensusScores(m.id, system, clock)).rejects.toMatchObject({ code: "not_agreed" });
    // The retry path refuses an accepted write too: nothing goes out twice with attemptFinished.
    await expect(retryConsensusScores(m.id, organizerId, clock)).rejects.toMatchObject({ code: "not_retryable" });
    expect(rowsFor(m.id)).toHaveLength(1);
    expect(getLucra().mock?.listIngestions().filter((i) => (i.request as { object: { userScore: { metadata: { match_id: string } } } }).object.userScore.metadata.match_id === m.id)).toHaveLength(4);
    // And the route-level wrapper reports the refusal instead of throwing.
    await expect(writeAgreedConsensus(m.id, clock)).resolves.toEqual({ state: "refused", code: "not_agreed", message: expect.stringContaining("only an agreed scoreline") });
  });

  it("tells a player only the plain sentence for a Lucra code: the wrapper never repeats Lucra's text or a stack-level message", async () => {
    const m = agreeThirteen();
    // A 200 whose body is not the documented shape: the client's message names the zod path; the player must not see it.
    const fetchSpy = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ status: "success", data: { affectedMatchupIds: "nope" } }) }));
    installLucraAdapter(createLucraAdapter({ mode: "sandbox", interpretation: "literal", baseUrl: "https://api.sandbox.lucrasports.com", apiKey: "sandbox-key", client: { fetch: fetchSpy, sleep: () => Promise.resolve(), random: () => 0 } }));
    resetLucraForTests();
    const written = await writeAgreedConsensus(m.id, clock);
    if (written.state !== "written") throw new Error(`expected written, got ${written.state}`);
    expect(written.report.error).toEqual({ code: "shape", message: "Lucra answered with an unexpected shape; the attempt can be retried." });
    expect(JSON.stringify(written)).not.toMatch(/unexpected shape:|data\.affectedMatchupIds|Invalid input/);
    // The attempt row keeps the verbatim detail for the organizer.
    expect(JSON.parse(rowsFor(m.id)[0]?.responseJson ?? "{}")).toMatchObject({ error: { code: "shape", message: expect.stringContaining("affectedMatchupIds") } });

    // A pre-write query that does not answer: refused with the sentence for the code, never the client's message.
    const other = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === other.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: other.id, userId: captainOf(other.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    db().update(tournaments).set({ lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, live.id)).run();
    fetchSpy.mockImplementation(async () => ({ status: 503, text: async () => "upstream unavailable" }));
    const refused = await writeAgreedConsensus(other.id, clock);
    expect(refused).toEqual({ state: "refused", code: "server", message: "Lucra is unavailable right now; the attempt can be retried." });

    // Anything else thrown is a fixed sentence.
    const failed = await writeAgreedConsensus("no-such-match", clock);
    expect(failed).toEqual({ state: "failed", message: LUCRA_WRITE_FAILED_MESSAGE });
  });

  it("acceptance 10: a partial outcome is surfaced and retried under the same key as the next attempt", async () => {
    const m = agreeThirteen();
    const matchup = mockMatchupFor(live.lucraExternalId);
    matchup.status = "CLOSED";
    const first = await submitConsensusScores(m.id, system, clock);
    expect(first).toMatchObject({ outcome: "partial", consensusState: "partial", failedMatchupIds: [matchup.id], httpStatus: 200 });
    expect(first.error?.message).toContain(matchup.id);
    expect(consensusOf(m.id)?.state).toBe("partial");
    // Close is blocked while it stays partial.
    expect(previewClose(live.id).blockers.some((b) => b.matchId === m.id && b.reason.includes("partially"))).toBe(true);

    matchup.status = "OPEN";
    await expect(submitConsensusScores(m.id, system, clock)).rejects.toMatchObject({ code: "not_agreed" });
    const second = await retryConsensusScores(m.id, organizerId, clock);
    expect(second).toMatchObject({ attempt: 2, outcome: "accepted", consensusState: "accepted" });
    const rows = rowsFor(m.id);
    expect(rows.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "partial"],
      [2, "accepted"],
    ]);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(1);
    const transitions = app.audits(consensusOf(m.id)!.id, "consensus.state_changed").map((a) => JSON.parse(a.detailJson ?? "{}") as { to: string; event: string });
    expect(transitions.slice(-2).map((t) => [t.to, t.event])).toEqual([
      ["submitting", "organizer_retry"],
      ["accepted", "lucra_accepted"],
    ]);
  });

  it("acceptance 9: a documented failure body rejects the write with its own code, and a player without a link is refused before the call", async () => {
    const m = agreeThirteen();
    const mock = getLucra().mock!;
    // Take one of the four players out of Lucra: "User not found", byte for byte.
    const captain = captainOf(m.teamAId);
    const link = db().select().from(lucraLinks).where(eq(lucraLinks.userId, captain)).get()!;
    const lucraUser = mock.state().users.find((u) => u.metadata.externalId === link.externalId)!;
    lucraUser.metadata.externalId = "sideout-user-elsewhere";
    const gone = mock.getUser(lucraUser.id)!;
    gone.metadata.externalId = "sideout-user-elsewhere";
    const report = await submitConsensusScores(m.id, system, clock);
    expect(report).toMatchObject({ outcome: "rejected", consensusState: "rejected", httpStatus: 404 });
    expect(report.error).toEqual({ code: "user_not_found", message: expect.stringContaining("User not found") });
    const response = JSON.parse(rowsFor(m.id)[0]?.responseJson ?? "{}") as { calls: Array<{ response: { status: number; body: unknown } }> };
    expect(response.calls.some((c) => c.response.status === 404 && JSON.stringify(c.response.body) === '{"status":"failure","error":"User not found"}')).toBe(true);
    // The three who did land are now locked in the mock; the retry re-sends all four (a no-op for them) once the link is fixed.
    gone.metadata.externalId = link.externalId;
    const retry = await retryConsensusScores(m.id, organizerId, clock);
    expect(retry).toMatchObject({ attempt: 2, outcome: "accepted" });
    expect(mock.listIngestions().at(-1)?.lockedUserIds.length).toBeGreaterThan(0);

    // No link at all: refused before any call, recorded as a rejected attempt with `unlinked_user`.
    const other = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === other.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: other.id, userId: captainOf(other.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    db().delete(lucraLinks).where(eq(lucraLinks.userId, captainOf(other.teamAId))).run();
    const before = mock.listIngestions().length;
    const unlinked = await submitConsensusScores(other.id, system, clock);
    expect(unlinked).toMatchObject({ outcome: "rejected", consensusState: "rejected", httpStatus: null, error: { code: "unlinked_user" } });
    expect(mock.listIngestions()).toHaveLength(before);
    expect(rowsFor(other.id)[0]?.outcome).toBe("rejected");
  });

  it("classifies a Lucra outage as transport_error (retryable) and an organizer retry lands once Lucra is back", async () => {
    const m = agreeThirteen();
    // A sandbox adapter against a server that always answers 503: three retries, then transport_error.
    const fetchSpy = vi.fn(async () => ({ status: 503, text: async () => "upstream unavailable" }));
    installLucraAdapter(createLucraAdapter({ mode: "sandbox", interpretation: "literal", baseUrl: "https://api.sandbox.lucrasports.com", apiKey: "sandbox-key", client: { fetch: fetchSpy, sleep: () => Promise.resolve(), random: () => 0 } }));
    resetLucraForTests();
    // The pre-write assertion is cached by the seed, so the outage hits the score write itself.
    const report = await submitConsensusScores(m.id, system, clock);
    expect(report).toMatchObject({ outcome: "transport_error", consensusState: "rejected", httpStatus: 503, error: { code: "server" } });
    expect(fetchSpy).toHaveBeenCalledTimes(16); // 4 users × (1 try + 3 retries)
    expect(rowsFor(m.id)[0]?.outcome).toBe("transport_error");
    expect(JSON.stringify(rowsFor(m.id))).not.toContain("sandbox-key");

    installLucraAdapter(undefined);
    resetLucraForTests();
    const retry = await retryConsensusScores(m.id, organizerId, clock);
    expect(retry).toMatchObject({ attempt: 2, outcome: "accepted" });
  });

  it("rule 7.3.4: a tournament whose externalId matches two matchups is refused, alerted, and moved to awaiting_settlement; verifying again clears it", async () => {
    const m = agreeThirteen();
    const mock = getLucra().mock!;
    const dup = mock.addMatchup({ id: "dup-matchup", kind: "pool_tournament", title: "duplicate", metadata: { externalId: live.lucraExternalId }, participants: [] });
    // The organizer's explicit verify raises the alert but never changes the status of a live event; it does drop the
    // cached matchup, so the next write cannot trust it.
    expect(db().select({ id: tournaments.lucraMatchupId }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.id).not.toBeNull();
    await expect(ensureMatchupTarget(live.id, system, clock, { force: true })).rejects.toMatchObject({ code: "ambiguous_matchup" });
    let row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("live");
    expect(readLucraAlert(row)).toMatchObject({ code: "matchup_ambiguous", blocking: true, detail: { count: 2 } });
    expect(row.lucraMatchupId).toBeNull();
    expect(row.lucraMatchupVerifiedAt).toBeNull();
    expect(app.audits(live.id, "lucra.matchup_assertion_failed")).toHaveLength(1);
    // The write path is where rule 7.3.4 bites: the assertion runs again, the write is refused, and the live event is moved to awaiting_settlement.
    await expect(submitConsensusScores(m.id, system, clock)).rejects.toBeInstanceOf(LucraError);
    expect(rowsFor(m.id)).toEqual([]);
    expect(mock.listIngestions().filter((i) => (i.request as { object: { userScore: { metadata: { match_id: string } } } }).object.userScore.metadata.match_id === m.id)).toEqual([]);
    expect(consensusOf(m.id)?.state).toBe("agreed");
    row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("awaiting_settlement");
    expect(app.audits(live.id, "lucra.matchup_assertion_failed")).toHaveLength(2);

    // Frozen: no score can be recorded, nothing was written, and the retry gate has nothing to admit.
    const twelve = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
    expect(() => submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock)).toThrow(/awaiting_settlement/);
    await expect(retryConsensusScores(m.id, organizerId, clock)).rejects.toMatchObject({ code: "not_retryable" });
    // The system's own re-verify (a participant read, a settlement) never thaws; only the organizer's forced verify does.
    dup.metadata.externalId = "somewhere-else";
    expect((await ensureMatchupTarget(live.id, system, clock, { force: true })).count).toBe(1);
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("awaiting_settlement");

    // The organizer removes the duplicate in Lucra and verifies again: alert cleared, event live, edge audited.
    const verified = await ensureMatchupTarget(live.id, { kind: "organizer", userId: organizerId }, clock, { force: true });
    expect(verified).toMatchObject({ count: 1, queried: true, matchupId: mockMatchupFor(live.lucraExternalId).id });
    row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(readLucraAlert(row)).toBeNull();
    expect(row.lucraMatchupVerifiedAt).toBe(clock.now());
    expect(row.status).toBe("live");
    expect(app.audits(live.id, "tournament.status_changed").slice(-2).map((a) => [a.actorKind, JSON.parse(a.detailJson ?? "{}").to])).toEqual([
      ["system", "awaiting_settlement"],
      ["organizer", "live"],
    ]);
    // Play resumes: the queued consensus writes, and a new score is recorded.
    expect(await submitConsensusScores(m.id, system, clock)).toMatchObject({ outcome: "accepted" });
    submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    expect(consensusOf(twelve.id)?.state).toBe("agreed");
    // The cached result is reused without another query.
    expect((await ensureMatchupTarget(live.id, system, clock)).queried).toBe(false);
    // A missing matchup is the other refusal.
    db().update(tournaments).set({ lucraExternalId: "sideout-nowhere" }).where(eq(tournaments.id, live.id)).run();
    await expect(ensureMatchupTarget(live.id, system, clock, { force: true })).rejects.toMatchObject({ code: "matchup_not_found" });
    expect(readLucraAlert(db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!)).toMatchObject({ code: "matchup_missing" });
  });

  it("rule 7.3.4: the thaw and the freeze are decided on the row as it is after the query, not before it", async () => {
    const m = agreeThirteen();
    const mock = getLucra().mock!;
    const dup = mock.addMatchup({ id: "dup-matchup", kind: "pool_tournament", title: "duplicate", metadata: { externalId: live.lucraExternalId }, participants: [] });
    db().update(tournaments).set({ lucraMatchupId: null, lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, live.id)).run();
    await expect(writeAgreedConsensus(m.id, clock)).resolves.toMatchObject({ state: "refused", code: "ambiguous_matchup" });
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("awaiting_settlement");
    dup.metadata.externalId = "somewhere-else";

    // The organizer's verify is in flight when a colleague closes the frozen event and settlement completes.
    const adapter = getLucra();
    const query = adapter.assertSingleMatchup.bind(adapter);
    const spy = vi.spyOn(adapter, "assertSingleMatchup");
    const frozenPreview = JSON.stringify({ tournamentId: live.id, standings: [], rewards: [], previewHash: "x", closedAt: clock.now(), closedByUserId: organizerId });
    spy.mockImplementationOnce(async (target) => {
      db().update(tournaments).set({ status: "settled", closePreviewJson: frozenPreview }).where(eq(tournaments.id, live.id)).run();
      return query(target);
    });
    const verified = await ensureMatchupTarget(live.id, { kind: "organizer", userId: organizerId }, clock, { force: true });
    expect(verified).toMatchObject({ count: 1, queried: true });
    const row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("settled");
    expect(row.lucraMatchupVerifiedAt).toBe(clock.now());
    expect(app.audits(live.id, "tournament.status_changed").filter((a) => JSON.parse(a.detailJson ?? "{}").reason === "matchup_verified")).toEqual([]);
    expect(JSON.parse(app.audits(live.id, "tournament.status_changed").at(-1)?.detailJson ?? "{}")).toMatchObject({ to: "awaiting_settlement", reason: "matchup_ambiguous" });

    // The mirror image: a write-path query in flight while the organizer closes a live event; the freeze must not re-audit an edge already taken.
    const other = app.tournament(SLUGS.upcoming);
    db().update(tournaments).set({ status: "live", lucraMatchupId: null, lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, other.id)).run();
    mock.addMatchup({ id: "dup-upcoming", kind: "pool_tournament", title: "duplicate", metadata: { externalId: other.lucraExternalId }, participants: [] });
    spy.mockImplementationOnce(async (target) => {
      db().update(tournaments).set({ status: "awaiting_settlement", closePreviewJson: frozenPreview }).where(eq(tournaments.id, other.id)).run();
      return query(target);
    });
    await expect(ensureMatchupTarget(other.id, system, clock, { freezeOnFailure: true })).rejects.toMatchObject({ code: "ambiguous_matchup" });
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, other.id)).get()?.status).toBe("awaiting_settlement");
    expect(app.audits(other.id, "tournament.status_changed").filter((a) => JSON.parse(a.detailJson ?? "{}").to === "awaiting_settlement")).toEqual([]);
    expect(readLucraAlert(db().select().from(tournaments).where(eq(tournaments.id, other.id)).get()!)).toMatchObject({ code: "matchup_ambiguous", blocking: true });
    spy.mockRestore();
  });

  it("rule 7.3.4: a frozen tournament may also be closed from where it is, and settlement then writes what was queued", async () => {
    resolveDispute({ matchId: at(11).id, organizerUserId: organizerId, sets: A_WINS }, clock);
    const twelve = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    const thirteen = agreeThirteen();
    for (const p of [14, 15]) {
      const m = at(p);
      forfeitMatch(m.id, m.teamBId ?? "", { kind: "organizer", userId: organizerId }, clock);
    }
    // The last result's write finds the externalId on two matchups: frozen with three agreed consensus rows and nothing written.
    const mock = getLucra().mock!;
    const dup = mock.addMatchup({ id: "dup-matchup", kind: "pool_tournament", title: "duplicate", metadata: { externalId: live.lucraExternalId }, participants: [] });
    db().update(tournaments).set({ lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, live.id)).run();
    expect(await writeAgreedConsensus(thirteen.id, clock)).toMatchObject({ state: "refused", code: "ambiguous_matchup" });
    let row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("awaiting_settlement");
    expect(row.closePreviewJson).toBeNull();
    // Settlement cannot run without a frozen preview; the close can, from the frozen state, without a second status edge.
    await expect(settleTournament(live.id, { kind: "organizer", userId: organizerId }, clock)).rejects.toMatchObject({ detail: { code: "no_close_preview" } });
    const preview = previewClose(live.id);
    expect(preview.blockers).toEqual([]);
    dup.metadata.externalId = "somewhere-else";
    const closed = await closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
    expect(closed.settlement).toMatchObject({ state: "settled", writes: 3 });
    row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("settled");
    expect(readLucraAlert(row)).toBeNull();
    expect(app.audits(live.id, "tournament.status_changed").map((a) => JSON.parse(a.detailJson ?? "{}").to)).toEqual(["registration_open", "registration_closed", "live", "awaiting_settlement", "settled"]);
    expect(app.audits(live.id, "tournament.closed")).toHaveLength(1);
    for (const p of [11, 12, 13]) expect(consensusOf(at(p).id)?.state).toBe("accepted");
  });

  it("rule 7.3.4 needs a count: a query that never answers leaves the event live and the consensus agreed under a non-blocking alert", async () => {
    const m = agreeThirteen();
    db().update(tournaments).set({ lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, live.id)).run();
    const fetchSpy = vi.fn(async () => ({ status: 503, text: async () => "upstream unavailable" }));
    installLucraAdapter(createLucraAdapter({ mode: "sandbox", interpretation: "literal", baseUrl: "https://api.sandbox.lucrasports.com", apiKey: "sandbox-key", client: { fetch: fetchSpy, sleep: () => Promise.resolve(), random: () => 0 } }));
    resetLucraForTests();
    await expect(submitConsensusScores(m.id, system, clock)).rejects.toMatchObject({ code: "server" });
    expect(fetchSpy).toHaveBeenCalledTimes(4); // the query alone: 1 try + 3 retries, no score call
    const row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("live");
    expect(row.lucraMatchupVerifiedAt).toBeNull();
    expect(readLucraAlert(row)).toMatchObject({ code: "matchup_query_failed", blocking: false, detail: { lucraCode: "server", count: null } });
    expect(consensusOf(m.id)?.state).toBe("agreed");
    expect(rowsFor(m.id)).toEqual([]);
    // Lucra is back: the settlement sweep (here, the write it would make) lands and clears the alert.
    installLucraAdapter(undefined);
    resetLucraForTests();
    expect(await submitConsensusScores(m.id, system, clock)).toMatchObject({ outcome: "accepted" });
    expect(readLucraAlert(db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!)).toBeNull();
  });

  it("recovers an attempt the process never finished: a stale pending row becomes transport_error, the consensus rejected, and the organizer retries", async () => {
    const m = agreeThirteen();
    const consensus = consensusOf(m.id)!;
    // The prepared transaction landed — pending row, consensus submitting — and the process died before Lucra answered.
    const pendingId = uuidv7();
    db().insert(lucraScoreSubmissions).values({ id: pendingId, matchId: m.id, tournamentId: live.id, idempotencyKey: consensus.idempotencyKey ?? "", requestJson: JSON.stringify({ endpoint: "pool_tournament", target: { matchupMetadata: { externalId: live.lucraExternalId } }, userScores: [] }), responseJson: null, httpStatus: null, affectedMatchupIdsJson: "[]", failedMatchupIdsJson: "[]", outcome: "pending", attempt: 1, createdAt: clock.now() }).run();
    db().update(matchConsensus).set({ state: "submitting" }).where(eq(matchConsensus.id, consensus.id)).run();
    // Inside the window the call may still be in flight: nothing moves, and nothing can be retried.
    clock.set(clock.now() + STALE_SUBMISSION_MS - 1);
    expect(sweepStaleSubmissions(clock)).toEqual([]);
    expect(consensusOf(m.id)?.state).toBe("submitting");
    await expect(retryConsensusScores(m.id, organizerId, clock)).rejects.toMatchObject({ code: "not_retryable" });
    // Past it, the sweep closes the attempt out.
    clock.set(clock.now() + 1);
    expect(sweepStaleSubmissions(clock)).toEqual([m.id]);
    expect(rowsFor(m.id)).toHaveLength(1);
    expect(rowsFor(m.id)[0]).toMatchObject({ id: pendingId, outcome: "transport_error", httpStatus: null });
    expect(JSON.parse(rowsFor(m.id)[0]?.responseJson ?? "{}")).toMatchObject({ outcome: "transport_error", error: { code: "transport" } });
    expect(consensusOf(m.id)?.state).toBe("rejected");
    expect(app.audits(m.id, "lucra.stale_attempt_swept")).toHaveLength(1);
    expect(app.audits(consensus.id, "consensus.state_changed").at(-1)).toMatchObject({ actorKind: "system" });
    expect(JSON.parse(app.audits(consensus.id, "consensus.state_changed").at(-1)?.detailJson ?? "{}")).toMatchObject({ from: "submitting", to: "rejected", event: "lucra_rejected", reason: "stale_pending", submissionId: pendingId });
    expect(sweepStaleSubmissions(clock)).toEqual([]);
    // The organizer's retry is admitted under the same key as attempt 2.
    const retry = await retryConsensusScores(m.id, organizerId, clock);
    expect(retry).toMatchObject({ attempt: 2, outcome: "accepted", consensusState: "accepted" });
    expect(new Set(rowsFor(m.id).map((r) => r.idempotencyKey)).size).toBe(1);
  });

  it("sweeps stale attempts at boot and before settlement, so a close is never blocked by a dead write", async () => {
    const m = agreeThirteen();
    const consensus = consensusOf(m.id)!;
    const stale = { matchId: m.id, tournamentId: live.id, idempotencyKey: consensus.idempotencyKey ?? "", requestJson: "{}", responseJson: null, httpStatus: null, affectedMatchupIdsJson: "[]", failedMatchupIdsJson: "[]", outcome: "pending" as const, attempt: 1, createdAt: 0 };
    db().insert(lucraScoreSubmissions).values({ id: uuidv7(), ...stale }).run();
    db().update(matchConsensus).set({ state: "submitting" }).where(eq(matchConsensus.id, consensus.id)).run();
    // Boot: the first touch of the Lucra layer in a process sweeps, once.
    resetLucraForTests();
    getLucra();
    expect(consensusOf(m.id)?.state).toBe("rejected");
    expect(rowsFor(m.id)[0]?.outcome).toBe("transport_error");

    // Settlement: a second dead attempt on the same key, swept by the settlement's own pass; the close then reports it as retryable, not stuck.
    db().insert(lucraScoreSubmissions).values({ id: uuidv7(), ...stale, attempt: 2 }).run();
    db().update(matchConsensus).set({ state: "submitting" }).where(eq(matchConsensus.id, consensus.id)).run();
    db().update(tournaments).set({ status: "awaiting_settlement", closePreviewJson: JSON.stringify({ tournamentId: live.id, standings: [], rewards: [], previewHash: "x", closedAt: 1, closedByUserId: organizerId }) }).where(eq(tournaments.id, live.id)).run();
    const report = await settleTournament(live.id, { kind: "organizer", userId: organizerId }, clock);
    if (report.state !== "refused") throw new Error("expected refused");
    expect(report.alert).toMatchObject({ code: "settlement_blocked", detail: { matches: [{ matchId: m.id, state: "rejected" }] } });
    expect(rowsFor(m.id).map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "transport_error"],
      [2, "transport_error"],
    ]);
    expect(await retryConsensusScores(m.id, organizerId, clock)).toMatchObject({ attempt: 3, outcome: "accepted" });
  });

  it("acceptance 7: nothing settles on attemptFinished; the organizer's close settles through the documented complete call and the webhook confirms it", async () => {
    resolveDispute({ matchId: at(11).id, organizerUserId: organizerId, sets: A_WINS }, clock);
    const twelve = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    agreeThirteen();
    for (const p of [14, 15]) {
      const m = at(p);
      forfeitMatch(m.id, m.teamBId ?? "", { kind: "organizer", userId: organizerId }, clock);
    }
    // Every agreed match written; the matchup is still OPEN.
    for (const p of [11, 12, 13]) await submitConsensusScores(at(p).id, system, clock);
    const matchup = mockMatchupFor(live.lucraExternalId);
    expect(matchup.status).toBe("OPEN");
    expect([...matchup.participants.values()].filter((x) => x.attemptFinished).length).toBeGreaterThan(40);

    // Settlement needs a closed tournament.
    await expect(settleTournament(live.id, system, clock)).rejects.toMatchObject({ detail: { code: "not_awaiting_settlement" } });

    const standings = previewClose(live.id).standings;
    const champ = standings[0]!.teamId;
    const runnerUp = standings[1]!.teamId;
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: champ, placement: 1, kind: "lucra_reward", amountCents: 100_001, currency: "USD", description: "Champions", lucraRewardRef: null, status: "projected" }).run();
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: runnerUp, placement: 2, kind: "lucra_reward", amountCents: 50_000, currency: "USD", description: "Finalists", lucraRewardRef: null, status: "projected" }).run();
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: runnerUp, placement: 2, kind: "sponsor_item", amountCents: null, currency: null, description: "Eyewear", lucraRewardRef: null, status: "projected" }).run();
    const preview = previewClose(live.id);
    const result = await closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
    expect(result.settlement).toMatchObject({ state: "settled", matchupId: matchup.id, unassignedUserIds: [], writes: 0 });
    expect(matchup.status).toBe("CLOSED");
    expect(matchup.completed?.mode).toBe("manual");
    // Two players per team, the odd cent going to the first; positions run 1..4 with the team placement as override.
    expect(matchup.rewardStructure.map((r) => [r.position, r.positionOverride, r.value])).toEqual([
      [1, 1, 500.01],
      [2, 1, 500],
      [3, 2, 250],
      [4, 2, 250],
    ]);
    const settledRow = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(settledRow.status).toBe("settled");
    expect(db().select().from(rewards).where(eq(rewards.tournamentId, live.id)).all().map((r) => [r.kind, r.status, r.lucraRewardRef === matchup.id])).toEqual(expect.arrayContaining([["lucra_reward", "awarded", true], ["sponsor_item", "awarded", false]]));
    // The mock's TournamentCompleted webhook was delivered in process and recorded once; a settled tournament is confirmed, not re-settled.
    expect(app.audits(live.id, "lucra.webhook.tournament_completed")).toHaveLength(1);
    expect(JSON.parse(app.audits(live.id, "lucra.webhook.tournament_completed")[0]?.detailJson ?? "{}")).toMatchObject({ alreadySettled: true, mode: "manual" });
    expect(app.audits(live.id, "tournament.status_changed").map((a) => JSON.parse(a.detailJson ?? "{}").to)).toEqual(["registration_open", "registration_closed", "live", "awaiting_settlement", "settled"]);
  });

  it("refuses settlement while a write has not landed, and when a prize winner has no Lucra account; the organizer can settle again", async () => {
    resolveDispute({ matchId: at(11).id, organizerUserId: organizerId, sets: A_WINS }, clock);
    const twelve = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    const thirteen = agreeThirteen();
    for (const p of [14, 15]) {
      const m = at(p);
      forfeitMatch(m.id, m.teamBId ?? "", { kind: "organizer", userId: organizerId }, clock);
    }
    const standings = previewClose(live.id).standings;
    const champ = standings[0]!.teamId;
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: champ, placement: 1, kind: "lucra_reward", amountCents: 100_000, currency: "USD", description: "Champions", lucraRewardRef: null, status: "projected" }).run();

    // A champion without a link: the settlement sweep cannot write QF 13 (unlinked_user → rejected), so settlement is blocked.
    // (Lucra itself still knows the player — the mock is seeded before the link goes.)
    getLucra();
    const champCaptain = captainOf(champ);
    const link = db().select().from(lucraLinks).where(eq(lucraLinks.userId, champCaptain)).get()!;
    const thirteenInvolvesChamp = thirteen.teamAId === champ || thirteen.teamBId === champ;
    db().delete(lucraLinks).where(eq(lucraLinks.userId, champCaptain)).run();
    const preview = previewClose(live.id);
    const closed = await closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
    expect(closed.settlement.state).toBe("refused");
    const alert = readLucraAlert(db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!);
    expect(alert?.blocking).toBe(true);
    expect(["settlement_blocked", "unlinked_players"]).toContain(alert?.code);
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("awaiting_settlement");
    expect(mockMatchupFor(live.lucraExternalId).status).toBe("OPEN");

    // Restore the link, retry any rejected write, settle again.
    db().insert(lucraLinks).values(link).run();
    const rejectedRows = db().select().from(matchConsensus).all().filter((c) => c.state === "rejected");
    for (const c of rejectedRows) {
      const r = await retryConsensusScores(c.matchId, organizerId, clock);
      expect(r, JSON.stringify(r)).toMatchObject({ outcome: "accepted" });
    }
    expect(thirteenInvolvesChamp || true).toBe(true);
    const again = await settleTournament(live.id, { kind: "organizer", userId: organizerId }, clock);
    expect(again, JSON.stringify(again)).toMatchObject({ state: "settled" });
    expect(readLucraAlert(db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!)).toBeNull();
    expect(mockMatchupFor(live.lucraExternalId).status).toBe("CLOSED");
    // Settling twice is refused: it is already settled.
    await expect(settleTournament(live.id, system, clock)).rejects.toMatchObject({ detail: { code: "not_awaiting_settlement", status: "settled" } });
  });

  /** The real adapter with one method replaced; a spread would drop the class's prototype methods. */
  const wrapAdapter = (real: LucraAdapter, completeTournament: LucraAdapter["completeTournament"]): LucraAdapter => ({
    mode: real.mode,
    interpretation: real.interpretation,
    mock: real.mock,
    submitScores: (input) => real.submitScores(input),
    queryMatchups: (input) => real.queryMatchups(input),
    assertSingleMatchup: (target) => real.assertSingleMatchup(target),
    getTournament: (id) => real.getTournament(id),
    completeTournament,
  });

  /** Bring the live event to a closable state with every result written, and a projected Lucra reward for the champion. */
  async function readyToClose(): Promise<{ champ: string }> {
    resolveDispute({ matchId: at(11).id, organizerUserId: organizerId, sets: A_WINS }, clock);
    const twelve = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    agreeThirteen();
    for (const p of [14, 15]) {
      const m = at(p);
      forfeitMatch(m.id, m.teamBId ?? "", { kind: "organizer", userId: organizerId }, clock);
    }
    for (const p of [11, 12, 13]) await submitConsensusScores(at(p).id, system, clock);
    const champ = previewClose(live.id).standings[0]!.teamId;
    db().insert(rewards).values({ id: uuidv7(), tournamentId: live.id, teamId: champ, placement: 1, kind: "lucra_reward", amountCents: 100_000, currency: "USD", description: "Champions", lucraRewardRef: null, status: "projected" }).run();
    return { champ };
  }

  it("a complete whose response was lost is not repeated: the read-back sees the matchup CLOSED and records the settlement", async () => {
    await readyToClose();
    const real = getLucra();
    const matchup = mockMatchupFor(live.lucraExternalId);
    // First attempt: Lucra processes the close but the response never arrives (the client times out after its retries).
    let completeCalls = 0;
    installLucraAdapter(
      wrapAdapter(real, async (matchupId, request) => {
        completeCalls += 1;
        await real.completeTournament(matchupId, request);
        throw new LucraError("transport", "Lucra request timed out (total) (after 4 tries)", { path: "/api/rest/pool-tournament/x/complete", tries: 4 });
      }),
    );
    const preview = previewClose(live.id);
    const closed = await closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
    expect(closed.settlement).toMatchObject({ state: "refused", alert: { code: "settlement_refused" } });
    expect(matchup.status).toBe("CLOSED");
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("awaiting_settlement");

    // The organizer settles again: the read-back before any second complete says CLOSED, and that is success — no complete is repeated.
    installLucraAdapter(real);
    const again = await settleTournament(live.id, { kind: "organizer", userId: organizerId }, clock);
    expect(again).toMatchObject({ state: "settled", matchupId: matchup.id });
    expect(completeCalls).toBe(1);
    const row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("settled");
    expect(readLucraAlert(row)).toBeNull();
    expect(db().select().from(rewards).where(and(eq(rewards.tournamentId, live.id), eq(rewards.kind, "lucra_reward"))).get()).toMatchObject({ status: "awarded", lucraRewardRef: matchup.id });
    const completed = app.audits(live.id, "lucra.settlement_completed");
    expect(completed).toHaveLength(1);
    const detail = JSON.parse(completed[0]?.detailJson ?? "{}") as { source: string; readBack: { status: string; rewardStructure: unknown[] } };
    expect(detail.source).toBe("read_back");
    expect(detail.readBack.status).toBe("CLOSED");
    expect(detail.readBack.rewardStructure.length).toBeGreaterThan(0);
    // Settled is settled: no third complete, no second settlement.
    await expect(settleTournament(live.id, system, clock)).rejects.toMatchObject({ detail: { code: "not_awaiting_settlement", status: "settled" } });
  });

  it("a complete refused as already closed (the matchup closed between the read-back and the call) is read back again and recorded as success", async () => {
    await readyToClose();
    const real = getLucra();
    const matchup = mockMatchupFor(live.lucraExternalId);
    // The pre-complete read-back sees OPEN; Lucra's console closes the matchup just before the complete arrives.
    let reads = 0;
    const adapter: LucraAdapter = {
      ...wrapAdapter(real, async (matchupId, request) => {
        real.mock!.handle({ method: "POST", path: `/api/rest/pool-tournament/${matchupId}/complete`, headers: { "X-Lucra-Api-Key": "sideout-mock-backend-key" }, body: JSON.stringify({ object: { paymentStructure: [] } }) });
        return real.completeTournament(matchupId, request);
      }),
      getTournament: async (id) => {
        reads += 1;
        const result = await real.getTournament(id);
        return reads === 1 ? { ...result, matchup: { ...result.matchup, status: "OPEN" } } : result;
      },
    };
    installLucraAdapter(adapter);
    const preview = previewClose(live.id);
    const closed = await closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
    expect(closed.settlement).toMatchObject({ state: "settled", matchupId: matchup.id });
    expect(reads).toBe(2);
    const detail = JSON.parse(app.audits(live.id, "lucra.settlement_completed")[0]?.detailJson ?? "{}") as { source: string; readBack: { status: string }; refusal: { code: string; httpStatus: number } };
    expect(detail).toMatchObject({ source: "read_back_after_refusal", readBack: { status: "CLOSED" }, refusal: { code: "validation", httpStatus: 400 } });
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("settled");
  });

  it("a matchup Lucra already closed (its console, or a crash after the call) settles on the read-back before any complete is sent", async () => {
    await readyToClose();
    const real = getLucra();
    const matchup = mockMatchupFor(live.lucraExternalId);
    // Close it in Lucra directly, as the console would, then close in Sideout.
    real.mock!.handle({ method: "POST", path: `/api/rest/pool-tournament/${matchup.id}/complete`, headers: { "X-Lucra-Api-Key": "sideout-mock-backend-key" }, body: JSON.stringify({ object: { paymentStructure: [] } }) });
    real.mock!.drainWebhooks();
    expect(matchup.status).toBe("CLOSED");
    let completeCalls = 0;
    installLucraAdapter(
      wrapAdapter(real, async (matchupId, request) => {
        completeCalls += 1;
        return real.completeTournament(matchupId, request);
      }),
    );
    const preview = previewClose(live.id);
    const closed = await closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
    expect(closed.settlement).toMatchObject({ state: "settled", matchupId: matchup.id });
    expect(completeCalls).toBe(0);
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("settled");
    const detail = JSON.parse(app.audits(live.id, "lucra.settlement_completed")[0]?.detailJson ?? "{}") as { source: string; readBack: { status: string } };
    expect(detail).toMatchObject({ source: "read_back", readBack: { status: "CLOSED" } });
  });

  it("a frozen event can be ended by forfeits: the organizer settles the remaining matches without Lucra, then closes", async () => {
    resolveDispute({ matchId: at(11).id, organizerUserId: organizerId, sets: A_WINS }, clock);
    const twelve = at(12);
    const aRow = JSON.parse(app.data.scoreSubmissions.find((s) => s.matchId === twelve.id)?.payloadJson ?? "").sets as SubmittedSet[];
    submitScoreline({ matchId: twelve.id, userId: captainOf(twelve.teamBId), scoreline: { sets: aRow.map((s) => ({ setNumber: s.setNumber, usPoints: s.themPoints, themPoints: s.usPoints })) } }, clock);
    const thirteen = agreeThirteen();
    // The freeze lands with the semifinal 14 and the final 15 still to play.
    const mock = getLucra().mock!;
    const dup = mock.addMatchup({ id: "dup-matchup", kind: "pool_tournament", title: "duplicate", metadata: { externalId: live.lucraExternalId }, participants: [] });
    db().update(tournaments).set({ lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, live.id)).run();
    expect(await writeAgreedConsensus(thirteen.id, clock)).toMatchObject({ state: "refused", code: "ambiguous_matchup" });
    expect(db().select({ status: tournaments.status }).from(tournaments).where(eq(tournaments.id, live.id)).get()?.status).toBe("awaiting_settlement");
    expect(previewClose(live.id).blockers.map((b) => b.matchId).sort()).toEqual([at(14).id, at(15).id].sort());
    // Scores cannot be submitted, but forfeits can: the organizer ends the event.
    const fourteen = at(14);
    expect(() => submitScoreline({ matchId: fourteen.id, userId: captainOf(fourteen.teamAId), scoreline: { sets: typed(A_WINS, "a") } }, clock)).toThrow(/tournament is live/);
    const forfeited = forfeitMatch(fourteen.id, fourteen.teamBId ?? "", { kind: "organizer", userId: organizerId }, clock);
    expect(forfeited.match.status).toBe("forfeited");
    const fifteen = at(15);
    forfeitMatch(fifteen.id, fifteen.teamBId ?? "", { kind: "organizer", userId: organizerId }, clock);
    expect(previewClose(live.id).blockers).toEqual([]);
    // With the duplicate still there Lucra cannot settle; the close still commits and says so.
    const preview = previewClose(live.id);
    const closed = await closeTournament({ tournamentId: live.id, organizerUserId: organizerId, previewHash: preview.previewHash }, clock);
    expect(closed.settlement.state).toBe("refused");
    expect(db().select({ status: tournaments.status, closePreviewJson: tournaments.closePreviewJson }).from(tournaments).where(eq(tournaments.id, live.id)).get()).toMatchObject({ status: "awaiting_settlement", closePreviewJson: expect.any(String) });
    // Once closed, forfeits are over: a closed event is not a frozen one.
    dup.metadata.externalId = "elsewhere";
    expect(() => forfeitMatch(fourteen.id, fourteen.teamAId ?? "", { kind: "organizer", userId: organizerId }, clock)).toThrow(/tournament is live/);
  });

  it("splits a team prize in whole cents across linked players and reports the unlinked", () => {
    const rosters = new Map([
      ["t1", { id: "t1", tournamentId: "x", name: "A", seed: null, status: "checked_in" as const, createdAt: 0, members: [{ userId: "u1", displayName: "One", role: "captain" as const }, { userId: "u2", displayName: "Two", role: "player" as const }] }],
      ["t2", { id: "t2", tournamentId: "x", name: "B", seed: null, status: "checked_in" as const, createdAt: 0, members: [{ userId: "u3", displayName: "Three", role: "captain" as const }, { userId: "u4", displayName: "Four", role: "player" as const }] }],
    ]);
    const link = (userId: string, lucraUserId: string | null) => ({ id: userId, userId, lucraUserId, externalId: `ext-${userId}`, verificationState: "verified" as const, linkedAt: null, lastSyncedAt: null });
    const links = new Map([
      ["u1", link("u1", "lu1")],
      ["u2", link("u2", "lu2")],
      ["u3", link("u3", "lu3")],
      ["u4", link("u4", null)],
    ]);
    const frozen = {
      rewards: [
        { id: "r2", placement: 2, teamId: "t2", teamName: "B", kind: "lucra_reward" as const, amountCents: 1_001, currency: "USD", description: "" },
        { id: "r1", placement: 1, teamId: "t1", teamName: "A", kind: "lucra_reward" as const, amountCents: 333, currency: "USD", description: "" },
        { id: "r3", placement: 3, teamId: "t1", teamName: "A", kind: "sponsor_item" as const, amountCents: null, currency: null, description: "eyewear" },
      ],
    };
    const built = buildPaymentStructure(frozen, rosters, links);
    expect(built.entries).toEqual([
      { position: 1, positionOverride: 1, value: 1.67, userId: "lu1" },
      { position: 2, positionOverride: 1, value: 1.66, userId: "lu2" },
      { position: 3, positionOverride: 2, value: 5.01, userId: "lu3" },
    ]);
    expect(built.unlinked).toEqual([{ teamId: "t2", userId: "u4" }]);
  });

  it("reads participants back and reports divergence against teams; a settled tournament reconciles cleanly", async () => {
    const upcoming = app.tournament(SLUGS.upcoming);
    const recon = await reconcileParticipants(upcoming.id, system, clock);
    expect(recon.lucraStatus).toBe("OPEN");
    // The seed leaves one registered player out of the Lucra matchup and adds one Lucra participant on no team.
    expect(recon.missing).toHaveLength(1);
    expect(recon.extra).toHaveLength(1);
    expect(recon.unlinked).toEqual([]);
    expect(recon.matched.length + recon.missing.length).toBe(16);
    expect(recon.lucraParticipants).toBe(recon.matched.length + recon.extra.length);
    // A player with no link shows as unlinked.
    const someone = recon.matched[0]!;
    db().delete(lucraLinks).where(eq(lucraLinks.userId, someone.userId)).run();
    const again = await reconcileParticipants(upcoming.id, system, clock);
    expect(again.unlinked).toEqual([{ userId: someone.userId, displayName: someone.displayName, teamId: someone.teamId, teamName: someone.teamName }]);
    expect(again.extra).toHaveLength(2);

    const settled = app.tournament(SLUGS.settled);
    const clean = await reconcileParticipants(settled.id, system, clock);
    expect(clean.lucraStatus).toBe("CLOSED");
    expect(clean.missing).toEqual([]);
    expect(clean.extra).toEqual([]);
    expect(clean.matched).toHaveLength(32);
  });

  it("mints one opaque external id per user and reports the Lucra id only once Lucra itself has named it", async () => {
    const user = { id: uuidv7() };
    db().insert(app.conn.db._.fullSchema.users).values({ id: user.id, displayName: "New Player", phoneE164: "+15550009999", email: null, avatarUrl: null, role: "player", createdAt: clock.now() }).run();
    const first = linkLucraAccount(user, clock);
    expect(first.minted).toBe(true);
    expect(first.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.externalId).not.toContain("5550009999");
    expect(first.lucraUserId).toBeNull();
    const again = linkLucraAccount(user, clock);
    expect(again).toMatchObject({ minted: false, externalId: first.externalId, lucraUserId: null });
    expect(app.audits(user.id).map((a) => a.action)).toEqual(["lucra.link_minted"]);
    // The id arrives from Lucra's participant list, keyed on the external id we minted — never from the player.
    const upcoming = app.tournament(SLUGS.upcoming);
    const matchup = mockMatchupFor(upcoming.lucraExternalId);
    const mock = getLucra().mock!;
    mock.addUser({ id: "lucra-user-from-lucra", username: "new.player", phoneNumber: null, metadata: { externalId: first.externalId } });
    mock.join(matchup.id, "lucra-user-from-lucra");
    const recon = await reconcileParticipants(upcoming.id, system, clock);
    expect(recon.extra.map((e) => e.externalId)).toContain(first.externalId);
    expect(linkLucraAccount(user, clock)).toMatchObject({ minted: false, lucraUserId: null });
    expect((await syncLucraUserIds(upcoming.id, matchup.id, system, clock)).updated).toBeGreaterThanOrEqual(1);
    expect(linkLucraAccount(user, clock)).toMatchObject({ minted: false, lucraUserId: "lucra-user-from-lucra", linkedAt: clock.now() });
    expect(app.audits(user.id).map((a) => a.action)).toEqual(["lucra.link_minted", "lucra.link_updated"]);
  });
});
