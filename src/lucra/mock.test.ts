import { describe, expect, it } from "vitest";
import { fixedClock } from "@/lib/clock";
import { LUCRA_API_KEY_HEADER, LUCRA_ERROR_BODIES, LUCRA_PATHS } from "@/lucra/endpoints";
import { createLucraMock, MOCK_API_KEY, type LucraMock, type MockHttpResponse } from "@/lucra/mock";
import { verifyWebhookSignature } from "@/lucra/webhook-signature";

const SECRET = "test-webhook-secret";

/** Three tournaments sharing loose metadata with one player in all of them (spec §7.3), plus recreational games. */
function seededMock(): LucraMock {
  const mock = createLucraMock({ webhookSecret: SECRET, clock: fixedClock(1_700_000_000_000) });
  mock.seed({
    users: [
      { id: "u-jo", username: "jo", phoneNumber: "+15550001", metadata: { externalId: "sideout-user-jo" } },
      { id: "u-kai", username: "kai", phoneNumber: "+15550002", metadata: { externalId: "sideout-user-kai" } },
      { id: "u-lee", username: "lee", phoneNumber: "+15550003", metadata: { externalId: "sideout-user-lee" } },
      { id: "u-out", username: "out", phoneNumber: "+15550004", metadata: { externalId: "sideout-user-out" } },
    ],
    matchups: [
      { id: "m-a", kind: "pool_tournament", title: "A", gameId: "SIDEOUT_BEACH_2V2", metadata: { externalId: "sideout-a", season: "2026-spring", venue: "Sandbar" }, participants: ["u-jo", "u-kai"] },
      { id: "m-b", kind: "pool_tournament", title: "B", gameId: "SIDEOUT_BEACH_2V2", metadata: { externalId: "sideout-b", season: "2026-spring", venue: "Sandbar" }, participants: ["u-jo", "u-lee"] },
      { id: "m-c", kind: "pool_tournament", title: "C", gameId: "SIDEOUT_BEACH_2V2", metadata: { externalId: "sideout-c", season: "2026-spring", venue: "Pier 9" }, participants: ["u-jo"] },
      { id: "m-closed", kind: "pool_tournament", title: "Closed", gameId: "SIDEOUT_BEACH_2V2", metadata: { externalId: "sideout-closed", season: "2025-fall" }, participants: ["u-jo", "u-kai"], status: "CLOSED" },
      { id: "r-auto", kind: "recreational", title: "Darts auto", gameId: "DARTS", metadata: { externalId: "rec-auto" }, participants: ["u-jo", "u-kai"], trackResults: "AUTOMATED", howToWin: "HIGHEST_SCORE" },
      { id: "r-manual", kind: "recreational", title: "Darts manual", gameId: "DARTS", metadata: { externalId: "rec-manual" }, participants: ["u-jo", "u-kai"], trackResults: "MANUAL" },
    ],
  });
  return mock;
}

function post(mock: LucraMock, path: string, body: unknown, key: string = MOCK_API_KEY): MockHttpResponse {
  return mock.handle({ method: "POST", path, headers: { [LUCRA_API_KEY_HEADER]: key, "content-type": "application/json" }, body: JSON.stringify(body) });
}

const score = (externalId: string, value: number, attemptFinished = true) => ({ userMetadata: { externalId }, score: value, attemptFinished });

describe("LucraMock: authentication and documented errors", () => {
  it('refuses a missing or wrong key with the exact "Invalid Api Key." body', () => {
    const mock = seededMock();
    const missing = mock.handle({ method: "POST", path: LUCRA_PATHS.poolTournamentQuery, headers: {}, body: "{}" });
    expect(missing).toEqual({ status: 401, body: { status: "failure", error: LUCRA_ERROR_BODIES.invalidApiKey } });
    expect(post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { matchupId: "m-a" } }, "nope").body).toEqual({ status: "failure", error: "Invalid Api Key." });
    // Header lookup is case-insensitive, as HTTP headers are.
    const lower = mock.handle({ method: "POST", path: LUCRA_PATHS.poolTournamentQuery, headers: { "x-lucra-api-key": MOCK_API_KEY }, body: JSON.stringify({ object: { matchupId: "m-a" } }) });
    expect(lower.status).toBe(200);
  });

  it("returns each documented identifier error byte for byte", () => {
    const mock = seededMock();
    expect(post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { userScore: score("sideout-user-jo", 1) } })).toEqual({
      status: 400,
      body: { status: "failure", error: "No matchup identifiers were provided" },
    });
    expect(post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { matchupMetadata: { externalId: "sideout-zzz" }, userScore: score("sideout-user-jo", 1) } })).toEqual({
      status: 404,
      body: { status: "failure", error: "Matchup not found" },
    });
    expect(post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { matchupMetadata: { externalId: "sideout-a" }, userScore: score("sideout-user-ghost", 1) } })).toEqual({
      status: 404,
      body: { status: "failure", error: "User not found" },
    });
    expect(post(mock, LUCRA_PATHS.poolTournamentQuery, { object: {} })).toEqual({ status: 400, body: { status: "failure", error: "No matchup identifiers were provided" } });
    expect(post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { matchupId: "nope" } })).toEqual({ status: 404, body: { status: "failure", error: "Matchup not found" } });
    expect(post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { matchupId: "m-a", phoneNumber: "+10000000" } })).toEqual({ status: 404, body: { status: "failure", error: "User not found" } });
  });

  it("answers validation problems in the documented failure format and unknown paths with 404", () => {
    const mock = seededMock();
    const bad = post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { matchupId: "m-a", userScore: { score: "high" } } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ status: "failure" });
    expect(mock.handle({ method: "POST", path: LUCRA_PATHS.poolTournamentUserScore, headers: { [LUCRA_API_KEY_HEADER]: MOCK_API_KEY }, body: "{not json" }).status).toBe(400);
    expect(mock.handle({ method: "GET", path: "/api/rest/nothing", headers: { [LUCRA_API_KEY_HEADER]: MOCK_API_KEY }, body: null }).status).toBe(404);
  });
});

