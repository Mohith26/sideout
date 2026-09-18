import { z } from "zod";
import type { ActorKind, BestOf, ConsensusState, MatchConsensus } from "@/db/schema";
import { formatSets, hashScoreline, judgeMatch, judgeSet, setTarget, type MatchVerdict, type Scoreline, type SetScore, type Side } from "@/domain/scoreline";
import type { TransitionActor, TransitionVerdict } from "@/domain/transitions";

/**
 * The score consensus state machine (spec §10), as pure rules. No I/O: the
 * service in `@/server/consensus` owns the transactions and calls these to
 * decide what to write.
 *
 *   awaiting_first
 *     └─ first team submits ──► awaiting_second
 *                                 ├─ second team submits identical hash ──► agreed
 *                                 └─ second team submits different hash ──► disputed
 *   disputed
 *     └─ organizer resolves ──► agreed   (records resolved_by_user_id)
 *   agreed
 *     └─ submit to Lucra ──► submitting ──► accepted | partial | rejected
 *   rejected / partial
 *     └─ organizer retries ──► submitting
 *
 * Everything from `agreed` onward belongs to the Lucra phase; the edges exist
 * here so the table is the whole machine, and `assertMayWriteToLucra` is the
 * one gate every Lucra write must pass (§10.5).
 */

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

export interface ConsensusEdge {
  from: ConsensusState;
  to: ConsensusState;
  /** What causes the edge, for documentation and audit detail. */
  event: ConsensusEvent;
  actors: readonly ActorKind[];
}

export const CONSENSUS_EVENTS = [
  "first_submission",
  "matching_submission",
  "conflicting_submission",
  "organizer_resolution",
  "lucra_submit",
  "lucra_accepted",
  "lucra_partial",
  "lucra_rejected",
  "organizer_retry",
] as const;
export type ConsensusEvent = (typeof CONSENSUS_EVENTS)[number];

const PLAYER: readonly ActorKind[] = ["player"];
const ORGANIZER: readonly ActorKind[] = ["organizer"];
const LUCRA_WRITER: readonly ActorKind[] = ["organizer", "system"];
const LUCRA_OUTCOME: readonly ActorKind[] = ["system", "lucra_webhook"];

export const CONSENSUS_TRANSITIONS: readonly ConsensusEdge[] = [
  { from: "awaiting_first", to: "awaiting_second", event: "first_submission", actors: PLAYER },
  { from: "awaiting_second", to: "agreed", event: "matching_submission", actors: PLAYER },
  { from: "awaiting_second", to: "disputed", event: "conflicting_submission", actors: PLAYER },
  { from: "disputed", to: "agreed", event: "organizer_resolution", actors: ORGANIZER },
  // Phase 4 (Lucra). Listed so the table is complete; no code takes them yet.
  { from: "agreed", to: "submitting", event: "lucra_submit", actors: LUCRA_WRITER },
  { from: "submitting", to: "accepted", event: "lucra_accepted", actors: LUCRA_OUTCOME },
  { from: "submitting", to: "partial", event: "lucra_partial", actors: LUCRA_OUTCOME },
  { from: "submitting", to: "rejected", event: "lucra_rejected", actors: LUCRA_OUTCOME },
  { from: "rejected", to: "submitting", event: "organizer_retry", actors: LUCRA_WRITER },
  { from: "partial", to: "submitting", event: "organizer_retry", actors: LUCRA_WRITER },
];

/** States in which a team may still submit or replace its own scoreline. */
export const OPEN_CONSENSUS_STATES: ReadonlySet<ConsensusState> = new Set(["awaiting_first", "awaiting_second"]);

/**
 * Consensus states that block closing a tournament (spec §10.7): a dispute
 * the organizer has not settled, or a Lucra write that is in flight or did
 * not fully land.
 */
export const CLOSE_BLOCKING_CONSENSUS_STATES: ReadonlySet<ConsensusState> = new Set(["disputed", "submitting", "rejected", "partial"]);

/** States from which a Lucra write may start: agreed, or a retry after a failed attempt. */
export const LUCRA_WRITABLE_STATES: ReadonlySet<ConsensusState> = new Set(["agreed", "rejected", "partial"]);

