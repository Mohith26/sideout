import type { z } from "zod";
import { systemClock, type Clock } from "@/lib/clock";
import { LUCRA_API_KEY_HEADER, LUCRA_ERROR_BODIES, LUCRA_PATHS, LUCRA_WEBHOOK_EVENTS } from "@/lucra/endpoints";
import { resolveMatchups, type MatcherInterpretation } from "@/lucra/matcher";
import {
  completeTournamentRequestSchema,
  genericUserScoreRequestSchema,
  poolTournamentQueryRequestSchema,
  poolTournamentUserScoreRequestSchema,
  recreationalUserScoreRequestSchema,
  type Metadata,
  type TournamentMatchup,
  type UserScoreEntry,
} from "@/lucra/types";
import { signWebhookBody } from "@/lucra/webhook-signature";

/**
 * An in-memory Lucra (spec §8.2), faithful to the documented surface so that
 * swapping to sandbox surfaces no surprises:
 *
 * - The API key header is enforced; the wrong or missing key gets the exact
 *   `"Invalid Api Key."` body with a 401.
 * - The three documented identifier errors are returned byte for byte.
 * - Matchups and users resolve through `matcher.ts`, including the documented
 *   multiple-match behaviour: a loose query writes to every matchup that
 *   scores at least 1.0 and has the user as a participant.
 * - Tournaments never auto-settle. `attemptFinished: true` does not close
 *   anything; only `POST /pool-tournament/:id/complete` (the organizer's close)
 *   moves a tournament to CLOSED and emits `TournamentCompleted`.
 * - Recreational games configured `track_results = AUTOMATED` close and
 *   distribute prizes the moment every participant has `attemptFinished: true`
 *   (documented, and deliberately reachable only through the recreational and
 *   generic endpoints, never the tournament one).
 * - Overwrite rules: a score overwrites the prior score unless the user's
 *   attempt is finished, the tournament is closed, or the user rebought
 *   another attempt (`rebuy`, an explicit mock operation).
 *
 * OPEN: (§7.4) the documentation says a finished attempt is not overwritten
 * but does not say whether such a write is reported as a failure. The mock
 * records the matchup as affected and the user as `locked` in the ingestion
 * log (the score is unchanged); a write to a CLOSED tournament lands in
 * `failedMatchupIds`. Both are recorded so a real answer can replace them.
 *
 * Webhooks: every emitted event is signed exactly as Lucra documents and
 * queued on `pendingWebhooks`; the server drains the queue into the app's own
 * receiver. The mock never opens a socket.
 */

export const MOCK_API_KEY = "sideout-mock-backend-key";
export const MOCK_BASE_URL = "http://lucra.mock";

export type MockMatchupKind = "pool_tournament" | "recreational";
export type MockMatchupStatus = "OPEN" | "CONFIRMED" | "CLOSED" | "CANCELED";
export type ScoringType = "HIGHEST_SCORE" | "LOWEST_SCORE";
export type TrackResults = "AUTOMATED" | "MANUAL";
export type HowToWin = "HIGHEST_SCORE" | "LOWEST_SCORE" | "FASTEST_TIME";

/**
 * `SDKLucraUser.accountStatus` as the web SDK's types enumerate it. The mock
 * keeps the ones the browser stand-in resolves flows from.
 */
export const MOCK_ACCOUNT_STATUSES = ["UNVERIFIED", "VERIFIED", "AGE_ASSURED_VERIFIED", "BLOCKED"] as const;
export type MockAccountStatus = (typeof MOCK_ACCOUNT_STATUSES)[number];

export interface MockUser {
  id: string;
  username: string;
  phoneNumber: string | null;
  metadata: Metadata;
  /** What the SDK reports as `accountStatus`; `BLOCKED` is the sealed `NotAllowed`. */
  accountStatus: MockAccountStatus;
  /** Whether the free-to-play demographic form has been completed; false is `DemographicInformationMissing`. */
  demographicsComplete: boolean;
  /** Wallet balance; the SDK reports it in dollars. */
  balanceCents: number;
  /** `UserKYCVerified` fires once per user (documented); the mock keeps that promise. */
  kycVerifiedEmitted: boolean;
}

export interface MockParticipant {
  userId: string;
  score: number | null;
  scoreMetadata: Metadata | null;
  attemptFinished: boolean;
  /** 1-based; a rebuy opens the next one. */
  attempt: number;
  updatedAt: number | null;
}

