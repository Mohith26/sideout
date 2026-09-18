import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/lib/clock";
import { createLucraClient, fillPath, REDACTED, type FetchLike } from "@/lucra/client";
import { LUCRA_API_KEY_HEADER, LUCRA_ERROR_BODIES, LUCRA_PATHS } from "@/lucra/endpoints";
import { LucraError } from "@/lucra/errors";
import type { PoolTournamentUserScoreRequest } from "@/lucra/types";

const KEY = "backend-key-SENTINEL-8f2c";

const REQUEST: PoolTournamentUserScoreRequest = {
  object: { matchupMetadata: { externalId: "sideout-t-1" }, userScore: { userMetadata: { externalId: "sideout-user-1" }, score: 42, attemptFinished: true } },
};

type Step = { status: number; body: unknown } | { throws: Error } | { hang: "headers" | "body" };

/** A scripted fake server: each call consumes the next step. */
function fakeServer(steps: Step[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const step = steps.shift();
    if (!step) throw new Error("fake server: no step scripted");
    if ("throws" in step) return Promise.reject(step.throws);
    if ("hang" in step) {
      const hang = step.hang;
      const abortable = () =>
        new Promise<never>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      if (hang === "headers") return abortable();
      return Promise.resolve({ status: 200, text: abortable });
    }
    return Promise.resolve({ status: step.status, text: () => Promise.resolve(typeof step.body === "string" ? step.body : JSON.stringify(step.body)) });
  };
  return { fetchImpl, calls };
}

const SUCCESS = { status: 200, body: { status: "success", data: { affectedMatchupIds: ["m1"], failedMatchupIds: [] } } };

function client(server: ReturnType<typeof fakeServer>, extra: Partial<Parameters<typeof createLucraClient>[0]> = {}) {
  return createLucraClient({
    baseUrl: "https://api.sandbox.lucrasports.com/",
    apiKey: KEY,
    fetch: server.fetchImpl,
    clock: fixedClock(1_700_000_000_000),
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...extra,
  });
}

