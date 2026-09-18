import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/lib/clock";
import { assertStrictTarget, classifyWrite, createLucraAdapter, type LucraAdapter } from "@/lucra/adapter";
import type { CallRecord, FetchLike } from "@/lucra/client";
import { LUCRA_API_KEY_HEADER, LUCRA_PATHS } from "@/lucra/endpoints";
import { LucraError } from "@/lucra/errors";
import type { StrictMatchupTarget } from "@/lucra/types";

function mockAdapter(): LucraAdapter {
  const adapter = createLucraAdapter({ mode: "mock", interpretation: "literal", webhookSecret: "s", clock: fixedClock(1_700_000_000_000) });
  adapter.mock?.seed({
    users: [
      { id: "u-jo", username: "jo", metadata: { externalId: "sideout-user-jo" } },
      { id: "u-kai", username: "kai", metadata: { externalId: "sideout-user-kai" } },
      { id: "u-lee", username: "lee", metadata: { externalId: "sideout-user-lee" } },
    ],
    matchups: [
      { id: "m-a", kind: "pool_tournament", title: "A", gameId: "G", metadata: { externalId: "sideout-a", season: "2026" }, participants: ["u-jo", "u-kai"] },
      { id: "m-b", kind: "pool_tournament", title: "B", gameId: "G", metadata: { externalId: "sideout-b", season: "2026" }, participants: ["u-jo", "u-lee"] },
      { id: "m-closed", kind: "pool_tournament", title: "closed", gameId: "G", metadata: { externalId: "sideout-closed" }, participants: ["u-jo"], status: "CLOSED" },
    ],
  });
  return adapter;
}

const record = (status: number | null): CallRecord => ({
  method: "POST",
  path: LUCRA_PATHS.poolTournamentUserScore,
  request: { headers: {}, body: null },
  response: status === null ? null : { status, body: null },
  tries: 1,
  startedAt: 0,
  finishedAt: 0,
  error: null,
});

describe("strict targeting (rule 7.3.2)", () => {
  const looseTargets: Array<[string, unknown]> = [
    ["a loose metadata bag", { matchupMetadata: { season: "2026-spring" } }],
    ["externalId plus another key", { matchupMetadata: { externalId: "sideout-a", season: "2026" } }],
    ["gameId only", { gameId: "SIDEOUT_BEACH_2V2" }],
    ["matchupId plus metadata", { matchupId: "m-a", matchupMetadata: { externalId: "sideout-a" } }],
    ["an empty object", {}],
    ["an empty externalId", { matchupMetadata: { externalId: "" } }],
    ["null", null],
  ];

  it("accepts exactly matchupId or a sole-key externalId", () => {
    expect(assertStrictTarget({ matchupId: "m-a" })).toEqual({ matchupId: "m-a" });
    expect(assertStrictTarget({ matchupMetadata: { externalId: "sideout-a" } })).toEqual({ matchupMetadata: { externalId: "sideout-a" } });
  });

  for (const [name, target] of looseTargets) {
    it(`throws strict_targeting for ${name} before any network call`, async () => {
      const fetchSpy = vi.fn<FetchLike>(() => Promise.reject(new Error("must not be called")));
      const adapter = createLucraAdapter({ mode: "sandbox", interpretation: "literal", baseUrl: "https://api.sandbox.lucrasports.com", apiKey: "k", client: { fetch: fetchSpy } });
      const err = (await adapter.submitScores({ target: target as StrictMatchupTarget, userScores: [{ userMetadata: { externalId: "x" }, score: 1 }] }).catch((e: unknown) => e)) as LucraError;
      expect(err).toBeInstanceOf(LucraError);
      expect(err.code).toBe("strict_targeting");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(() => assertStrictTarget(target)).toThrow(LucraError);
    });
  }

  it("the type refuses a loose literal at compile time", () => {
    // @ts-expect-error a season is not a target
    const loose: StrictMatchupTarget = { matchupMetadata: { season: "2026" } };
    // @ts-expect-error externalId must be the only key
    const extra: StrictMatchupTarget = { matchupMetadata: { externalId: "a", season: "2026" } };
    expect([loose, extra].length).toBe(2);
  });
});