export interface MockRewardEntry {
  position: number;
  positionOverride: number | null;
  value: number;
  userId: string | null;
}

export interface MockMatchup {
  id: string;
  kind: MockMatchupKind;
  status: MockMatchupStatus;
  title: string;
  gameId: string | null;
  locationIds: string[];
  metadata: Metadata;
  maxAttempts: number;
  buyInAmount: number;
  scoringType: ScoringType;
  participants: Map<string, MockParticipant>;
  rewardStructure: MockRewardEntry[];
  trackResults: TrackResults | null;
  howToWin: HowToWin | null;
  completed: { mode: "auto" | "manual" | "admin"; at: number; winnerUserIds: string[] } | null;
  createdAt: number;
}

export interface MockIngestion {
  at: number;
  path: string;
  request: unknown;
  resolvedMatchupIds: string[];
  affectedMatchupIds: string[];
  failedMatchupIds: string[];
  /** Users whose attempt was already finished: the write was accepted but their score left untouched. */
  lockedUserIds: string[];
  /** The user resolved for each entry, in request order; null where none was found. */
  userIds: Array<string | null>;
}

export interface MockWebhookDelivery {
  id: string;
  event: string;
  rawBody: string;
  signature: string;
  at: number;
}

export interface MockSeedUser {
  id: string;
  username: string;
  phoneNumber?: string | null;
  metadata: Metadata;
  accountStatus?: MockAccountStatus;
  demographicsComplete?: boolean;
  balanceCents?: number;
}

export interface MockSeedMatchup {
  id: string;
  kind: MockMatchupKind;
  title: string;
  gameId?: string | null;
  locationIds?: string[];
  metadata: Metadata;
  /** User ids; every one must be a seeded user. */
  participants: string[];
  status?: MockMatchupStatus;
  maxAttempts?: number;
  buyInAmount?: number;
  scoringType?: ScoringType;
  trackResults?: TrackResults | null;
  howToWin?: HowToWin | null;
  createdAt?: number;
}

export interface MockSeed {
  users: MockSeedUser[];
  matchups: MockSeedMatchup[];
}

export interface MockHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface MockHttpResponse {
  status: number;
  body: unknown;
}

export interface MockOptions {
  apiKey?: string;
  webhookSecret: string;
  interpretation?: MatcherInterpretation;
  clock?: Clock;
}

/** The serializable view `GET /api/rest/_mock/state` returns. */
export interface MockStateSnapshot {
  interpretation: MatcherInterpretation;
  users: MockUser[];
  matchups: Array<Omit<MockMatchup, "participants"> & { participants: MockParticipant[] }>;
  ingestions: MockIngestion[];
  webhooks: { pending: MockWebhookDelivery[]; delivered: MockWebhookDelivery[] };
}

const failure = (status: number, error: string): MockHttpResponse => ({ status, body: { status: "failure", error } });

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Validation failed";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function hasMatchupIdentifier(o: { matchupId?: string | undefined; matchupMetadata?: Metadata | undefined; gameId?: string | undefined; locationId?: string | undefined }): boolean {
  return o.matchupId !== undefined || o.matchupMetadata !== undefined || o.gameId !== undefined || o.locationId !== undefined;
}

export class LucraMock {
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly interpretation: MatcherInterpretation;
  private readonly clock: Clock;
  private users = new Map<string, MockUser>();
  private matchups = new Map<string, MockMatchup>();
  private ingestions: MockIngestion[] = [];
  readonly pendingWebhooks: MockWebhookDelivery[] = [];
  private deliveredWebhooks: MockWebhookDelivery[] = [];
  private webhookCounter = 0;

  constructor(options: MockOptions) {
    this.apiKey = options.apiKey ?? MOCK_API_KEY;
    this.webhookSecret = options.webhookSecret;
    this.interpretation = options.interpretation ?? "literal";
    this.clock = options.clock ?? systemClock;
  }

  // -- state ------------------------------------------------------------------

  reset(): void {
    this.users.clear();
    this.matchups.clear();
    this.ingestions = [];
    this.pendingWebhooks.length = 0;
    this.deliveredWebhooks = [];
  }

  seed(input: MockSeed): void {
    for (const u of input.users) this.addUser(u);
    for (const m of input.matchups) this.addMatchup(m);
  }