describe("LucraClient", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it("sends the key in X-Lucra-Api-Key, JSON body, to the documented path", async () => {
    const server = fakeServer([SUCCESS]);
    const result = await client(server).submitPoolTournamentScore(REQUEST);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe(`https://api.sandbox.lucrasports.com${LUCRA_PATHS.poolTournamentUserScore}`);
    expect(server.calls[0]?.headers[LUCRA_API_KEY_HEADER]).toBe(KEY);
    expect(JSON.parse(server.calls[0]?.body ?? "")).toEqual(REQUEST);
    expect(result.data.data.affectedMatchupIds).toEqual(["m1"]);
    expect(result.record.tries).toBe(1);
    expect(result.record.response?.status).toBe(200);
  });

  it("retries 5xx and transport errors three times with backoff, then succeeds", async () => {
    const server = fakeServer([{ status: 503, body: "upstream" }, { throws: new Error("ECONNRESET") }, { status: 500, body: { error: "boom" } }, SUCCESS]);
    const sleeps: number[] = [];
    const result = await client(server, { sleep: (ms) => (sleeps.push(ms), Promise.resolve()) }).submitPoolTournamentScore(REQUEST);
    expect(server.calls).toHaveLength(4);
    expect(result.record.tries).toBe(4);
    // 250·2^n plus jitter of 0.5·250.
    expect(sleeps).toEqual([375, 625, 1125]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("gives up after three retries with a server error that keeps the last response", async () => {
    const server = fakeServer([
      { status: 500, body: { error: "a" } },
      { status: 502, body: { error: "b" } },
      { status: 503, body: { error: "c" } },
      { status: 504, body: { error: "d" } },
    ]);
    const err = await client(server).submitPoolTournamentScore(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LucraError);
    const lucraError = err as LucraError;
    expect(lucraError.code).toBe("server");
    expect(lucraError.retryable).toBe(true);
    expect(lucraError.detail.httpStatus).toBe(504);
    expect(lucraError.detail.record?.tries).toBe(4);
    expect(lucraError.detail.record?.response).toEqual({ status: 504, body: { error: "d" } });
    expect(server.calls).toHaveLength(4);
  });

  it("never retries a 4xx and maps each documented failure body to its own code", async () => {
    const cases: Array<[string, string, number]> = [
      [LUCRA_ERROR_BODIES.invalidApiKey, "invalid_api_key", 401],
      [LUCRA_ERROR_BODIES.noMatchupIdentifiers, "no_matchup_identifiers", 400],
      [LUCRA_ERROR_BODIES.matchupNotFound, "matchup_not_found", 404],
      [LUCRA_ERROR_BODIES.userNotFound, "user_not_found", 404],
      ["locationId must be a UUID", "validation", 400],
    ];
    for (const [body, code, status] of cases) {
      const server = fakeServer([{ status, body: { status: "failure", error: body } }]);
      const err = (await client(server).submitPoolTournamentScore(REQUEST).catch((e: unknown) => e)) as LucraError;
      expect(err).toBeInstanceOf(LucraError);
      expect(err.code).toBe(code);
      expect(err.detail.httpStatus).toBe(status);
      expect(err.detail.body).toEqual({ status: "failure", error: body });
      expect(server.calls).toHaveLength(1);
    }
    const bare = fakeServer([{ status: 403, body: "Forbidden" }]);
    const err = (await client(bare).submitPoolTournamentScore(REQUEST).catch((e: unknown) => e)) as LucraError;
    expect(err.code).toBe("http");
    expect(bare.calls).toHaveLength(1);
  });

  it("treats a 2xx that does not match the schema as a shape error, not a success", async () => {
    const server = fakeServer([{ status: 200, body: { status: "success", data: { affected: ["m1"] } } }]);
    const err = (await client(server).submitPoolTournamentScore(REQUEST).catch((e: unknown) => e)) as LucraError;
    expect(err.code).toBe("shape");
    expect(err.message).toMatch(/affectedMatchupIds/);
    expect(server.calls).toHaveLength(1);

    const html = fakeServer([{ status: 200, body: "<html>maintenance</html>" }]);
    const err2 = (await client(html).submitPoolTournamentScore(REQUEST).catch((e: unknown) => e)) as LucraError;
    expect(err2.code).toBe("shape");
  });

  it("times out at 5s to headers and 10s total, and counts the timeout as a retryable transport error", async () => {
    const server = fakeServer([{ hang: "headers" }, { hang: "body" }, SUCCESS]);
    const result = await client(server, { timeouts: { connectMs: 15, totalMs: 40 } }).submitPoolTournamentScore(REQUEST);
    expect(result.record.tries).toBe(3);
    expect(server.calls).toHaveLength(3);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([expect.stringContaining('code="transport"'), expect.stringContaining('code="transport"')]);
  });

  it("redacts the key from the record, the logs, and any echoed response text", async () => {
    const server = fakeServer([{ status: 500, body: { echo: `you sent ${KEY}` } }, { status: 200, body: `{"status":"failure","error":"key ${KEY} rejected"}` }]);
    const err = (await client(server).submitPoolTournamentScore(REQUEST).catch((e: unknown) => e)) as LucraError;
    const record = err.detail.record;
    expect(record?.request.headers[LUCRA_API_KEY_HEADER]).toBe(REDACTED);
    const everything = JSON.stringify({ record, message: err.message, body: err.detail.body });
    expect(everything).not.toContain(KEY);
    expect(everything).toContain(REDACTED);
    const logged = [...warn.mock.calls, ...error.mock.calls].map((c: unknown[]) => c.map(String).join(" ")).join("\n");
    expect(logged).not.toContain(KEY);
    // The wire still carried the real key.
    expect(server.calls[0]?.headers[LUCRA_API_KEY_HEADER]).toBe(KEY);
  });

  it("validates the request against its schema before anything is sent", async () => {
    const server = fakeServer([SUCCESS]);
    const loose = { object: { matchupMetadata: { season: "2026" }, userScore: { score: 1 } } } as unknown as PoolTournamentUserScoreRequest;
    await expect(client(server).submitPoolTournamentScore(loose)).rejects.toThrow();
    expect(server.calls).toHaveLength(0);
  });

  it("fills path templates and reads a tournament", async () => {
    expect(fillPath(LUCRA_PATHS.poolTournamentGet, { matchupId: "a b" })).toBe("/api/rest/pool-tournament/a%20b");
    expect(() => fillPath(LUCRA_PATHS.poolTournamentComplete, {})).toThrow(/matchupId/);
    const server = fakeServer([{ status: 200, body: { matchup: { id: "m1", status: "OPEN", users: [{ userId: "u1", userMetadata: { externalId: "x" } }] } } }]);
    const result = await client(server).getPoolTournament("m1");
    expect(server.calls[0]?.method).toBe("GET");
    expect(server.calls[0]?.body).toBeUndefined();
    expect(result.data.matchup.users[0]?.userId).toBe("u1");
  });
});