describe("submitScores through the mock", () => {
  let adapter: LucraAdapter;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    adapter = mockAdapter();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("defaults to the pool-tournament endpoint with one call per user, all accepted", async () => {
    const result = await adapter.submitScores({
      target: { matchupMetadata: { externalId: "sideout-a" } },
      gameId: "G",
      userScores: [
        { userMetadata: { externalId: "sideout-user-jo" }, score: 21, attemptFinished: true, metadata: { match_id: "x" } },
        { userMetadata: { externalId: "sideout-user-kai" }, score: 18, attemptFinished: true },
      ],
    });
    expect(result.outcome).toBe("accepted");
    expect(result.endpoint).toBe("pool_tournament");
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((c) => c.path === LUCRA_PATHS.poolTournamentUserScore)).toBe(true);
    expect(result.calls[0]?.request.body).toEqual({ object: { matchupMetadata: { externalId: "sideout-a" }, gameId: "G", userScore: { userMetadata: { externalId: "sideout-user-jo" }, score: 21, attemptFinished: true, metadata: { match_id: "x" } } } });
    expect(result.calls[0]?.request.headers[LUCRA_API_KEY_HEADER]).toBe("[redacted]");
    expect(result.affectedMatchupIds).toEqual(["m-a"]);
    expect(result.httpStatus).toBe(200);
    expect(adapter.mock?.getMatchup("m-a")?.participants.get("u-jo")?.score).toBe(21);
  });

  it("uses the generic endpoint, one call with userScores[], only when asked", async () => {
    const result = await adapter.submitScores({ target: { matchupId: "m-a" }, endpoint: "generic", userScores: [{ userMetadata: { externalId: "sideout-user-jo" }, score: 1 }, { userMetadata: { externalId: "sideout-user-kai" }, score: 2 }] });
    expect(result.endpoint).toBe("generic");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.path).toBe(LUCRA_PATHS.genericUserScore);
    expect(result.outcome).toBe("accepted");
  });

  it("detects partial: non-empty failedMatchupIds under status success", async () => {
    const result = await adapter.submitScores({ target: { matchupMetadata: { externalId: "sideout-closed" } }, userScores: [{ userMetadata: { externalId: "sideout-user-jo" }, score: 1 }] });
    expect(result.outcome).toBe("partial");
    expect(result.failedMatchupIds).toEqual(["m-closed"]);
    expect(result.httpStatus).toBe(200);
    expect(result.error?.message).toContain("m-closed");
  });

  it("maps documented failures to rejected with the code, and one bad user rejects the whole write", async () => {
    const result = await adapter.submitScores({
      target: { matchupMetadata: { externalId: "sideout-a" } },
      userScores: [
        { userMetadata: { externalId: "sideout-user-jo" }, score: 1 },
        { userMetadata: { externalId: "sideout-user-ghost" }, score: 2 },
      ],
    });
    expect(result.outcome).toBe("rejected");
    expect(result.error).toEqual({ code: "user_not_found", message: expect.stringContaining("User not found") });
    expect(result.httpStatus).toBe(404);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]?.response).toEqual({ status: 404, body: { status: "failure", error: "User not found" } });
    const missing = await adapter.submitScores({ target: { matchupMetadata: { externalId: "sideout-nope" } }, userScores: [{ userMetadata: { externalId: "sideout-user-jo" }, score: 1 }] });
    expect(missing.outcome).toBe("rejected");
    expect(missing.error?.code).toBe("matchup_not_found");
  });

  it("a user who is not a participant is rejected as not_participant, not silently accepted", async () => {
    const result = await adapter.submitScores({ target: { matchupMetadata: { externalId: "sideout-a" } }, userScores: [{ userMetadata: { externalId: "sideout-user-lee" }, score: 1 }] });
    expect(result.outcome).toBe("rejected");
    expect(result.error?.code).toBe("not_participant");
  });

  it("classifies transport failures as transport_error and lets rejected outrank them", () => {
    const transport = new LucraError("transport", "timed out");
    const rejected = new LucraError("user_not_found", "User not found");
    expect(classifyWrite([{ record: record(null), ok: false, error: transport }]).outcome).toBe("transport_error");
    expect(classifyWrite([{ record: record(200), ok: true, affected: ["m"], failed: [] }, { record: record(null), ok: false, error: transport }]).outcome).toBe("transport_error");
    expect(classifyWrite([{ record: record(null), ok: false, error: transport }, { record: record(404), ok: false, error: rejected }]).outcome).toBe("rejected");
    expect(classifyWrite([{ record: record(200), ok: true, affected: ["m"], failed: ["n"] }, { record: record(200), ok: true, affected: ["m"], failed: [] }]).outcome).toBe("partial");
    expect(classifyWrite([{ record: record(200), ok: true, affected: ["m"], failed: [] }]).outcome).toBe("accepted");
    expect(classifyWrite([]).outcome).toBe("accepted");
  });
});