  addUser(u: MockSeedUser): MockUser {
    const accountStatus = u.accountStatus ?? "UNVERIFIED";
    const user: MockUser = {
      id: u.id,
      username: u.username,
      phoneNumber: u.phoneNumber ?? null,
      metadata: { ...u.metadata },
      accountStatus,
      demographicsComplete: u.demographicsComplete ?? true,
      balanceCents: u.balanceCents ?? 0,
      kycVerifiedEmitted: accountStatus === "VERIFIED" || accountStatus === "AGE_ASSURED_VERIFIED",
    };
    this.users.set(user.id, user);
    return user;
  }

  // -- the SDK's side of a user (driven by the browser stand-in through src/server/lucra-sdk-mock.ts) --

  findUserByPhone(phoneNumber: string): MockUser | undefined {
    return [...this.users.values()].find((u) => u.phoneNumber === phoneNumber);
  }

  findUserByExternalId(externalId: string): MockUser | undefined {
    return [...this.users.values()].find((u) => u.metadata.externalId === externalId);
  }

  /** A phone sign-in: the existing account, or a new one plus the documented `UserSignedUp`. */
  signIn(input: { id: string; username: string; phoneNumber: string; metadata?: Metadata }): { user: MockUser; created: boolean } {
    const existing = this.findUserByPhone(input.phoneNumber);
    if (existing) return { user: existing, created: false };
    const user = this.addUser({ id: input.id, username: input.username, phoneNumber: input.phoneNumber, metadata: input.metadata ?? {} });
    this.emit(LUCRA_WEBHOOK_EVENTS.userSignedUp, { userId: user.id, email: null, username: user.username, phoneNumber: user.phoneNumber });
    return { user, created: true };
  }

  /** `sendMessage.userUpdated`: metadata is stored on the Lucra user (the documented user link). */
  setUserMetadata(userId: string, metadata: Metadata | null): MockUser {
    const user = this.users.get(userId);
    if (!user) throw new Error(`lucra mock: unknown user ${userId}`);
    user.metadata = { ...user.metadata, ...(metadata ?? {}) };
    return user;
  }

  /** The identity flow's outcome for this account; a first verification emits `UserKYCVerified`. */
  verifyIdentity(userId: string): "verified" | "not_allowed" | "demographics_required" {
    const user = this.users.get(userId);
    if (!user) throw new Error(`lucra mock: unknown user ${userId}`);
    if (user.accountStatus === "BLOCKED") return "not_allowed";
    if (!user.demographicsComplete) return "demographics_required";
    this.markVerified(user, "VERIFIED");
    return "verified";
  }

  /** The demographic form: completes the free-to-play requirement and, for an unverified account, age assurance. */
  completeDemographics(userId: string): MockUser {
    const user = this.users.get(userId);
    if (!user) throw new Error(`lucra mock: unknown user ${userId}`);
    user.demographicsComplete = true;
    // OPEN: (§17.7-adjacent) what a free-to-play tenant's account becomes once the form is in is not published;
    // the mock reads the SDK's own `AGE_ASSURED_VERIFIED` status literally and reports it as a first verification.
    if (user.accountStatus === "UNVERIFIED") this.markVerified(user, "AGE_ASSURED_VERIFIED");
    return user;
  }

  private markVerified(user: MockUser, status: "VERIFIED" | "AGE_ASSURED_VERIFIED"): void {
    user.accountStatus = status;
    if (!user.kycVerifiedEmitted) {
      user.kycVerifiedEmitted = true;
      this.emit(LUCRA_WEBHOOK_EVENTS.userKycVerified, { userId: user.id });
    }
  }

  deposit(userId: string, amountCents: number): MockUser {
    const user = this.users.get(userId);
    if (!user) throw new Error(`lucra mock: unknown user ${userId}`);
    if (user.accountStatus === "BLOCKED") throw new Error("lucra mock: account is blocked");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("lucra mock: deposit must be a positive whole number of cents");
    user.balanceCents += amountCents;
    this.emit(LUCRA_WEBHOOK_EVENTS.fundsDeposited, { userId: user.id, properties: { method: "CARD", amount: amountCents / 100, fee: 0, transactionStatus: "COMPLETED", transactionId: `mock-deposit-${this.webhookCounter + 1}` } });
    return user;
  }

