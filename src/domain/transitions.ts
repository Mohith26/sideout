import type { ActorKind, MatchStatus, TournamentStatus } from "@/db/schema";

/**
 * The two status state machines, validated in one place (spec §6.2, §10.6).
 * Every edge names who may take it. Services call these before writing and
 * write `audit_log` on success; nothing else changes a status column.
 *
 * Tournament:
 *
 *   draft → registration_open → registration_closed → live → awaiting_settlement → settled
 *   draft | registration_open | registration_closed → cancelled
 *
 * The draw is allowed only in `registration_closed`; a re-draw only while no
 * match has started. `live → awaiting_settlement` is the close flow
 * (`@/server/close`, an organizer confirming a frozen preview after its
 * blocking checks); `awaiting_settlement → settled` is the settlement outcome
 * (`@/server/lucra`, or Lucra's `TournamentCompleted` webhook). The status
 * PATCH route never takes those edges directly.
 *
 * Match:
 *
 *   scheduled → in_progress → awaiting_scores → final | disputed → final
 *   scheduled | in_progress | awaiting_scores | disputed → forfeited
 *   scheduled → bye
 *
 * `final` is set only by the consensus state machine (`@/server/consensus`,
 * actor `system`), never directly by a route. `forfeited` is an organizer
 * action. `bye` is systemic.
 */

export interface TransitionActor {
  kind: ActorKind;
  userId: string | null;
}

export type TransitionVerdict = { ok: true } | { ok: false; reason: string };

interface Edge<S extends string> {
  from: S;
  to: S;
  actors: readonly ActorKind[];
}

const ORGANIZER: readonly ActorKind[] = ["organizer"];
/** Settlement outcomes may also arrive as Lucra's `TournamentCompleted` webhook (phase 4). */
const SETTLEMENT: readonly ActorKind[] = ["organizer", "system", "lucra_webhook"];
const PLAY: readonly ActorKind[] = ["player", "organizer", "system"];
const CONSENSUS: readonly ActorKind[] = ["system"];

export const TOURNAMENT_TRANSITIONS: readonly Edge<TournamentStatus>[] = [
  { from: "draft", to: "registration_open", actors: ORGANIZER },
  { from: "registration_open", to: "registration_closed", actors: ORGANIZER },
  { from: "registration_closed", to: "live", actors: ORGANIZER },
  { from: "live", to: "awaiting_settlement", actors: SETTLEMENT },
  { from: "awaiting_settlement", to: "settled", actors: SETTLEMENT },
  { from: "draft", to: "cancelled", actors: ORGANIZER },
  { from: "registration_open", to: "cancelled", actors: ORGANIZER },
  { from: "registration_closed", to: "cancelled", actors: ORGANIZER },
];

export const MATCH_TRANSITIONS: readonly Edge<MatchStatus>[] = [
  { from: "scheduled", to: "in_progress", actors: PLAY },
  { from: "in_progress", to: "awaiting_scores", actors: PLAY },
  { from: "awaiting_scores", to: "disputed", actors: CONSENSUS },
  { from: "awaiting_scores", to: "final", actors: CONSENSUS },
  { from: "disputed", to: "final", actors: CONSENSUS },
  { from: "scheduled", to: "forfeited", actors: ORGANIZER },
  { from: "in_progress", to: "forfeited", actors: ORGANIZER },
  { from: "awaiting_scores", to: "forfeited", actors: ORGANIZER },
  { from: "disputed", to: "forfeited", actors: ORGANIZER },
  { from: "scheduled", to: "bye", actors: ["system"] },
];

/** Statuses a tournament can still be drawn in. */
export const DRAWABLE_STATUSES: ReadonlySet<TournamentStatus> = new Set(["registration_closed"]);
/** Terminal match statuses. */
export const TERMINAL_MATCH_STATUSES: ReadonlySet<MatchStatus> = new Set(["final", "forfeited", "bye"]);

function judge<S extends string>(edges: readonly Edge<S>[], subject: string, from: S, to: S, actor: TransitionActor): TransitionVerdict {
  if (from === to) return { ok: false, reason: `The ${subject} is already ${to}.` };
  const edge = edges.find((e) => e.from === from && e.to === to);
  if (!edge) return { ok: false, reason: `A ${subject} cannot go from ${from} to ${to}.` };
  if (!edge.actors.includes(actor.kind)) {
    return { ok: false, reason: `Only ${edge.actors.join(" or ")} can move a ${subject} from ${from} to ${to}; actor is ${actor.kind}.` };
  }
  return { ok: true };
}

export function transitionTournament(from: TournamentStatus, to: TournamentStatus, actor: TransitionActor): TransitionVerdict {
  return judge(TOURNAMENT_TRANSITIONS, "tournament", from, to, actor);
}

export function transitionMatch(from: MatchStatus, to: MatchStatus, actor: TransitionActor): TransitionVerdict {
  return judge(MATCH_TRANSITIONS, "match", from, to, actor);
}

/**
 * Every status `actor` may move a tournament to from `from`, in machine order. The
 * console renders these filtered to what `PATCH` takes (`isPatchableTarget` in
 * `@/server/tournaments`); closing is a link to the close flow, settling is phase 4.
 */
export function allowedTournamentTargets(from: TournamentStatus, actor: Pick<TransitionActor, "kind">): TournamentStatus[] {
  return TOURNAMENT_TRANSITIONS.filter((e) => e.from === from && e.actors.includes(actor.kind)).map((e) => e.to);
}