export function transitionConsensus(from: ConsensusState, to: ConsensusState, actor: TransitionActor): TransitionVerdict {
  if (from === to) return { ok: false, reason: `The consensus is already ${to}.` };
  const edge = CONSENSUS_TRANSITIONS.find((e) => e.from === from && e.to === to);
  if (!edge) return { ok: false, reason: `A consensus cannot go from ${from} to ${to}.` };
  if (!edge.actors.includes(actor.kind)) {
    return { ok: false, reason: `Only ${edge.actors.join(" or ")} can move a consensus from ${from} to ${to}; actor is ${actor.kind}.` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const CONSENSUS_ERROR_CODES = ["illegal_scoreline", "not_on_team", "already_submitted_by_team", "match_not_open", "invalid_transition"] as const;
export type ConsensusErrorCode = (typeof CONSENSUS_ERROR_CODES)[number];

/** A rule the submission broke; the route layer maps `code` to an envelope. */
export class ConsensusError extends Error {
  constructor(
    readonly code: ConsensusErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ConsensusError";
  }
}

// ---------------------------------------------------------------------------
// Submitted scorelines: what a team types, from its own side of the net
// ---------------------------------------------------------------------------

export const submittedSetSchema = z
  .object({
    setNumber: z.number().int().min(1).max(3),
    usPoints: z.number().int().min(0).max(99),
    themPoints: z.number().int().min(0).max(99),
  })
  .strict();
export type SubmittedSet = z.infer<typeof submittedSetSchema>;

/** Request body of `POST /api/matches/:id/scores`: the submitter's own points first. */
export const submittedScorelineSchema = z.object({ sets: z.array(submittedSetSchema).min(1).max(3) }).strict();
export type SubmittedScoreline = z.infer<typeof submittedScorelineSchema>;

/**
 * What `score_submissions.payload_json` stores: exactly what was typed, plus
 * the side the server resolved the submitter to. An organizer resolution is
 * stored from team A's side (`perspective: "a"`).
 */
export const storedSubmissionSchema = z.object({
  matchId: z.string().min(1),
  perspective: z.enum(["a", "b"]),
  sets: z.array(submittedSetSchema).min(1).max(3),
});
export type StoredSubmission = z.infer<typeof storedSubmissionSchema>;

/** Re-express a submitted scoreline in match orientation (team A's points first), ordered by set. */
export function toMatchOrientation(sets: readonly SubmittedSet[], perspective: Side): SetScore[] {
  return [...sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => ({
      setNumber: s.setNumber,
      teamAPoints: perspective === "a" ? s.usPoints : s.themPoints,
      teamBPoints: perspective === "a" ? s.themPoints : s.usPoints,
    }));
}

/** The inverse: match-oriented sets as one side would type them. */
export function toPerspective(sets: readonly SetScore[], perspective: Side): SubmittedSet[] {
  return [...sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => ({
      setNumber: s.setNumber,
      usPoints: perspective === "a" ? s.teamAPoints : s.teamBPoints,
      themPoints: perspective === "a" ? s.teamBPoints : s.teamAPoints,
    }));
}

/** Parse a stored payload back into match-oriented sets. */
export function storedSubmissionSets(payloadJson: string): SetScore[] {
  const stored = storedSubmissionSchema.parse(JSON.parse(payloadJson));
  return toMatchOrientation(stored.sets, stored.perspective);
}

export interface CanonicalSubmission {
  /** Match-oriented, ordered sets. */
  sets: SetScore[];
  /** The canonical scoreline (team A first) the hash is taken over. */
  scoreline: Scoreline;
  hash: string;
  /** Legality verdict; the caller refuses anything not legal. */
  verdict: MatchVerdict;
}

/**
 * Canonicalize a submission from the submitter's side to the match
 * orientation, judge it, and hash it (spec §10.1, §10.4). Both honest views of
 * one result — each team typing its own points first — produce the same hash.
 */
export function canonicalizeSubmission(matchId: string, sets: readonly SubmittedSet[], perspective: Side, bestOf: BestOf): CanonicalSubmission {
  const oriented = toMatchOrientation(sets, perspective);
  const scoreline: Scoreline = { matchId, sets: oriented };
  return { sets: oriented, scoreline, hash: hashScoreline(scoreline, "a"), verdict: judgeMatch(oriented, bestOf) };
}

/**
 * Reject an illegal scoreline with a message naming the offending set
 * (spec §10.4). Beach volleyball gives real constraints — sets to 21, a
 * deciding third set to 15, win by two, best-of-1 or best-of-3 — so no absurd
 * integer ever reaches the settlement layer.
 */
export function assertLegalScoreline(canonical: CanonicalSubmission, bestOf: BestOf): asserts canonical is CanonicalSubmission & { verdict: { legal: true } } {
  if (canonical.verdict.legal) return;
  const offending = canonical.sets.find((s) => !judgeSet(s.teamAPoints, s.teamBPoints, setTarget(s.setNumber, bestOf)).legal);
  throw new ConsensusError("illegal_scoreline", canonical.verdict.reason, {
    code: "illegal_scoreline",
    setNumber: offending?.setNumber ?? null,
    bestOf,
  });
}

// ---------------------------------------------------------------------------
// Deciding the next state
// ---------------------------------------------------------------------------

export interface LiveSubmission {
  teamId: string;
  hash: string;
}

export type SubmissionDecision =
  | { next: "awaiting_second"; replaced: boolean }
  | { next: "agreed" }
  | { next: "disputed"; reason: string };

/**
 * Given the standing (non-superseded) submission from the *other* team, if
 * any, decide where a new submission takes the consensus. The team ids are
 * compared, never the users: two submissions from one team can never satisfy
 * both sides (spec §10.2), they only replace each other.
 */
export function judgeSubmission(input: {
  state: ConsensusState;
  submission: LiveSubmission;
  /** The other team's live submission; null when only this team has submitted (or nobody has). */
  standing: LiveSubmission | null;
  /** Whether this team already had a live submission that this one replaces. */
  replaces: boolean;
  /** For the dispute reason. */
  describeDifference: () => string;
}): SubmissionDecision {
  if (!OPEN_CONSENSUS_STATES.has(input.state)) {
    throw new ConsensusError("invalid_transition", `No submission is accepted while the consensus is ${input.state}.`, { code: "invalid_transition", state: input.state });
  }
  if (input.standing === null) return { next: "awaiting_second", replaced: input.replaces };
  if (input.standing.teamId === input.submission.teamId) {
    // Defensive: a caller that passed the same team as "standing" has mis-read the rows.
    throw new ConsensusError("invalid_transition", "The standing submission is from the same team; both sides must come from different teams.", { code: "invalid_transition" });
  }
  if (input.standing.hash === input.submission.hash) return { next: "agreed" };
  return { next: "disputed", reason: input.describeDifference() };
}

// ---------------------------------------------------------------------------
// Differences between two scorelines
// ---------------------------------------------------------------------------

export interface SetDifference {
  setNumber: number;
  /** Match-oriented; null when that side did not report the set at all. */
  a: SetScore | null;
  b: SetScore | null;
}

/** The sets on which two match-oriented scorelines disagree, in set order. */
export function diffScorelines(x: readonly SetScore[], y: readonly SetScore[]): SetDifference[] {
  const numbers = [...new Set([...x, ...y].map((s) => s.setNumber))].sort((p, q) => p - q);
  const out: SetDifference[] = [];
  for (const n of numbers) {
    const a = x.find((s) => s.setNumber === n) ?? null;
    const b = y.find((s) => s.setNumber === n) ?? null;
    if (a && b && a.teamAPoints === b.teamAPoints && a.teamBPoints === b.teamBPoints) continue;
    out.push({ setNumber: n, a, b });
  }
  return out;
}

/** Neutral, factual wording for `match_consensus.disputed_reason`: what differs, never who is wrong. */
export function describeDifferences(differences: readonly SetDifference[]): string {
  if (differences.length === 0) return "The scorelines differ.";
  const fmt = (s: SetScore | null) => (s ? `${s.teamAPoints}–${s.teamBPoints}` : "not reported");
  return differences.map((d) => `Set ${d.setNumber} differs: ${fmt(d.a)} vs ${fmt(d.b)}`).join("; ");
}

/** "21–18, 19–21, 15–12" from team A's side, for audit detail and copy. */
export function formatScoreline(sets: readonly SetScore[]): string {
  return formatSets(sets);
}

// ---------------------------------------------------------------------------
// Entering `agreed`
// ---------------------------------------------------------------------------

/**
 * The idempotency key is minted exactly once, the first time the consensus
 * reaches `agreed`, and every later Lucra attempt reuses it (spec §10.3).
 * Given an existing key this returns it untouched and never calls `mint`.
 */
export function idempotencyKeyFor(existing: string | null, mint: () => string): string {
  return existing ?? mint();
}

/** What a consensus needs to have been entered as `agreed`. */
export interface AgreedOutcome {
  winner: Side;
  winnerTeamId: string;
  sets: SetScore[];
  scoreline: Scoreline;
  hash: string;
}

export function agreedOutcome(match: { id: string; teamAId: string | null; teamBId: string | null; bestOf: BestOf }, sets: readonly SetScore[]): AgreedOutcome {
  const verdict = judgeMatch(sets, match.bestOf);
  if (!verdict.legal) throw new ConsensusError("illegal_scoreline", verdict.reason, { code: "illegal_scoreline" });
  const winnerTeamId = verdict.winner === "a" ? match.teamAId : match.teamBId;
  if (!winnerTeamId) throw new ConsensusError("invalid_transition", `Match ${match.id} does not have both teams; nothing can be agreed.`, { code: "invalid_transition" });
  const ordered = [...sets].sort((x, y) => x.setNumber - y.setNumber).map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints }));
  const scoreline: Scoreline = { matchId: match.id, sets: ordered };
  return { winner: verdict.winner, winnerTeamId, sets: ordered, scoreline, hash: hashScoreline(scoreline, "a") };
}

