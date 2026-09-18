import type { z } from "zod";
import { systemClock, type Clock } from "@/lib/clock";
import { errorMessage, log } from "@/lib/log";
import { LUCRA_API_KEY_HEADER, LUCRA_PATHS, REDACTED } from "@/lucra/endpoints";
import { codeForFailureBody, isLucraFailureBody, LucraError, type LucraErrorCode } from "@/lucra/errors";

export type { CallRecord };
import {
  completeTournamentRequestSchema,
  completeTournamentResponseSchema,
  genericUserScoreRequestSchema,
  getTournamentResponseSchema,
  poolTournamentQueryRequestSchema,
  poolTournamentUserScoreRequestSchema,
  queryResponseSchema,
  userScoreResponseSchema,
  type CompleteTournamentRequest,
  type CompleteTournamentResponse,
  type GenericUserScoreRequest,
  type GetTournamentResponse,
  type PoolTournamentQueryRequest,
  type PoolTournamentUserScoreRequest,
  type QueryResponse,
  type UserScoreResponse,
  type CallRecord,
} from "@/lucra/types";

/**
 * The real HTTP client (spec §8.1). Only `adapter.ts` constructs one.
 *
 * - 5s to response headers ("connect"), 10s total per try.
 * - Three retries on 5xx and transport errors, exponential backoff with
 *   jitter. A 4xx is never retried; neither is a body that fails its schema.
 * - Every 2xx body is parsed through zod; a mismatch is `LucraError("shape")`.
 * - The BACKEND key is redacted from every log line and from the `CallRecord`
 *   the caller persists as `lucra_score_submissions.request_json`; the raw key
 *   string is also scrubbed from any response text before it is kept.
 *
 * The client does not touch the database: the caller persists an attempt row
 * before calling and updates it from the returned (or thrown) `CallRecord`.
 * In mock mode the adapter hands this same class a fetch that routes into the
 * in-process mock, so the parsing and redaction paths are exercised there too.
 */

export const LUCRA_TIMEOUTS = { connectMs: 5_000, totalMs: 10_000 } as const;
export const LUCRA_RETRIES = 3;
export const LUCRA_BACKOFF_BASE_MS = 250;
export { REDACTED };

/** The slice of `fetch` the client relies on, so tests can supply a fake server. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface LucraClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1); drives the jitter. */
  random?: () => number;
  timeouts?: { connectMs: number; totalMs: number };
  retries?: number;
  backoffBaseMs?: number;
}

export interface CallResult<T> {
  data: T;
  record: CallRecord;
}

class TimeoutAbort extends Error {
  constructor(readonly phase: "connect" | "total") {
    super(`Lucra request timed out (${phase})`);
    this.name = "TimeoutAbort";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`lucra: path ${template} needs :${name}`);
    return encodeURIComponent(value);
  });
}