describe("LucraMock: matchup resolution through the matcher", () => {
  it("a loose season query matches all three overlapping tournaments; externalId matches exactly one", () => {
    const mock = seededMock();
    const loose = post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { matchupMetadata: { season: "2026-spring" } } });
    expect(loose.body).toEqual({ status: "success", data: ["m-a", "m-b", "m-c"] });
    const strict = post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { matchupMetadata: { externalId: "sideout-b" } } });
    expect(strict.body).toEqual({ status: "success", data: ["m-b"] });
    const none = post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { matchupMetadata: { season: "1999" } } });
    expect(none.body).toEqual({ status: "success", data: [] });
  });

  it("filters by participant when a user identifier is given, and by gameId/locationId", () => {
    const mock = seededMock();
    const jo = post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { matchupMetadata: { season: "2026-spring" }, userMetadata: { externalId: "sideout-user-kai" } } });
    expect(jo.body).toEqual({ status: "success", data: ["m-a"] });
    const byGame = post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { gameId: "SIDEOUT_BEACH_2V2", phoneNumber: "+15550003" } });
    expect(byGame.body).toEqual({ status: "success", data: ["m-b"] });
    const wrongGame = post(mock, LUCRA_PATHS.poolTournamentQuery, { object: { gameId: "DARTS", matchupMetadata: { season: "2026-spring" } } });
    expect(wrongGame.body).toEqual({ status: "success", data: [] });
  });

  it("writes a loose-targeted score to EVERY matching matchup the user is in (the §7.3 hazard)", () => {
    const mock = seededMock();
    const res = post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { matchupMetadata: { season: "2026-spring" }, userScore: score("sideout-user-jo", 21) } });
    expect(res.body).toEqual({ status: "success", data: { affectedMatchupIds: ["m-a", "m-b", "m-c"], failedMatchupIds: [] } });
    for (const id of ["m-a", "m-b", "m-c"]) expect(mock.getMatchup(id)?.participants.get("u-jo")?.score).toBe(21);
    // A strict write lands in exactly one.
    const strict = post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { matchupMetadata: { externalId: "sideout-a" }, userScore: score("sideout-user-kai", 18) } });
    expect(strict.body).toEqual({ status: "success", data: { affectedMatchupIds: ["m-a"], failedMatchupIds: [] } });
    expect(mock.getMatchup("m-b")?.participants.get("u-kai")).toBeUndefined();
  });

  it("a user who is not a participant of the matched matchup affects nothing (success with empty lists)", () => {
    const mock = seededMock();
    const res = post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { matchupMetadata: { externalId: "sideout-c" }, userScore: score("sideout-user-out", 5) } });
    expect(res.body).toEqual({ status: "success", data: { affectedMatchupIds: [], failedMatchupIds: [] } });
  });
});