// ---------------------------------------------------------------------------
// The Lucra gate
// ---------------------------------------------------------------------------

export class LucraWriteRefused extends Error {
  constructor(
    readonly code: "not_agreed" | "missing_idempotency_key",
    message: string,
  ) {
    super(message);
    this.name = "LucraWriteRefused";
  }
}

export type LucraWritableConsensus = Pick<MatchConsensus, "matchId" | "state" | "idempotencyKey"> & {
  state: "agreed" | "rejected" | "partial";
  idempotencyKey: string;
};

/**
 * Only `agreed` may trigger a Lucra write (spec §10.5), asserted in code, not
 * by convention: phase 4 calls this before building any request. A retry after
 * `rejected` or `partial` is the same write with the same key, so those pass
 * too; nothing else does, and a consensus without its minted key never does.
 */
export function assertMayWriteToLucra(consensus: Pick<MatchConsensus, "matchId" | "state" | "idempotencyKey">): asserts consensus is LucraWritableConsensus {
  if (!LUCRA_WRITABLE_STATES.has(consensus.state)) {
    throw new LucraWriteRefused("not_agreed", `Match ${consensus.matchId} consensus is ${consensus.state}; only an agreed scoreline is written to Lucra.`);
  }
  if (!consensus.idempotencyKey) {
    throw new LucraWriteRefused("missing_idempotency_key", `Match ${consensus.matchId} consensus has no idempotency key; it was never entered as agreed.`);
  }
}

// ---------------------------------------------------------------------------
// Audit vocabulary shared by the service and the seed
// ---------------------------------------------------------------------------

export const CONSENSUS_AUDIT = {
  /** A team's scoreline was recorded (subject: match). */
  scoreSubmitted: "score.submitted",
  /** An earlier row from the same team was superseded (subject: match). */
  scoreSuperseded: "score.superseded",
  /** The consensus moved (subject: consensus; detail carries from/to/event). */
  stateChanged: "consensus.state_changed",
} as const;