export class LucraClient {
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeouts: { connectMs: number; totalMs: number };
  private readonly retries: number;
  private readonly backoffBaseMs: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: LucraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.timeouts = options.timeouts ?? LUCRA_TIMEOUTS;
    this.retries = options.retries ?? LUCRA_RETRIES;
    this.backoffBaseMs = options.backoffBaseMs ?? LUCRA_BACKOFF_BASE_MS;
  }

  // -- typed calls ----------------------------------------------------------

  async submitPoolTournamentScore(request: PoolTournamentUserScoreRequest): Promise<CallResult<UserScoreResponse>> {
    return this.call("POST", LUCRA_PATHS.poolTournamentUserScore, poolTournamentUserScoreRequestSchema.parse(request), userScoreResponseSchema);
  }

  async submitGenericScores(request: GenericUserScoreRequest): Promise<CallResult<UserScoreResponse>> {
    return this.call("POST", LUCRA_PATHS.genericUserScore, genericUserScoreRequestSchema.parse(request), userScoreResponseSchema);
  }

  async queryPoolTournaments(request: PoolTournamentQueryRequest): Promise<CallResult<QueryResponse>> {
    return this.call("POST", LUCRA_PATHS.poolTournamentQuery, poolTournamentQueryRequestSchema.parse(request), queryResponseSchema);
  }

  async getPoolTournament(matchupId: string): Promise<CallResult<GetTournamentResponse>> {
    return this.call("GET", fillPath(LUCRA_PATHS.poolTournamentGet, { matchupId }), undefined, getTournamentResponseSchema);
  }

  async completePoolTournament(matchupId: string, request: CompleteTournamentRequest): Promise<CallResult<CompleteTournamentResponse>> {
    return this.call("POST", fillPath(LUCRA_PATHS.poolTournamentComplete, { matchupId }), completeTournamentRequestSchema.parse(request), completeTournamentResponseSchema);
  }

  // -- the one request path ---------------------------------------------------

  /** Replace the key wherever it could appear in text that is logged or persisted. */
  private scrub(text: string): string {
    return this.apiKey.length > 0 ? text.split(this.apiKey).join(REDACTED) : text;
  }

  private async fetchOnce(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const abort = (phase: "connect" | "total") => controller.abort(new TimeoutAbort(phase));
    const total = setTimeout(() => abort("total"), this.timeouts.totalMs);
    const connect = setTimeout(() => abort("connect"), this.timeouts.connectMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(connect);
      const text = await response.text();
      return { status: response.status, text };
    } finally {
      clearTimeout(total);
      clearTimeout(connect);
    }
  }

  private backoffMs(attempt: number): number {
    return this.backoffBaseMs * 2 ** attempt + Math.floor(this.random() * this.backoffBaseMs);
  }

  private async call<T>(method: "GET" | "POST", path: string, body: unknown, schema: z.ZodType<T>): Promise<CallResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json", [LUCRA_API_KEY_HEADER]: this.apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const record: CallRecord = {
      method,
      path,
      request: { headers: { ...headers, [LUCRA_API_KEY_HEADER]: REDACTED }, body: body ?? null },
      response: null,
      tries: 0,
      startedAt: this.clock.now(),
      finishedAt: this.clock.now(),
      error: null,
    };
    const fail = (code: LucraErrorCode, message: string, detail: { httpStatus?: number | null; body?: unknown } = {}): never => {
      record.error = { code, message: this.scrub(message) };
      record.finishedAt = this.clock.now();
      throw new LucraError(code, this.scrub(message), { ...detail, path, tries: record.tries, record });
    };

    let lastTransient: { code: "server" | "transport"; message: string; status: number | null; body: unknown } | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        const wait = this.backoffMs(attempt - 1);
        log.warn("lucra: retrying after a transient failure", { path, attempt, waitMs: wait, code: lastTransient?.code ?? null, status: lastTransient?.status ?? null });
        await this.sleep(wait);
      }
      record.tries = attempt + 1;
      let status: number;
      let text: string;
      try {
        ({ status, text } = await this.fetchOnce(url, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) }));
      } catch (err) {
        const message = err instanceof TimeoutAbort ? err.message : `Lucra request failed: ${errorMessage(err)}`;
        lastTransient = { code: "transport", message, status: null, body: null };
        continue;
      }
      text = this.scrub(text);
      let parsed: unknown = null;
      let json = true;
      try {
        parsed = text.trim() === "" ? null : (JSON.parse(text) as unknown);
      } catch {
        json = false;
        parsed = text;
      }
      record.response = { status, body: parsed };

      if (status >= 500) {
        lastTransient = { code: "server", message: `Lucra answered ${status}`, status, body: parsed };
        continue;
      }
      if (isLucraFailureBody(parsed)) {
        // Documented failure envelope, on any status: mapped exactly, never retried.
        return fail(codeForFailureBody(parsed), `Lucra refused the request: ${parsed.error}`, { httpStatus: status, body: parsed });
      }
      if (status >= 400) return fail("http", `Lucra answered ${status} without a failure body`, { httpStatus: status, body: parsed });
      if (!json) return fail("shape", `Lucra answered ${status} with a non-JSON body`, { httpStatus: status, body: parsed });
      const result = schema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
        return fail("shape", `Lucra answered ${status} with an unexpected shape: ${issues}`, { httpStatus: status, body: parsed });
      }
      record.finishedAt = this.clock.now();
      return { data: result.data, record };
    }

    const last = lastTransient ?? { code: "transport" as const, message: "Lucra request failed", status: null, body: null };
    log.error("lucra: giving up after retries", { path, tries: record.tries, code: last.code, status: last.status });
    return fail(last.code, `${last.message} (after ${record.tries} tries)`, { httpStatus: last.status, body: last.body });
  }
}

export function createLucraClient(options: LucraClientOptions): LucraClient {
  return new LucraClient(options);
}