  /** False when the balance does not cover it (the SDK's `INSUFFICIENT_FUNDS`). */
  withdraw(userId: string, amountCents: number): boolean {
    const user = this.users.get(userId);
    if (!user) throw new Error(`lucra mock: unknown user ${userId}`);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("lucra mock: withdrawal must be a positive whole number of cents");
    if (user.balanceCents < amountCents) return false;
    user.balanceCents -= amountCents;
    return true;
  }

  addMatchup(m: MockSeedMatchup): MockMatchup {
    const kind = m.kind;
    const matchup: MockMatchup = {
      id: m.id,
      kind,
      status: m.status ?? "OPEN",
      title: m.title,
      gameId: m.gameId ?? null,
      locationIds: [...(m.locationIds ?? [])],
      metadata: { ...m.metadata },
      maxAttempts: m.maxAttempts ?? 1,
      buyInAmount: m.buyInAmount ?? 0,
      scoringType: m.scoringType ?? "HIGHEST_SCORE",
      participants: new Map(),
      rewardStructure: [],
      trackResults: kind === "recreational" ? (m.trackResults ?? "MANUAL") : null,
      howToWin: kind === "recreational" ? (m.howToWin ?? "HIGHEST_SCORE") : null,
      completed: null,
      createdAt: m.createdAt ?? this.clock.now(),
    };
    for (const userId of m.participants) {
      if (!this.users.has(userId)) throw new Error(`lucra mock: participant ${userId} is not a seeded user`);
      matchup.participants.set(userId, { userId, score: null, scoreMetadata: null, attemptFinished: false, attempt: 1, updatedAt: null });
    }
    this.matchups.set(matchup.id, matchup);
    return matchup;
  }

  /** A user joins a matchup (what the SDK's auto-join or a `TournamentUserJoined` would produce). */
  join(matchupId: string, userId: string): void {
    const matchup = this.requireMatchup(matchupId);
    if (!this.users.has(userId)) throw new Error(`lucra mock: unknown user ${userId}`);
    if (matchup.participants.has(userId)) return;
    matchup.participants.set(userId, { userId, score: null, scoreMetadata: null, attemptFinished: false, attempt: 1, updatedAt: null });
    if (matchup.kind === "pool_tournament") {
      const user = this.users.get(userId);
      this.emit(LUCRA_WEBHOOK_EVENTS.tournamentUserJoined, { newUserId: userId, userMetadata: user?.metadata ?? {}, matchup: this.serializeMatchup(matchup) });
    }
  }

  /** The user pays for another attempt: their score unlocks, `maxAttempts` permitting. */
  rebuy(matchupId: string, userId: string): boolean {
    const matchup = this.requireMatchup(matchupId);
    const p = matchup.participants.get(userId);
    if (!p || matchup.status === "CLOSED" || matchup.status === "CANCELED") return false;
    if (p.attempt >= matchup.maxAttempts) return false;
    p.attempt += 1;
    p.attemptFinished = false;
    return true;
  }

  getMatchup(id: string): MockMatchup | undefined {
    return this.matchups.get(id);
  }

  getUser(id: string): MockUser | undefined {
    return this.users.get(id);
  }

  listMatchups(): MockMatchup[] {
    return [...this.matchups.values()];
  }

  listIngestions(): MockIngestion[] {
    return [...this.ingestions];
  }

  private requireMatchup(id: string): MockMatchup {
    const m = this.matchups.get(id);
    if (!m) throw new Error(`lucra mock: unknown matchup ${id}`);
    return m;
  }

  state(): MockStateSnapshot {
    return {
      interpretation: this.interpretation,
      users: [...this.users.values()].map((u) => ({ ...u, metadata: { ...u.metadata } })),
      matchups: [...this.matchups.values()].map((m) => ({ ...m, metadata: { ...m.metadata }, locationIds: [...m.locationIds], rewardStructure: [...m.rewardStructure], participants: [...m.participants.values()] })),
      ingestions: [...this.ingestions],
      webhooks: { pending: [...this.pendingWebhooks], delivered: [...this.deliveredWebhooks] },
    };
  }

  // -- webhooks ---------------------------------------------------------------