describe("LucraMock: overwrite and attemptFinished rules", () => {
  it("overwrites an unfinished attempt, never a finished one, and records the lock", () => {
    const mock = seededMock();
    const target = { matchupMetadata: { externalId: "sideout-a" } };
    post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-jo", 10, false) } });
    post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-jo", 15, false) } });
    expect(mock.getMatchup("m-a")?.participants.get("u-jo")?.score).toBe(15);
    post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-jo", 21, true) } });
    const after = post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-jo", 99, true) } });
    expect(after.body).toEqual({ status: "success", data: { affectedMatchupIds: ["m-a"], failedMatchupIds: [] } });
    expect(mock.getMatchup("m-a")?.participants.get("u-jo")?.score).toBe(21);
    const last = mock.listIngestions().at(-1);
    expect(last?.lockedUserIds).toEqual(["u-jo"]);
    expect(mock.serializeMatchup(mock.getMatchup("m-a") as NonNullable<ReturnType<LucraMock["getMatchup"]>>).users.find((u) => u.userId === "u-jo")?.canSubmitNewScore).toBe(false);
  });

  it("a rebuy reopens the attempt only while maxAttempts allows", () => {
    const mock = seededMock();
    mock.addMatchup({ id: "m-replay", kind: "pool_tournament", title: "Replay", metadata: { externalId: "sideout-replay" }, participants: ["u-jo"], maxAttempts: 2 });
    const target = { matchupMetadata: { externalId: "sideout-replay" } };
    post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-jo", 10) } });
    expect(mock.rebuy("m-replay", "u-jo")).toBe(true);
    post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-jo", 12) } });
    expect(mock.getMatchup("m-replay")?.participants.get("u-jo")?.score).toBe(12);
    expect(mock.rebuy("m-replay", "u-jo")).toBe(false);
    expect(mock.rebuy("m-a", "u-jo")).toBe(false);
  });

  it("a write to a CLOSED tournament lands in failedMatchupIds: status success, outcome partial", () => {
    const mock = seededMock();
    const res = post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { matchupMetadata: { externalId: "sideout-closed" }, userScore: score("sideout-user-jo", 3) } });
    expect(res.body).toEqual({ status: "success", data: { affectedMatchupIds: [], failedMatchupIds: ["m-closed"] } });
    const mixed = post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { gameId: "SIDEOUT_BEACH_2V2", userScore: score("sideout-user-kai", 3) } });
    expect(mixed.body).toEqual({ status: "success", data: { affectedMatchupIds: ["m-a"], failedMatchupIds: ["m-closed"] } });
  });
});

describe("LucraMock: settlement semantics", () => {
  it("tournaments never settle on attemptFinished alone; only complete closes them and emits TournamentCompleted", () => {
    const mock = seededMock();
    const target = { matchupMetadata: { externalId: "sideout-a" } };
    post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-jo", 21) } });
    post(mock, LUCRA_PATHS.poolTournamentUserScore, { object: { ...target, userScore: score("sideout-user-kai", 18) } });
    const m = mock.getMatchup("m-a");
    expect([...(m?.participants.values() ?? [])].every((p) => p.attemptFinished)).toBe(true);
    expect(m?.status).toBe("OPEN");
    expect(m?.completed).toBeNull();
    expect(mock.pendingWebhooks).toEqual([]);

    const done = post(mock, "/api/rest/pool-tournament/m-a/complete", { object: { paymentStructure: [{ position: 1, value: 500, userId: "u-jo" }, { position: 2, value: 250, userId: "u-ghost" }] } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "success", unassignedUserIds: ["u-ghost"] });
    expect(mock.getMatchup("m-a")?.status).toBe("CLOSED");
    expect(mock.getMatchup("m-a")?.completed?.mode).toBe("manual");
    expect(mock.getMatchup("m-a")?.rewardStructure).toEqual([
      { position: 1, positionOverride: null, value: 500, userId: "u-jo" },
      { position: 2, positionOverride: null, value: 250, userId: null },
    ]);
    expect(mock.pendingWebhooks).toHaveLength(1);
    const delivery = mock.pendingWebhooks[0];
    expect(delivery?.event).toBe("TournamentCompleted");
    expect(verifyWebhookSignature(delivery?.rawBody ?? "", delivery?.signature, SECRET)).toEqual({ valid: true });
    expect(JSON.parse(delivery?.rawBody ?? "{}")).toMatchObject({ event: "TournamentCompleted", mode: "manual", matchup: { id: "m-a", status: "CLOSED" } });
    // Closing twice is refused; a closed tournament is also read back as CLOSED.
    expect(post(mock, "/api/rest/pool-tournament/m-a/complete", { object: { paymentStructure: [] } }).status).toBe(400);
    expect(post(mock, "/api/rest/pool-tournament/nope/complete", { object: { paymentStructure: [] } }).body).toEqual({ status: "failure", error: "Matchup not found" });
    const read = mock.handle({ method: "GET", path: "/api/rest/pool-tournament/m-a", headers: { [LUCRA_API_KEY_HEADER]: MOCK_API_KEY }, body: null });
    expect(read.body).toMatchObject({ matchup: { id: "m-a", status: "CLOSED", numberOfParticipants: 2 } });
  });

  it("a recreational AUTOMATED game settles itself once every participant has finished; MANUAL does not", () => {
    const mock = seededMock();
    const first = post(mock, LUCRA_PATHS.recreationalUserScore, { object: { matchupMetadata: { externalId: "rec-auto" }, userScores: [score("sideout-user-jo", 19)] } });
    expect(first.body).toEqual({ status: "success", data: { affectedMatchupIds: ["r-auto"] } });
    expect(mock.getMatchup("r-auto")?.status).toBe("OPEN");
    const second = post(mock, LUCRA_PATHS.recreationalUserScore, { object: { matchupMetadata: { externalId: "rec-auto" }, userScores: [score("sideout-user-kai", 15)] } });
    expect(second.status).toBe(200);
    expect(mock.getMatchup("r-auto")?.status).toBe("CLOSED");
    expect(mock.getMatchup("r-auto")?.completed).toMatchObject({ mode: "auto", winnerUserIds: ["u-jo"] });
    expect(mock.pendingWebhooks.map((w) => w.event)).toEqual(["RecreationalGameCompleted"]);

    post(mock, LUCRA_PATHS.recreationalUserScore, { object: { matchupMetadata: { externalId: "rec-manual" }, userScores: [score("sideout-user-jo", 19), score("sideout-user-kai", 15)] } });
    expect(mock.getMatchup("r-manual")?.status).toBe("OPEN");
    expect(mock.getMatchup("r-manual")?.completed).toBeNull();
  });

  it("the recreational endpoint only writes where ALL identified users are participants, and never touches tournaments", () => {
    const mock = seededMock();
    const res = post(mock, LUCRA_PATHS.recreationalUserScore, { object: { gameId: "DARTS", userScores: [score("sideout-user-jo", 1), score("sideout-user-lee", 2)] } });
    expect(res.body).toEqual({ status: "success", data: { affectedMatchupIds: [] } });
    const tournament = post(mock, LUCRA_PATHS.recreationalUserScore, { object: { matchupMetadata: { externalId: "sideout-a" }, userScores: [score("sideout-user-jo", 1)] } });
    expect(tournament.body).toEqual({ status: "failure", error: "Matchup not found" });
  });

  it("the generic endpoint splits by type: tournaments per entry, recreational together, and auto-settles only the latter", () => {
    const mock = seededMock();
    const res = post(mock, LUCRA_PATHS.genericUserScore, { object: { gameId: "DARTS", userScores: [score("sideout-user-jo", 19), score("sideout-user-kai", 15)] } });
    expect(res.body).toEqual({ status: "success", data: { affectedMatchupIds: ["r-auto", "r-manual"], failedMatchupIds: [] } });
    expect(mock.getMatchup("r-auto")?.status).toBe("CLOSED");
    expect(mock.getMatchup("r-manual")?.status).toBe("OPEN");

    const t = post(mock, LUCRA_PATHS.genericUserScore, { object: { matchupMetadata: { externalId: "sideout-a" }, userScores: [score("sideout-user-jo", 21), score("sideout-user-kai", 18)] } });
    expect(t.body).toEqual({ status: "success", data: { affectedMatchupIds: ["m-a"], failedMatchupIds: [] } });
    expect(mock.getMatchup("m-a")?.status).toBe("OPEN");
  });
});