describe("assertSingleMatchup (rule 7.3.4)", () => {
  it("passes for exactly one, refuses zero and more than one, and logs the count", async () => {
    const adapter = mockAdapter();
    const info = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const one = await adapter.assertSingleMatchup({ matchupMetadata: { externalId: "sideout-a" } });
    expect(one).toMatchObject({ matchupId: "m-a", count: 1 });
    expect(one.record.path).toBe(LUCRA_PATHS.poolTournamentQuery);
    expect(info.mock.calls.map((c) => String(c[0])).join("")).toContain("count=1");

    const none = (await adapter.assertSingleMatchup({ matchupMetadata: { externalId: "sideout-zzz" } }).catch((e: unknown) => e)) as LucraError;
    expect(none.code).toBe("matchup_not_found");
    expect(none.detail.body).toEqual({ count: 0, matchupIds: [] });

    // A loose query would match two; the assertion never accepts a loose target, but the mock proves the hazard is real.
    const loose = await adapter.queryMatchups({ matchupMetadata: { season: "2026" } });
    expect(loose.matchupIds).toEqual(["m-a", "m-b"]);
    // Two matchups with the same externalId: the ambiguous case the rule exists for.
    adapter.mock?.addMatchup({ id: "m-dup", kind: "pool_tournament", title: "dup", metadata: { externalId: "sideout-a" }, participants: [] });
    const many = (await adapter.assertSingleMatchup({ matchupMetadata: { externalId: "sideout-a" } }).catch((e: unknown) => e)) as LucraError;
    expect(many.code).toBe("ambiguous_matchup");
    expect(many.detail.body).toEqual({ count: 2, matchupIds: ["m-a", "m-dup"] });
    expect(info.mock.calls.map((c) => String(c[0])).join("")).toContain("count=2");
    info.mockRestore();
  });
});

describe("tournament read and complete", () => {
  it("reads participants back and completes with unassigned ids surfaced", async () => {
    const adapter = mockAdapter();
    const read = await adapter.getTournament("m-a");
    expect(read.matchup.users.map((u) => u.userMetadata?.externalId)).toEqual(["sideout-user-jo", "sideout-user-kai"]);
    const done = await adapter.completeTournament("m-a", { object: { paymentStructure: [{ position: 1, value: 100, userId: "u-jo" }, { position: 2, value: 50, userId: "u-nobody" }] } });
    expect(done.response.unassignedUserIds).toEqual(["u-nobody"]);
    expect((await adapter.getTournament("m-a")).matchup.status).toBe("CLOSED");
    const again = (await adapter.completeTournament("m-a", { object: { paymentStructure: [] } }).catch((e: unknown) => e)) as LucraError;
    expect(again.code).toBe("validation");
  });

  it("refuses to build outside mock mode without credentials", () => {
    expect(() => createLucraAdapter({ mode: "sandbox", interpretation: "literal" })).toThrow(/LUCRA_BACKEND_API_KEY/);
  });
});