  /** Take every queued delivery, marking them delivered. */
  drainWebhooks(): MockWebhookDelivery[] {
    const out = this.pendingWebhooks.splice(0, this.pendingWebhooks.length);
    this.deliveredWebhooks.push(...out);
    return out;
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    const body = { event, tenantId: "sideout-mock-tenant", ...payload };
    const rawBody = JSON.stringify(body);
    this.webhookCounter += 1;
    const delivery: MockWebhookDelivery = { id: `mock-webhook-${this.webhookCounter}`, event, rawBody, signature: signWebhookBody(rawBody, this.webhookSecret), at: this.clock.now() };
    this.pendingWebhooks.push(delivery);
  }

  // -- HTTP surface -----------------------------------------------------------

  handle(request: MockHttpRequest): MockHttpResponse {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) headers[k.toLowerCase()] = v;
    if (headers[LUCRA_API_KEY_HEADER.toLowerCase()] !== this.apiKey) return failure(401, LUCRA_ERROR_BODIES.invalidApiKey);

    const path = request.path.split("?")[0] ?? request.path;
    const method = request.method.toUpperCase();
    const json = (): { ok: true; value: unknown } | { ok: false; response: MockHttpResponse } => {
      if (request.body === null || request.body.trim() === "") return { ok: true, value: {} };
      try {
        return { ok: true, value: JSON.parse(request.body) as unknown };
      } catch {
        return { ok: false, response: failure(400, "Request body must be valid JSON") };
      }
    };

    if (method === "POST" && path === LUCRA_PATHS.poolTournamentUserScore) {
      const body = json();
      return body.ok ? this.poolTournamentUserScore(body.value) : body.response;
    }
    if (method === "POST" && path === LUCRA_PATHS.genericUserScore) {
      const body = json();
      return body.ok ? this.genericUserScore(body.value) : body.response;
    }
    if (method === "POST" && path === LUCRA_PATHS.recreationalUserScore) {
      const body = json();
      return body.ok ? this.recreationalUserScore(body.value) : body.response;
    }
    if (method === "POST" && path === LUCRA_PATHS.poolTournamentQuery) {
      const body = json();
      return body.ok ? this.poolTournamentQuery(body.value) : body.response;
    }
    if (method === "GET" && path === LUCRA_PATHS.mockState) return { status: 200, body: this.state() };

