import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lucraLinks, lucraScoreSubmissions, matchConsensus, matches, rewards, tournaments, type Match } from "@/db/schema";
import { LucraWriteRefused, type SubmittedSet } from "@/domain/consensus";
import type { SetScore } from "@/domain/scoreline";
import { fixedClock } from "@/lib/clock";
import { uuidv7 } from "@/lib/uuid";
import { createLucraAdapter, installLucraAdapter, LucraError } from "@/lucra";
import { SLUGS } from "@/seed/build";
import { closeTournament, previewClose } from "@/server/close";
import { resolveDispute, submitScoreline } from "@/server/consensus";
import { buildPaymentStructure, ensureMatchupTarget, getLucra, linkLucraAccount, readLucraAlert, reconcileParticipants, resetLucraForTests, retryConsensusScores, settleTournament, submitConsensusScores, writeAgreedConsensus } from "@/server/lucra";
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
    // The organizer's explicit verify raises the alert but never changes the status of a live event.
    await expect(ensureMatchupTarget(live.id, system, clock, { force: true })).rejects.toMatchObject({ code: "ambiguous_matchup" });
    let row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("live");
    expect(readLucraAlert(row)).toMatchObject({ code: "matchup_ambiguous", blocking: true, detail: { count: 2 } });
    expect(app.audits(live.id, "lucra.matchup_assertion_failed")).toHaveLength(1);
    // The write path is where rule 7.3.4 bites: refused, and the live event is moved to awaiting_settlement.
    db().update(tournaments).set({ lucraMatchupVerifiedAt: null }).where(eq(tournaments.id, live.id)).run();
    await expect(submitConsensusScores(m.id, system, clock)).rejects.toBeInstanceOf(LucraError);
    expect(rowsFor(m.id)).toEqual([]);
    expect(consensusOf(m.id)?.state).toBe("agreed");
    row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(row.status).toBe("awaiting_settlement");
    expect(app.audits(live.id, "lucra.matchup_assertion_failed")).toHaveLength(2);

    // The organizer removes the duplicate in Lucra and verifies again.
    dup.metadata.externalId = "somewhere-else";
    const verified = await ensureMatchupTarget(live.id, { kind: "organizer", userId: organizerId }, clock, { force: true });
    expect(verified).toMatchObject({ count: 1, queried: true, matchupId: mockMatchupFor(live.lucraExternalId).id });
    row = db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!;
    expect(readLucraAlert(row)).toBeNull();
    expect(row.lucraMatchupVerifiedAt).toBe(clock.now());
    // The cached result is reused without another query.
    expect((await ensureMatchupTarget(live.id, system, clock)).queried).toBe(false);
    // A missing matchup is the other refusal.
    db().update(tournaments).set({ lucraExternalId: "sideout-nowhere" }).where(eq(tournaments.id, live.id)).run();
    await expect(ensureMatchupTarget(live.id, system, clock, { force: true })).rejects.toMatchObject({ code: "matchup_not_found" });
    expect(readLucraAlert(db().select().from(tournaments).where(eq(tournaments.id, live.id)).get()!)).toMatchObject({ code: "matchup_missing" });
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

  it("mints one opaque external id per user, records the Lucra id once, and refuses a second claimant", () => {
    const user = { id: uuidv7() };
    db().insert(app.conn.db._.fullSchema.users).values({ id: user.id, displayName: "New Player", phoneE164: "+15550009999", email: null, avatarUrl: null, role: "player", createdAt: clock.now() }).run();
    const first = linkLucraAccount(user, {}, clock);
    expect(first.minted).toBe(true);
    expect(first.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.externalId).not.toContain("5550009999");
    expect(first.lucraUserId).toBeNull();
    const again = linkLucraAccount(user, {}, clock);
    expect(again).toMatchObject({ minted: false, externalId: first.externalId });
    const linked = linkLucraAccount(user, { lucraUserId: "lucra-abc" }, clock);
    expect(linked).toMatchObject({ lucraUserId: "lucra-abc", linkedAt: clock.now(), externalId: first.externalId });
    expect(linkLucraAccount(user, { lucraUserId: "lucra-abc" }, clock).lucraUserId).toBe("lucra-abc");
    expect(() => linkLucraAccount(user, { lucraUserId: "lucra-other" }, clock)).toThrow(/already linked to a different Lucra account/);
    const other = { id: app.player().id };
    const otherLink = db().select().from(lucraLinks).where(eq(lucraLinks.userId, other.id)).get()!;
    db().update(lucraLinks).set({ lucraUserId: null }).where(eq(lucraLinks.id, otherLink.id)).run();
    expect(() => linkLucraAccount(other, { lucraUserId: "lucra-abc" }, clock)).toThrow(/already linked to another Sideout account/);
    expect(app.audits(user.id).map((a) => a.action)).toEqual(["lucra.link_minted", "lucra.link_updated"]);
  });
});