describe("LucraMock: joins, state and ids", () => {
  it("join adds a participant and emits TournamentUserJoined; the state snapshot is serializable", () => {
    const mock = seededMock();
    mock.join("m-c", "u-lee");
    mock.join("m-c", "u-lee");
    expect(mock.getMatchup("m-c")?.participants.size).toBe(2);
    expect(mock.pendingWebhooks.map((w) => w.event)).toEqual(["TournamentUserJoined"]);
    const state = mock.state();
    expect(JSON.parse(JSON.stringify(state))).toMatchObject({ interpretation: "literal", webhooks: { pending: [{ event: "TournamentUserJoined" }] } });
    expect(state.matchups.find((m) => m.id === "m-c")?.participants.map((p) => p.userId)).toEqual(["u-jo", "u-lee"]);
    const drained = mock.drainWebhooks();
    expect(drained).toHaveLength(1);
    expect(mock.pendingWebhooks).toEqual([]);
    expect(mock.state().webhooks.delivered).toHaveLength(1);
  });

  it("queues deliveries in emission order and hands each one over exactly once", () => {
    const mock = seededMock();
    mock.join("m-c", "u-lee");
    post(mock, "/api/rest/pool-tournament/m-c/complete", { object: { paymentStructure: [] } });
    expect(mock.pendingWebhooks.map((d) => d.event)).toEqual(["TournamentUserJoined", "TournamentCompleted"]);
    const first = mock.drainWebhooks();
    expect(first.map((d) => d.event)).toEqual(["TournamentUserJoined", "TournamentCompleted"]);
    expect(new Set(first.map((d) => d.id)).size).toBe(2);
    expect(mock.drainWebhooks()).toEqual([]);
    expect(mock.state().webhooks).toMatchObject({ pending: [], delivered: [{ event: "TournamentUserJoined" }, { event: "TournamentCompleted" }] });
  });
});