    const complete = path.match(/^\/api\/rest\/pool-tournament\/([^/]+)\/complete$/);
    if (method === "POST" && complete?.[1]) {
      const body = json();
      return body.ok ? this.completePoolTournament(decodeURIComponent(complete[1]), body.value) : body.response;
    }
    const get = path.match(/^\/api\/rest\/pool-tournament\/([^/]+)$/);
    if (method === "GET" && get?.[1]) {
      const matchup = this.matchups.get(decodeURIComponent(get[1]));
      if (!matchup || matchup.kind !== "pool_tournament") return failure(404, LUCRA_ERROR_BODIES.matchupNotFound);
      return { status: 200, body: { matchup: this.serializeMatchup(matchup) } };
    }
    return failure(404, "Not found");
  }

  // -- resolution -------------------------------------------------------------

  private resolveMatchupCriteria(criteria: { matchupId?: string | undefined; matchupMetadata?: Metadata | undefined; gameId?: string | undefined; locationId?: string | undefined }, kinds: readonly MockMatchupKind[]): MockMatchup[] {
    if (criteria.matchupId !== undefined) {
      const m = this.matchups.get(criteria.matchupId);
      return m && kinds.includes(m.kind) && m.status !== "CANCELED" ? [m] : [];
    }
    let candidates = [...this.matchups.values()].filter((m) => kinds.includes(m.kind) && m.status !== "CANCELED");
    if (criteria.gameId !== undefined) candidates = candidates.filter((m) => m.gameId === criteria.gameId);
    if (criteria.locationId !== undefined) candidates = candidates.filter((m) => m.locationIds.includes(criteria.locationId as string));
    if (criteria.matchupMetadata !== undefined) {
      return resolveMatchups(criteria.matchupMetadata, candidates, this.interpretation, (m) => m.metadata).map((h) => h.record);
    }
    return candidates;
  }

  private resolveUser(id: { userId?: string | undefined; phoneNumber?: string | undefined; userMetadata?: Metadata | undefined }): MockUser | null {
    if (id.userId !== undefined) return this.users.get(id.userId) ?? null;
    if (id.phoneNumber !== undefined) return [...this.users.values()].find((u) => u.phoneNumber === id.phoneNumber) ?? null;
    if (id.userMetadata !== undefined) {
      const hits = resolveMatchups(id.userMetadata, [...this.users.values()], this.interpretation, (u) => u.metadata);
      return hits[0]?.record ?? null;
    }
    return null;
  }

  // -- score ingestion ----------------------------------------------------------

  /** Apply one entry to one matchup. Returns how it landed. */
  private applyScore(matchup: MockMatchup, user: MockUser, entry: UserScoreEntry): "applied" | "locked" | "failed" | "not_participant" {
    const p = matchup.participants.get(user.id);
    if (!p) return "not_participant";
    if (matchup.status === "CLOSED") return "failed";
    if (p.attemptFinished) return "locked";
    p.score = entry.score;
    p.scoreMetadata = entry.metadata ? { ...entry.metadata } : null;
    p.attemptFinished = entry.attemptFinished === true;
    p.updatedAt = this.clock.now();
    return "applied";
  }

  /** Recreational `AUTOMATED` games settle once every participant has finished. Tournaments never enter here. */
  private maybeAutoSettle(matchup: MockMatchup): void {
    if (matchup.kind !== "recreational" || matchup.trackResults !== "AUTOMATED" || matchup.status === "CLOSED") return;
    const participants = [...matchup.participants.values()];
    if (participants.length === 0 || !participants.every((p) => p.attemptFinished && p.score !== null)) return;
    const scores = participants.map((p) => p.score as number);
    const best = matchup.howToWin === "HIGHEST_SCORE" ? Math.max(...scores) : Math.min(...scores);
    const winners = participants.filter((p) => p.score === best).map((p) => p.userId);
    matchup.status = "CLOSED";
    matchup.completed = { mode: "auto", at: this.clock.now(), winnerUserIds: winners };
    matchup.rewardStructure = winners.map((userId, i) => ({ position: 1, positionOverride: i === 0 ? null : 1, value: 0, userId }));
    this.emit("RecreationalGameCompleted", { matchup: this.serializeMatchup(matchup), winnerUserIds: winners });
  }

  private poolTournamentUserScore(raw: unknown): MockHttpResponse {
    const parsed = poolTournamentUserScoreRequestSchema.safeParse(raw);
    if (!parsed.success) return failure(400, firstIssue(parsed.error));
    const { object } = parsed.data;
    if (!hasMatchupIdentifier(object)) return failure(400, LUCRA_ERROR_BODIES.noMatchupIdentifiers);
    const matchups = this.resolveMatchupCriteria(object, ["pool_tournament"]);
    if (matchups.length === 0) return failure(404, LUCRA_ERROR_BODIES.matchupNotFound);
    const user = this.resolveUser(object.userScore);
    if (!user) return failure(404, LUCRA_ERROR_BODIES.userNotFound);
    const ingestion: MockIngestion = { at: this.clock.now(), path: LUCRA_PATHS.poolTournamentUserScore, request: raw, resolvedMatchupIds: matchups.map((m) => m.id), affectedMatchupIds: [], failedMatchupIds: [], lockedUserIds: [], userIds: [user.id] };
    for (const matchup of matchups) {
      const landed = this.applyScore(matchup, user, object.userScore);
      if (landed === "not_participant") continue;
      if (landed === "failed") ingestion.failedMatchupIds.push(matchup.id);
      else {
        ingestion.affectedMatchupIds.push(matchup.id);
        if (landed === "locked") ingestion.lockedUserIds.push(user.id);
      }
      // Tournaments have no auto-settlement (§7.4): nothing further happens here.
    }
    this.ingestions.push(ingestion);
    return { status: 200, body: { status: "success", data: { affectedMatchupIds: ingestion.affectedMatchupIds, failedMatchupIds: ingestion.failedMatchupIds } } };
  }

  private recreationalUserScore(raw: unknown): MockHttpResponse {
    const parsed = recreationalUserScoreRequestSchema.safeParse(raw);
    if (!parsed.success) return failure(400, firstIssue(parsed.error));
    const { object } = parsed.data;
    if (!hasMatchupIdentifier(object)) return failure(400, LUCRA_ERROR_BODIES.noMatchupIdentifiers);
    const matchups = this.resolveMatchupCriteria(object, ["recreational"]);
    if (matchups.length === 0) return failure(404, LUCRA_ERROR_BODIES.matchupNotFound);
    const users = object.userScores.map((entry) => this.resolveUser(entry));
    if (users.some((u) => u === null)) return failure(404, LUCRA_ERROR_BODIES.userNotFound);
    const resolved = users as MockUser[];
    const ingestion: MockIngestion = { at: this.clock.now(), path: LUCRA_PATHS.recreationalUserScore, request: raw, resolvedMatchupIds: matchups.map((m) => m.id), affectedMatchupIds: [], failedMatchupIds: [], lockedUserIds: [], userIds: resolved.map((u) => u.id) };
    this.ingestRecreational(matchups, resolved, object.userScores, ingestion);
    this.ingestions.push(ingestion);
    return { status: 200, body: { status: "success", data: { affectedMatchupIds: ingestion.affectedMatchupIds } } };
  }

  /** All identified users must be participants of a recreational matchup for it to take the write. */
  private ingestRecreational(matchups: readonly MockMatchup[], users: readonly MockUser[], entries: readonly UserScoreEntry[], ingestion: MockIngestion): void {
    for (const matchup of matchups) {
      if (!users.every((u) => matchup.participants.has(u.id))) continue;
      let touched = false;
      users.forEach((user, i) => {
        const entry = entries[i];
        if (!entry) return;
        const landed = this.applyScore(matchup, user, entry);
        if (landed === "applied" || landed === "locked") touched = true;
        if (landed === "locked") ingestion.lockedUserIds.push(user.id);
      });
      if (touched) {
        ingestion.affectedMatchupIds.push(matchup.id);
        this.maybeAutoSettle(matchup);
      }
    }
  }

  private genericUserScore(raw: unknown): MockHttpResponse {
    const parsed = genericUserScoreRequestSchema.safeParse(raw);
    if (!parsed.success) return failure(400, firstIssue(parsed.error));
    const { object } = parsed.data;
    if (!hasMatchupIdentifier(object)) return failure(400, LUCRA_ERROR_BODIES.noMatchupIdentifiers);
    const matchups = this.resolveMatchupCriteria(object, ["pool_tournament", "recreational"]);
    if (matchups.length === 0) return failure(404, LUCRA_ERROR_BODIES.matchupNotFound);
    const users = object.userScores.map((entry) => this.resolveUser(entry));
    if (users.some((u) => u === null)) return failure(404, LUCRA_ERROR_BODIES.userNotFound);
    const resolved = users as MockUser[];
    const ingestion: MockIngestion = { at: this.clock.now(), path: LUCRA_PATHS.genericUserScore, request: raw, resolvedMatchupIds: matchups.map((m) => m.id), affectedMatchupIds: [], failedMatchupIds: [], lockedUserIds: [], userIds: resolved.map((u) => u.id) };
    // Tournaments: each entry independently. Never auto-settled.
    for (const matchup of matchups.filter((m) => m.kind === "pool_tournament")) {
      resolved.forEach((user, i) => {
        const entry = object.userScores[i];
        if (!entry) return;
        const landed = this.applyScore(matchup, user, entry);
        if (landed === "not_participant") return;
        if (landed === "failed") ingestion.failedMatchupIds.push(matchup.id);
        else {
          ingestion.affectedMatchupIds.push(matchup.id);
          if (landed === "locked") ingestion.lockedUserIds.push(user.id);
        }
      });
    }
    // Recreational games: all entries together, with auto-settlement where configured.
    this.ingestRecreational(
      matchups.filter((m) => m.kind === "recreational"),
      resolved,
      object.userScores,
      ingestion,
    );
    ingestion.affectedMatchupIds = [...new Set(ingestion.affectedMatchupIds)];
    ingestion.failedMatchupIds = [...new Set(ingestion.failedMatchupIds)];
    this.ingestions.push(ingestion);
    return { status: 200, body: { status: "success", data: { affectedMatchupIds: ingestion.affectedMatchupIds, failedMatchupIds: ingestion.failedMatchupIds } } };
  }

  // -- query, read, complete ----------------------------------------------------

  private poolTournamentQuery(raw: unknown): MockHttpResponse {
    const parsed = poolTournamentQueryRequestSchema.safeParse(raw);
    if (!parsed.success) return failure(400, firstIssue(parsed.error));
    const { object } = parsed.data;
    if (!hasMatchupIdentifier(object)) return failure(400, LUCRA_ERROR_BODIES.noMatchupIdentifiers);
    if (object.matchupId !== undefined && !this.matchups.has(object.matchupId)) return failure(404, LUCRA_ERROR_BODIES.matchupNotFound);
    let matchups = this.resolveMatchupCriteria(object, ["pool_tournament"]);
    if (object.userId !== undefined || object.phoneNumber !== undefined || object.userMetadata !== undefined) {
      const user = this.resolveUser(object);
      if (!user) return failure(404, LUCRA_ERROR_BODIES.userNotFound);
      matchups = matchups.filter((m) => m.participants.has(user.id));
    }
    return { status: 200, body: { status: "success", data: matchups.map((m) => m.id) } };
  }

  private completePoolTournament(matchupId: string, raw: unknown): MockHttpResponse {
    const matchup = this.matchups.get(matchupId);
    if (!matchup || matchup.kind !== "pool_tournament") return failure(404, LUCRA_ERROR_BODIES.matchupNotFound);
    const parsed = completeTournamentRequestSchema.safeParse(raw);
    if (!parsed.success) return failure(400, firstIssue(parsed.error));
    if (matchup.status === "CLOSED") return failure(400, "Tournament is already closed");
    if (matchup.status === "CANCELED") return failure(400, "Tournament is canceled");
    const unassignedUserIds: string[] = [];
    const rewardStructure: MockRewardEntry[] = [];
    for (const entry of parsed.data.object.paymentStructure) {
      if (!matchup.participants.has(entry.userId)) {
        unassignedUserIds.push(entry.userId);
        rewardStructure.push({ position: entry.position, positionOverride: entry.positionOverride ?? null, value: entry.value, userId: null });
        continue;
      }
      rewardStructure.push({ position: entry.position, positionOverride: entry.positionOverride ?? null, value: entry.value, userId: entry.userId });
    }
    matchup.rewardStructure = rewardStructure;
    matchup.status = "CLOSED";
    matchup.completed = { mode: "manual", at: this.clock.now(), winnerUserIds: rewardStructure.filter((r) => r.userId !== null).map((r) => r.userId as string) };
    for (const p of matchup.participants.values()) p.attemptFinished = true;
    this.emit(LUCRA_WEBHOOK_EVENTS.tournamentCompleted, { mode: "manual", matchup: this.serializeMatchup(matchup) });
    const totals = { totalPoolAmount: matchup.buyInAmount * matchup.participants.size, rewardStructure: matchup.rewardStructure };
    return { status: 200, body: { status: "success", data: totals, unassignedUserIds } };
  }

  /** The documented "Get Tournament" shape (the same object rides inside every tournament webhook). */
  serializeMatchup(m: MockMatchup): TournamentMatchup {
    const ranked = [...m.participants.values()].filter((p) => p.score !== null).sort((x, y) => (m.scoringType === "HIGHEST_SCORE" ? (y.score as number) - (x.score as number) : (x.score as number) - (y.score as number)));
    const position = new Map(ranked.map((p, i) => [p.userId, i + 1]));
    return {
      id: m.id,
      status: m.status,
      type: "CASH_FIXED",
      tenantId: "sideout-mock-tenant",
      gameId: m.gameId,
      title: m.title,
      metadata: { ...m.metadata },
      metadataString: JSON.stringify(m.metadata),
      locationIds: [...m.locationIds],
      buyInAmount: m.buyInAmount,
      maxAttempts: m.maxAttempts,
      numberOfParticipants: m.participants.size,
      scoringType: m.scoringType,
      rewardStructure: m.rewardStructure.map((r) => ({ ...r, userName: r.userId ? (this.users.get(r.userId)?.username ?? null) : null, userMetadata: r.userId ? (this.users.get(r.userId)?.metadata ?? {}) : {} })),
      users: [...m.participants.values()].map((p) => {
        const user = this.users.get(p.userId);
        return {
          userId: p.userId,
          userName: user?.username ?? null,
          userMetadata: user?.metadata ?? {},
          position: position.get(p.userId) ?? null,
          positionOverride: null,
          score: p.score,
          metadataString: p.scoreMetadata ? JSON.stringify(p.scoreMetadata) : null,
          canSubmitNewScore: m.status !== "CLOSED" && !p.attemptFinished,
        };
      }),
    };
  }
}

export function createLucraMock(options: MockOptions): LucraMock {
  return new LucraMock(options);
}
