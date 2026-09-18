import { env, type LucraMode } from "@/env";
import { systemClock, type Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import { createLucraClient, type CallRecord, type FetchLike, type LucraClient, type LucraClientOptions } from "@/lucra/client";
import { LUCRA_BASE_URLS, LUCRA_PATHS } from "@/lucra/endpoints";
import { isLucraError, LucraError, type LucraErrorCode } from "@/lucra/errors";
import type { MatcherInterpretation } from "@/lucra/matcher";
import { createLucraMock, MOCK_API_KEY, MOCK_BASE_URL, type LucraMock } from "@/lucra/mock";
import { MOCK_WEBHOOK_SECRET } from "@/lucra/webhook-signature";
import {
  strictMatchupTargetSchema,
  type CompleteTournamentRequest,
  type CompleteTournamentResponse,
  type MatchupCriteria,
  type Metadata,
  type StrictMatchupTarget,
  type TournamentMatchup,
  type UserScoreEntry,
} from "@/lucra/types";

/**
 * The adapter (spec §8): the only public surface of `src/lucra/` and the
 * single module allowed to make outbound Lucra calls. It selects the real
 * client or the in-process mock from `LUCRA_MODE`; in mock mode the *same*
 * client runs against a fetch that routes into the mock, so parsing,
 * redaction and retries are exercised in every mode.
 *
 * Hard rules it enforces before anything touches the network:
 *   7.3.1/7.3.2  every write targets a `matchupId` or a metadata object whose
 *                only key is `externalId` — `assertStrictTarget` throws first.
 *   7.2          the default write endpoint is `/pool-tournament/user-score`;
 *                the generic one only behind `endpoint: "generic"`.
 *   7.3.4        `assertSingleMatchup` runs the query and refuses unless
 *                exactly one matchup comes back.
 *   7.2          a non-empty `failedMatchupIds` under `status: "success"` is
 *                outcome `partial`, never swallowed.
 */

export type WriteEndpoint = "pool_tournament" | "generic";

export interface ScoreWriteInput {
  target: StrictMatchupTarget;
  gameId?: string;
  locationId?: string;
  userScores: UserScoreEntry[];
  /** Defaults to the type-specific tournament endpoint (one call per user score). */
  endpoint?: WriteEndpoint;
}

/** Mirrors `lucra_score_submissions.outcome` minus `pending`. */
export type WriteOutcome = "accepted" | "partial" | "rejected" | "transport_error";

export interface ScoreWriteResult {
  outcome: WriteOutcome;
  endpoint: WriteEndpoint;
  /** Every call made, redacted, in user order. */
  calls: CallRecord[];
  affectedMatchupIds: string[];
  failedMatchupIds: string[];
  /** The least successful status seen; null when nothing answered. */
  httpStatus: number | null;
  error: { code: LucraErrorCode; message: string } | null;
}

export interface QueryInput extends MatchupCriteria {
  userId?: string;
  phoneNumber?: string;
  userMetadata?: Metadata;
}

export interface LucraAdapter {
  readonly mode: LucraMode;
  readonly interpretation: MatcherInterpretation;
  /** Present in mock mode only. */
  readonly mock: LucraMock | null;
  submitScores(input: ScoreWriteInput): Promise<ScoreWriteResult>;
  queryMatchups(input: QueryInput): Promise<{ matchupIds: string[]; record: CallRecord }>;
  /** Rule 7.3.4: the query for a strict target must return exactly one matchup. */
  assertSingleMatchup(target: StrictMatchupTarget): Promise<{ matchupId: string; count: number; record: CallRecord }>;
  getTournament(matchupId: string): Promise<{ matchup: TournamentMatchup; record: CallRecord }>;
  completeTournament(matchupId: string, request: CompleteTournamentRequest): Promise<{ response: CompleteTournamentResponse; record: CallRecord }>;
}

export interface AdapterOptions {
  mode: LucraMode;
  interpretation: MatcherInterpretation;
  /** Required outside mock mode. */
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  /** The webhook secret the mock signs with. */
  webhookSecret?: string | undefined;
  clock?: Clock;
  /** Overrides for tests: a fake server, instant sleeps, fixed jitter. */
  client?: Partial<Pick<LucraClientOptions, "fetch" | "sleep" | "random" | "timeouts" | "retries" | "backoffBaseMs">>;
}

// ---------------------------------------------------------------------------
// Strict targeting
// ---------------------------------------------------------------------------

/**
 * Rule 7.3.2 at runtime. Anything that is not exactly `{ matchupId }` or
 * `{ matchupMetadata: { externalId } }` throws `LucraError("strict_targeting")`
 * before a request object is even built.
 */
export function assertStrictTarget(target: unknown): StrictMatchupTarget {
  const parsed = strictMatchupTargetSchema.safeParse(target);
  if (parsed.success) return parsed.data as StrictMatchupTarget;
  const keys = typeof target === "object" && target !== null ? Object.keys(target as object) : [];
  const metadataKeys = typeof target === "object" && target !== null && typeof (target as { matchupMetadata?: unknown }).matchupMetadata === "object" && (target as { matchupMetadata?: unknown }).matchupMetadata !== null ? Object.keys((target as { matchupMetadata: object }).matchupMetadata) : [];
  throw new LucraError(
    "strict_targeting",
    `Refusing a Lucra write that is not targeted by matchupId or a sole-key externalId (got keys [${keys.join(", ")}]${metadataKeys.length ? `, matchupMetadata keys [${metadataKeys.join(", ")}]` : ""}). A loose metadata bag writes to every matchup it matches.`,
  );
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

type PerCall = { record: CallRecord; ok: true; affected: string[]; failed: string[] } | { record: CallRecord; ok: false; error: LucraError };

function outcomeForError(code: LucraErrorCode): WriteOutcome {
  return code === "transport" || code === "server" ? "transport_error" : "rejected";
}

/** Fold the per-user calls into one outcome. `rejected` outranks `transport_error`, which outranks `partial`. */
export function classifyWrite(calls: PerCall[]): Pick<ScoreWriteResult, "outcome" | "affectedMatchupIds" | "failedMatchupIds" | "httpStatus" | "error"> {
  const affected = new Set<string>();
  const failed = new Set<string>();
  let outcome: WriteOutcome = "accepted";
  let error: ScoreWriteResult["error"] = null;
  let httpStatus: number | null = null;
  const rank: Record<WriteOutcome, number> = { accepted: 0, partial: 1, transport_error: 2, rejected: 3 };
  const bump = (next: WriteOutcome, err: ScoreWriteResult["error"]) => {
    if (rank[next] > rank[outcome]) {
      outcome = next;
      error = err;
    }
  };
  for (const call of calls) {
    const status = call.record.response?.status ?? null;
    if (status !== null && (httpStatus === null || status > httpStatus)) httpStatus = status;
    if (!call.ok) {
      bump(outcomeForError(call.error.code), { code: call.error.code, message: call.error.message });
      continue;
    }
    for (const id of call.affected) affected.add(id);
    for (const id of call.failed) failed.add(id);
    if (call.failed.length > 0) bump("partial", { code: "validation", message: `Lucra reported failed matchups: ${call.failed.join(", ")}` });
    else if (call.affected.length === 0) bump("rejected", { code: "not_participant", message: "Lucra accepted the request but wrote to no matchup; the user is not a participant of the target." });
  }
  return { outcome, affectedMatchupIds: [...affected], failedMatchupIds: [...failed], httpStatus, error };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

class Adapter implements LucraAdapter {
  readonly mode: LucraMode;
  readonly interpretation: MatcherInterpretation;
  readonly mock: LucraMock | null;
  private readonly client: LucraClient;

  constructor(options: AdapterOptions) {
    this.mode = options.mode;
    this.interpretation = options.interpretation;
    const clock = options.clock ?? systemClock;
    if (options.mode === "mock") {
      const mock = createLucraMock({ apiKey: MOCK_API_KEY, webhookSecret: options.webhookSecret ?? "", interpretation: options.interpretation, clock });
      this.mock = mock;
      const mockFetch: FetchLike = async (url, init) => {
        const { pathname, search } = new URL(url);
        const res = mock.handle({ method: init.method, path: `${pathname}${search}`, headers: init.headers, body: init.body ?? null });
        return { status: res.status, text: async () => JSON.stringify(res.body) };
      };
      this.client = createLucraClient({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY, fetch: mockFetch, clock, sleep: () => Promise.resolve(), ...options.client });
    } else {
      if (!options.apiKey || !options.baseUrl) throw new Error(`lucra: LUCRA_MODE=${options.mode} needs LUCRA_BASE_URL and LUCRA_BACKEND_API_KEY`);
      this.mock = null;
      this.client = createLucraClient({ baseUrl: options.baseUrl, apiKey: options.apiKey, clock, ...options.client });
    }
  }

  async submitScores(input: ScoreWriteInput): Promise<ScoreWriteResult> {
    const target = assertStrictTarget(input.target);
    const endpoint: WriteEndpoint = input.endpoint ?? "pool_tournament";
    if (input.userScores.length === 0) throw new LucraError("validation", "A score write needs at least one user score.");
    const criteria = { ...target, ...(input.gameId !== undefined ? { gameId: input.gameId } : {}), ...(input.locationId !== undefined ? { locationId: input.locationId } : {}) };

    const perCall: PerCall[] = [];
    if (endpoint === "generic") {
      perCall.push(await this.oneCall(() => this.client.submitGenericScores({ object: { ...criteria, userScores: input.userScores } })));
    } else {
      // The type-specific endpoint takes one userScore per request; the calls run together.
      const results = await Promise.all(input.userScores.map((userScore) => this.oneCall(() => this.client.submitPoolTournamentScore({ object: { ...criteria, userScore } }))));
      perCall.push(...results);
    }
    const classified = classifyWrite(perCall);
    log.info("lucra: score write", { endpoint, outcome: classified.outcome, calls: perCall.length, affected: classified.affectedMatchupIds.length, failed: classified.failedMatchupIds.length, status: classified.httpStatus });
    return { ...classified, endpoint, calls: perCall.map((c) => c.record) };
  }

  private async oneCall(run: () => Promise<{ data: { data: { affectedMatchupIds: string[]; failedMatchupIds: string[] } }; record: CallRecord }>): Promise<PerCall> {
    try {
      const { data, record } = await run();
      return { record, ok: true, affected: data.data.affectedMatchupIds, failed: data.data.failedMatchupIds };
    } catch (err) {
      if (isLucraError(err) && err.detail.record) return { record: err.detail.record, ok: false, error: err };
      throw err;
    }
  }

  async queryMatchups(input: QueryInput): Promise<{ matchupIds: string[]; record: CallRecord }> {
    const { data, record } = await this.client.queryPoolTournaments({ object: input });
    return { matchupIds: data.data, record };
  }

  async assertSingleMatchup(target: StrictMatchupTarget): Promise<{ matchupId: string; count: number; record: CallRecord }> {
    const strict = assertStrictTarget(target);
    const { matchupIds, record } = await this.queryMatchups(strict);
    const count = matchupIds.length;
    log.info("lucra: pre-write matchup assertion", { path: LUCRA_PATHS.poolTournamentQuery, target: "matchupId" in strict ? `matchupId=${strict.matchupId}` : `externalId=${strict.matchupMetadata.externalId}`, count });
    if (count !== 1 || !matchupIds[0]) {
      throw new LucraError(count === 0 ? "matchup_not_found" : "ambiguous_matchup", count === 0 ? "The pre-write query returned no matchup for this tournament." : `The pre-write query returned ${count} matchups for this tournament; refusing to write until exactly one matches.`, {
        record,
        body: { count, matchupIds },
      });
    }
    return { matchupId: matchupIds[0], count, record };
  }

  async getTournament(matchupId: string): Promise<{ matchup: TournamentMatchup; record: CallRecord }> {
    const { data, record } = await this.client.getPoolTournament(matchupId);
    return { matchup: data.matchup, record };
  }

  async completeTournament(matchupId: string, request: CompleteTournamentRequest): Promise<{ response: CompleteTournamentResponse; record: CallRecord }> {
    const { data, record } = await this.client.completePoolTournament(matchupId, request);
    return { response: data, record };
  }
}

export function createLucraAdapter(options: AdapterOptions): LucraAdapter {
  return new Adapter(options);
}

declare global {
  var __sideoutLucraAdapter: LucraAdapter | undefined;
}

/** The secret the mock signs webhooks with: the configured one, else the mock default. Only ever consulted in mock mode. */
export function mockWebhookSecret(): string {
  return env.LUCRA_WEBHOOK_SECRET ?? MOCK_WEBHOOK_SECRET;
}

/**
 * The process-wide adapter, built from the environment on first use. Kept on
 * `globalThis` because the server build bundles this module into every
 * route's chunk: a module-level singleton would give each route its own mock.
 */
export function getLucraAdapter(): LucraAdapter {
  globalThis.__sideoutLucraAdapter ??= createLucraAdapter({
    mode: env.LUCRA_MODE,
    interpretation: env.LUCRA_MATCHER_INTERPRETATION,
    baseUrl: env.LUCRA_BASE_URL,
    apiKey: env.LUCRA_BACKEND_API_KEY,
    webhookSecret: mockWebhookSecret(),
  });
  return globalThis.__sideoutLucraAdapter;
}

/** Replace the process-wide adapter (tests install a fresh, unseeded one per database). */
export function installLucraAdapter(adapter: LucraAdapter | undefined): void {
  globalThis.__sideoutLucraAdapter = adapter;
}

export { LUCRA_BASE_URLS };
